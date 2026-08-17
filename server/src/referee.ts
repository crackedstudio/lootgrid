import { ASYNC, CRACK, ENERGY, NET, PUZZLE_HUNT_XP, RACE, TUTORIAL } from './config';
import * as admission from './admission';
import * as escrow from './chain/escrow';
import * as director from './director';
import type { Directive } from './director/types';
import * as energy from './energy';
import { moduleFor } from './games';
import { isCorrect } from './games/crack';
import type { AnyGameModule, Timing } from './games/types';
import { hashInt, randomHex } from './hash';
import * as hints from './hints';
import { logger } from './logger';
import * as rooms from './rooms';
import * as store from './store';
import { TimerWheel } from './timerWheel';
import type { Attempt, Hunt, Player } from './types';

export interface InputEvent {
  seq: number;
  kind: string;
  /** ms since the client's own attempt start (monotonic, from performance.now()). */
  t: number;
}

const wheel = new TimerWheel();
const dirtyHunts = new Set<string>();
/** huntId → attemptIds that completed inside the settlement window */
const finishers = new Map<string, string[]>();
const resolveTimers = new Map<string, NodeJS.Timeout>();

export type AttemptOutcome = 'won' | 'lost' | 'failed' | 'abandoned';

/**
 * Hooks for metrics and on-chain publication; wired in index.ts so this module
 * stays dependency-light. Implementations must not throw and must not block —
 * they run inline on the race's critical path.
 */
export const observers: {
  onAttemptOpened?: (a: Attempt, hunt: Hunt) => void;
  onAttemptFinished?: (a: Attempt, outcome: AttemptOutcome) => void;
  onHuntResolved?: (hunt: Hunt, winner: Attempt, racers: number) => void;
} = {};

// ---------------------------------------------------------------- attempts

export type OpenResult =
  | { ok: true; attempt: Attempt; spec: unknown; limitMs: number; gameType: string }
  /** `detail` carries what the player needs to fix a refusal they can fix. */
  | { ok: false; error: string; detail?: Record<string, unknown> };

/**
 * Resume attempts that survived a restart.
 *
 * Called once at boot, after the store has rehydrated them. All this has to do
 * is put their deadlines back in the wheel — the deadline is an absolute
 * timestamp, so one that passed while the server was down fires on the very
 * next sweep rather than needing separate handling.
 */
export function resume(attempts: Attempt[]): void {
  for (const attempt of attempts) wheel.push(attempt.id, attempt.deadlineAt);
  if (attempts.length > 0) {
    logger.info({ resumed: attempts.length }, 'resumed in-flight attempts');
  }
}

export function openAttempt(player: Player, hunt: Hunt, now = Date.now()): OpenResult {
  if (hunt.status !== 'live') return { ok: false, error: 'hunt_not_live' };

  // The money gate. Keys, rank, wallet age and the shadow ban, asked in one
  // place — see admission.ts for why they live together rather than being
  // checked at whichever route happened to need them.
  //
  // Here rather than in the HTTP handler on purpose: every entry path reaches
  // this function, including the agent driver, so a gate placed here cannot be
  // walked around by a caller that did not know about it.
  const admitted = admission.mayEnter(player, hunt, store.getZone(hunt.zoneId)?.kind ?? 'human', now);
  if (!admitted.ok) {
    // A shadow ban keeps its old disguise: it must stay indistinguishable from
    // the block having just closed. Every other refusal says what it is,
    // because a player who cannot see why they were turned away assumes the
    // game is rigged.
    if (admitted.code === 'shadow_banned') return { ok: false, error: 'hunt_not_live' };
    return { ok: false, error: admitted.code!, detail: admitted.detail };
  }

  if (store.attemptOf(hunt.id, player.id)) return { ok: false, error: 'already_attempted' };

  const cost = hunt.kind === 'cash' ? ENERGY.costCashHunt : ENERGY.costPuzzleHunt;
  const spent = energy.spend(player, cost, now, hunt.kind === 'cash' ? 'cash_hunt' : 'puzzle_hunt');
  if (!spent.ok) return { ok: false, error: 'insufficient_energy' };
  store.savePlayerEnergy(player);

  const game = store.blockGame(hunt);
  const mod = moduleFor(game.type);

  const attempt: Attempt = {
    id: `at_${randomHex(8)}`,
    huntId: hunt.id,
    playerId: player.id,
    handle: player.handle,
    gameType: game.type,
    // Stamped when the spec goes out, so elapsed time is measured from the same
    // instant for everyone. Scoring on absolute arrival would hand the prize to
    // whoever has the best connection.
    startedAt: now,
    deadlineAt: now + game.limitMs + RACE.latencyGraceMs,
    status: 'active',
    lastSeq: 0,
    state: mod.init(game.spec),
    elapsedMs: null,
    hintsUsed: null,
    failReason: null,
    progress: 0,
    intervals: [],
    events: [],
    maxClockSkewMs: 0,
  };

  try {
    store.addAttempt(attempt);
  } catch {
    // Lost the UNIQUE (hunt_id, player_id) race against a concurrent request.
    energy.refund(player, cost, now);
    store.savePlayerEnergy(player);
    return { ok: false, error: 'already_attempted' };
  }

  wheel.push(attempt.id, attempt.deadlineAt);
  // After the UNIQUE constraint has settled, so a lost race never publishes an
  // entry that did not happen.
  observers.onAttemptOpened?.(attempt, hunt);
  rooms.toPlayer(player.id, { t: 'energy', ...spent.energy });
  broadcastChasers(hunt.id);

  return {
    ok: true,
    attempt,
    spec: mod.publicSpec(game.spec, game.secret),
    limitMs: game.limitMs,
    gameType: game.type,
  };
}

