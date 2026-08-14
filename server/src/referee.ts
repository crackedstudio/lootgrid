import { ASYNC, ENERGY, NET, RACE } from './config';
import * as energy from './energy';
import { moduleFor } from './games';
import type { Timing } from './games/types';
import { hashInt, randomHex } from './hash';
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
  | { ok: false; error: string };

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

  // Shadow-banned accounts stop matching into cash hunts. Deliberately
  // indistinguishable from the block having just closed — telling a suspected
  // botter exactly when they were caught only helps them iterate.
  if (player.shadowBanned && hunt.kind === 'cash') return { ok: false, error: 'hunt_not_live' };

  if (store.attemptOf(hunt.id, player.id)) return { ok: false, error: 'already_attempted' };

  const cost = hunt.kind === 'cash' ? ENERGY.costCashHunt : ENERGY.costPuzzleHunt;
  const spent = energy.spend(player, cost, now);
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
      { spec: game.spec, secret: game.secret, state: attempt.state, timing },
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

function complete(attempt: Attempt, serverElapsed: number): void {
  attempt.elapsedMs = serverElapsed;
  attempt.progress = 100;
  wheel.cancel(attempt.id);

  const hunt = store.getHunt(attempt.huntId);
  if (!hunt) return;

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
  const kind = store.getZone(hunt.zoneId)?.kind ?? 'human';
  return ASYNC.settlementWindowMs[kind];
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

  done.sort((a, b) => {
    if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs! - b.elapsedMs!;
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    // Deterministic, never random — the same inputs must always produce the
    // same winner, or a result cannot be audited.
    return hashInt(huntId, a.playerId) - hashInt(huntId, b.playerId);
  });

  const winner = done[0]!;
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
    store.setHuntStatus(hunt, 'expired', null, now);
    rooms.broadcast(rooms.zoneRoom(hunt.zoneId), { t: 'hunt:expired', huntId: hunt.id, r: hunt.r, c: hunt.c });
    store.evictHunt(hunt.id);
    store.replenish(hunt.zoneId, now);
  }
  if (expiredHunts.length > 0) logger.info({ n: expiredHunts.length }, 'expired hunts swept');
  return expiredHunts.length;
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