export function submitInputs(attemptId: string, events: InputEvent[], now = Date.now()): void {
  const attempt = store.getAttempt(attemptId);
  if (!attempt || attempt.status !== 'active') return;

  const hunt = store.getHunt(attempt.huntId);
  if (!hunt) return;
  const game = store.blockGame(hunt);
  const mod = moduleFor(game.type);

  const serverElapsed = now - attempt.startedAt;

  for (const ev of events) {
    // Duplicates are idempotent; a gap means input was lost, which is
    // indistinguishable from a doctored stream.
    if (ev.seq <= attempt.lastSeq) continue;
    if (ev.seq !== attempt.lastSeq + 1) return fail(attempt, 'seq_gap');

    const prev = attempt.events[attempt.events.length - 1];
    // Intervals come from client timestamps: batching collapses server arrival
    // times, so server-side resolution between two taps in one frame is zero.
    // A bot can forge plausible jitter here — the bounds below are what it
    // cannot forge.
    const sinceLast = prev ? ev.t - prev.tClient : null;

    if (sinceLast !== null && sinceLast < 0) return fail(attempt, 'client_time_went_backwards');
    if (ev.t > serverElapsed + RACE.latencyGraceMs) return fail(attempt, 'client_ahead_of_server');

    attempt.maxClockSkewMs = Math.max(attempt.maxClockSkewMs, Math.abs(serverElapsed - ev.t));

    const timing: Timing = { sinceStart: serverElapsed, sinceLast, intervals: attempt.intervals };
    const result = mod.step(
      {
        spec: game.spec,
        secret: game.secret,
        state: attempt.state,
        timing,
        directive: directiveFor(mod, game.spec, hunt, attempt, now),
      },
      { kind: ev.kind, value: (ev as { value?: unknown }).value },
    );

    attempt.lastSeq = ev.seq;
    attempt.events.push({ seq: ev.seq, kind: ev.kind, tClient: ev.t, tServer: now });
    if (sinceLast !== null) attempt.intervals.push(sinceLast);

    if (result.kind === 'reject') {
      if (result.fatal) return fail(attempt, result.reason);
      continue;
    }

    attempt.progress = mod.progress(attempt.state, game.spec);
    dirtyHunts.add(attempt.huntId);

    // How a sequential game issues its next challenge — Math Dash sends
    // question N+1 only once N is answered correctly. To this player only.
    if (result.emit !== undefined) {
      rooms.toPlayer(attempt.playerId, {
        t: 'game:update',
        attemptId: attempt.id,
        data: result.emit,
      });
    }

    if (result.kind === 'complete') return complete(attempt, serverElapsed);
  }

  // Snapshot after the batch, not per event: an agent's inputs arrive minutes
  // apart, so this is orders of magnitude rarer than one human attempt's taps —
  // and a reflex module never reaches it at all.
  if (mod.durable) store.saveAttemptState(attempt);
}

/**
 * The directive for the round this input may serve.
 *
 * Synchronous by construction — `director.directiveFor` cannot await, so there
 * is no path on which a slow model delays somebody's answer. Past the budget the
 * deterministic fallback supplies the round and the pipeline catches up later.
 *
 * The blind state is built here rather than anywhere nearer the Director,
 * because here is where the identities are: `blind` takes progress values
 * already separated from their owners, so this function is the last place an
 * attempt object exists and the first place it cannot be passed on.
 */
function directiveFor(
  mod: AnyGameModule,
  spec: unknown,
  hunt: Hunt,
  attempt: Attempt,
  now: number,
): Directive | null {
  if (!mod.directedRound) return null;

  const round = mod.directedRound(attempt.state, spec);
  // No round left to shape. Asking anyway would put a directive nobody played
  // into a transcript whose only purpose is to be checked afterwards.
  if (round === null) return null;

  // Everyone still in the race, including whoever has already won it — a racer
  // dropping out must not change the round the others are handed.
  const progress = store
    .attemptsFor(hunt.id)
    .filter(a => a.status === 'active' || a.status === 'won')
    .map(a => a.progress);

  const state = director.stateFrom(round, progress, Math.max(0, now - hunt.createdAt));
  return director.directiveFor(hunt.id, round, state, now);
}

function complete(attempt: Attempt, serverElapsed: number): void {
  attempt.elapsedMs = serverElapsed;
  attempt.progress = 100;
  wheel.cancel(attempt.id);

  const hunt = store.getHunt(attempt.huntId);
  if (!hunt) return;

  // Snapshot the information the player had when they committed.
  //
  // At the decision, not at resolution: hints can arrive in the fifteen seconds
  // between locking and the reveal, and recomputing later could cost someone a
  // tiebreak for a hint that reached them after they had already answered.
  attempt.hintsUsed = hints.countForHunt(attempt.playerId, hunt.id);

  if (!finishers.has(hunt.id)) finishers.set(hunt.id, []);
  finishers.get(hunt.id)!.push(attempt.id);

  rooms.toPlayer(attempt.playerId, {
    t: 'attempt:complete',
    attemptId: attempt.id,
    elapsedMs: serverElapsed,
  });

  // First completion opens the window; everyone landing inside it competes on
  // elapsed time rather than on packet order.
  if (hunt.status === 'live') {
    store.setHuntStatus(hunt, 'resolving');
    resolveTimers.set(
      hunt.id,
      setTimeout(() => {
        try {
          resolve(hunt.id);
        } catch (err) {
          logger.error({ err, huntId: hunt.id }, 'resolve failed');
        }
      }, settlementWindowFor(hunt)),
    );
  }
}

/**
 * How long a result stays open for later finishers, by who plays the zone.
 *
 * On a human zone everyone racing a block started within a second of each
 * other, so 400ms of hold covers network jitter and nothing else.
 *
 * On an agent zone the starts are spread over hours, and attempts are scored on
 * their own elapsed time. An agent that begins an hour later and solves in half
 * the time has genuinely won — with a 400ms window the prize would go to
 * whoever merely *started* first, which is not a race, it is a queue. So the
 * window is minutes there, and the hunt sits in `resolving` for that long
 * before the grid replenishes. That is a real cost, paid for fairness.
 */
function settlementWindowFor(hunt: Hunt): number {
  // The Crack does not score on time, so the window is not about jitter — it is
  // about giving everyone who was already thinking their full fifteen seconds.
  // Anyone who started before the first lock finishes inside the game's own
  // limit, so that is exactly how long the result stays open. A 400ms window
  // would silently reintroduce the thing this game exists to remove: it would
  // hand the prize to whoever answered first rather than whoever answered best.
  if (store.blockGame(hunt).type === 'crack') return CRACK.limitMs + RACE.latencyGraceMs;

  const kind = store.getZone(hunt.zoneId)?.kind ?? 'human';
  return ASYNC.settlementWindowMs[kind];
}

/**
 * Rank completed attempts, best first.
 *
 * ─────────────────────────── two different questions ────────────────────────
 *
 * Every other game asks "who did it fastest", and elapsed time is the answer.
 * The Crack asks "who worked it out", and time is not merely irrelevant there —
 * including it would undo the whole point, because elapsed time is a proxy for
 * hardware and connection quality.
 *
 * So a crack hunt ranks on correctness, then on fewer hints used, then on a
 * deterministic hash. `startedAt` is deliberately absent from that chain even
 * as a tiebreak: arrival order is who loaded the page first, which is exactly
 * the "I lost because my phone is slow" complaint wearing a different hat.
 */
function rankFinishers(hunt: Hunt, done: Attempt[]): Attempt[] {
  const game = store.blockGame(hunt);

  if (game.type !== 'crack') {
    return [...done].sort((a, b) => {
      if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs! - b.elapsedMs!;
      if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
      // Deterministic, never random — the same inputs must always produce the
      // same winner, or a result cannot be audited.
      return hashInt(hunt.id, a.playerId) - hashInt(hunt.id, b.playerId);
    });
  }

  // Wrong doors do not place at all. They are not slower answers, they are
  // answers to a question that had one right response.
  const correct = done.filter(a => isCorrect(a.state, game.secret));

  return correct.sort((a, b) => {
    const ha = a.hintsUsed ?? 0;
    const hb = b.hintsUsed ?? 0;
    // Fewer hints wins: the player who got there on less bought information
    // beats the one who bought their way to the same answer.
    if (ha !== hb) return ha - hb;
    return hashInt(hunt.id, a.playerId) - hashInt(hunt.id, b.playerId);
  });
}

function resolve(huntId: string, now = Date.now()): void {
  const hunt = store.getHunt(huntId);
  if (!hunt || hunt.status === 'resolved') return;

  resolveTimers.delete(huntId);
  const ids = finishers.get(huntId) ?? [];
  const done = ids
    .map(id => store.getAttempt(id))
    .filter((a): a is Attempt => !!a && a.status === 'active' && a.elapsedMs !== null);

  if (done.length === 0) {
    store.setHuntStatus(hunt, 'live');
    finishers.delete(huntId);
    return;
  }

  const ranked = rankFinishers(hunt, done);

  if (ranked.length === 0) {
    // Everyone picked a wrong door.
    //
    // The treasure goes back on the board. A funded prize must not be destroyed
    // by a wrong guess — the money is escrowed for whoever actually finds it,
    // and burning it because the first people to try were wrong would be the
    // house keeping a pot nobody won.
    //
    // The players who tried do not get another go: UNIQUE (hunt_id, player_id)
    // still holds, and one shot per block is what stops a prize going to
    // whoever could afford the most attempts.
    for (const a of store.attemptsFor(huntId)) {
      if (a.status !== 'active') continue;
      a.status = 'lost';
      wheel.cancel(a.id);
      rooms.toPlayer(a.playerId, { t: 'attempt:lost', attemptId: a.id, winner: null });
      store.finishAttempt(a, now);
      observers.onAttemptFinished?.(a, 'lost');
    }

    store.setHuntStatus(hunt, 'live');
    finishers.delete(huntId);
    rooms.broadcast(rooms.huntRoom(huntId), { t: 'hunt:reopened', huntId });
    logger.info({ huntId, tried: done.length }, 'nobody cracked it — hunt reopened');
    return;
  }

  const winner = ranked[0]!;
  const racers = store.attemptsFor(huntId).length;

  for (const a of store.attemptsFor(huntId)) {
    if (a.status !== 'active') continue;
    if (a.id === winner.id) {
      a.status = 'won';
    } else {
      a.status = 'lost';
      wheel.cancel(a.id);
      rooms.toPlayer(a.playerId, { t: 'attempt:lost', attemptId: a.id, winner: winner.handle });
    }
    store.finishAttempt(a, now);
    observers.onAttemptFinished?.(a, a.status as AttemptOutcome);
  }

  store.setHuntStatus(hunt, 'resolved', winner.playerId, now);
  finishers.delete(huntId);

  // A puzzle hunt pays XP, because it carries no pot to pay from. Most
  // treasures are these — see CASH_PER_ZONE — so without this, winning the
  // overwhelming majority of what is on the map rewarded nothing at all.
  if (hunt.kind === 'puzzle') {
    const player = store.getPlayer(winner.playerId);
    if (player) {
      // A placed first treasure pays more, and pays in energy as well as XP.
      //
      // Energy because the moment after a first win is exactly when a new
      // player wants to keep going and the four-hour bar is about to stop them.
      // Not cash: a prize handed to a brand-new ungated wallet is the sybil
      // hole phase 5 closed. See tutorial.ts.
      const placed = hunt.ownerId === winner.playerId;
      store.awardXp(player, placed ? TUTORIAL.reward.xp : PUZZLE_HUNT_XP);
      if (placed) {
        const view = energy.refund(player, TUTORIAL.reward.energy, now);
        store.savePlayerEnergy(player);
        rooms.toPlayer(player.id, { t: 'energy', ...view });
      }
    }
  }

  rooms.broadcast(rooms.huntRoom(huntId), {
    t: 'hunt:resolved',
    huntId,
    winner: winner.handle,
    elapsedMs: winner.elapsedMs,
    // Revealed on resolution — proves the block was where it was committed.
    reveal: { r: hunt.r, c: hunt.c, salt: hunt.salt },
  });

  rooms.broadcast(rooms.zoneRoom(hunt.zoneId), {
    t: 'hunt:closed',
    huntId,
    r: hunt.r,
    c: hunt.c,
    winner: winner.handle,
  });

  observers.onHuntResolved?.(hunt, winner, racers);

  store.evictHunt(huntId);
  // Keep the grid stocked — a treasure map with no treasure left is a dead app.
  store.replenish(hunt.zoneId);
  broadcastZoneHunts(hunt.zoneId);
}

function fail(attempt: Attempt, reason: string, now = Date.now()): void {
  attempt.status = 'failed';
  attempt.failReason = reason;
  attempt.elapsedMs = now - attempt.startedAt;
  wheel.cancel(attempt.id);
  dirtyHunts.add(attempt.huntId);

  store.finishAttempt(attempt, now);
  observers.onAttemptFinished?.(attempt, 'failed');

  rooms.toPlayer(attempt.playerId, { t: 'attempt:failed', attemptId: attempt.id, reason });
  broadcastChasers(attempt.huntId);
}

function expire(attemptId: string): void {
  const attempt = store.getAttempt(attemptId);
  if (!attempt || attempt.status !== 'active') return;
  fail(attempt, 'timeout');
}

/** Closes hunts nobody cracked, then restocks the zone. */
export function sweepExpiredHunts(now = Date.now()): number {
  const expiredHunts = store.expiredHunts(now);
  for (const h of expiredHunts) {
    const hunt = store.getHunt(h.id);
    if (!hunt || hunt.status !== 'live') continue;
    closeUncracked(hunt, now);
    store.replenish(hunt.zoneId, now);
  }
  if (expiredHunts.length > 0) logger.info({ n: expiredHunts.length }, 'expired hunts swept');
  return expiredHunts.length;
}

/**
 * Retire a hunt nobody won, and start its pot on the way home.
 *
 * The refund is queued rather than sent: `escrow.enqueueRefund` will not
 * dispatch before the pot's on-chain expiry, and the contract rejects a refund
 * of a pot that was claimed or never funded. So this is safe to call on every
 * hunt that closes without a winner, which is exactly what makes it correct to
 * call from both paths below.
 */
function closeUncracked(hunt: Hunt, now: number): void {
  store.setHuntStatus(hunt, 'expired', null, now);
  rooms.broadcast(rooms.zoneRoom(hunt.zoneId), {
    t: 'hunt:expired',
    huntId: hunt.id,
    r: hunt.r,
    c: hunt.c,
  });
  // Nobody cracked it, so the money in it belongs back in the treasury. Before
  // rotation existed this was a slow leak nobody had to think about; now that
  // maps close on a schedule it is the routine case.
  if (hunt.expiresAt !== null) escrow.enqueueRefund(hunt.id, hunt.expiresAt);
  store.evictHunt(hunt.id);
}

/**
 * Reprint the maps whose time is up.
 *
 * ─────────────────────────── what rotation is for ───────────────────────────
 *
 * A reveal is permanent within an epoch, so without this a zone is consumed
 * rather than played: every dig takes a tile out of the world and nothing puts
 * one back. Rotation is the only thing that makes a zone survivable — see
 * config's EPOCH block.
 *
 * Hunts in the outgoing epoch do not carry over. They are keyed by epoch, so a
 * survivor would sit on a map no player can reach; and because `replenish`
 * clamped their expiry to this moment, their pots are refundable the instant
 * they close. That clamp is what makes rotation safe to do on a timer rather
 * than something an operator has to supervise.
 */
export function sweepRotations(now = Date.now()): number {
  const due = store.zonesDueForRotation(now);

  for (const zone of due) {
    try {
      for (const h of store.rotateZone(zone, now)) {
        const hunt = store.getHunt(h.id);
        if (!hunt || hunt.status !== 'live') continue;
        closeUncracked(hunt, now);
      }

      // The zone object we hold still describes the epoch that just ended, so
      // re-read it — `replenish` must stock the new map, not the dead one.
      rooms.broadcast(rooms.zoneRoom(zone.id), { t: 'zone:rotated', zoneId: zone.id, epoch: zone.epoch + 1 });
      store.replenish(zone.id, now);
    } catch (err) {
      // One zone failing to rotate must not hold up the others, and it is
      // recoverable by nature: `rotates_at` is unchanged, so it comes due again
      // on the next sweep.
      logger.error({ err, zoneId: zone.id }, 'zone rotation failed — will retry next sweep');
    }
  }

  return due.length;
}

// ---------------------------------------------------------------- fan-out

function broadcastChasers(huntId: string): void {
  rooms.broadcast(rooms.huntRoom(huntId), {
    t: 'hunt:chasers',
    huntId,
    count: store.chaserCount(huntId),
  });
}

function broadcastZoneHunts(zoneId: string): void {
  const zone = store.getZone(zoneId);
  if (!zone) return;
  rooms.broadcast(rooms.zoneRoom(zoneId), {
    t: 'zone:hunts',
    hunts: store.liveHuntsIn(zone).map(h => ({
      id: h.id,
      r: h.r,
      c: h.c,
      kind: h.kind,
      prizeLabel: h.prizeLabel,
      status: h.status,
    })),
  });
}

/**
 * One message per room per tick carrying everyone, instead of one message per
 * player per input — otherwise fan-out is quadratic in players per block.
 */
function flushProgress(): void {
  for (const huntId of dirtyHunts) {
    const players = store
      .attemptsFor(huntId)
      .filter(a => a.status === 'active' || a.status === 'won')
      .map(a => ({ h: a.handle, pct: a.progress }));
    if (players.length > 0) {
      rooms.broadcast(rooms.huntRoom(huntId), { t: 'progress', huntId, players });
    }
  }
  dirtyHunts.clear();
}

let sweepTimer: NodeJS.Timeout | null = null;
let progressTimer: NodeJS.Timeout | null = null;
let expiryTimer: NodeJS.Timeout | null = null;

export function start(): void {
  sweepTimer = setInterval(() => {
    try {
      for (const id of wheel.drain(Date.now())) expire(id);
    } catch (err) {
      logger.error({ err }, 'deadline sweep failed');
    }
  }, NET.deadlineSweepMs);

  progressTimer = setInterval(() => {
    try {
      flushProgress();
    } catch (err) {
      logger.error({ err }, 'progress flush failed');
    }
  }, Math.round(1000 / NET.progressHz));

  expiryTimer = setInterval(() => {
    try {
      sweepExpiredHunts();
    } catch (err) {
      logger.error({ err }, 'hunt expiry sweep failed');
    }
    // Same tick rather than a timer of its own. Rotation is a three-day event
    // checked once a minute — it does not need its own cadence, and running it
    // after the expiry sweep means a hunt that expired on its own is already
    // closed by the time its map is torn up.
    try {
      sweepRotations();
    } catch (err) {
      logger.error({ err }, 'zone rotation sweep failed');
    }
  }, 60_000);
}

export function stop(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (progressTimer) clearInterval(progressTimer);
  if (expiryTimer) clearInterval(expiryTimer);
  for (const t of resolveTimers.values()) clearTimeout(t);
  resolveTimers.clear();
}

export const pendingDeadlines = () => wheel.size;
