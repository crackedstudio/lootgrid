import { ASYNC, cashPerZone, DISCOVERY, EPOCH, GRID, HUNTS_PER_ZONE } from './config';
import { migrate } from './db/migrate';
import { tx } from './db/index';
import * as attemptRepo from './db/repos/attempts';
import * as huntRepo from './db/repos/hunts';
import * as playerRepo from './db/repos/players';
import * as zoneRepo from './db/repos/zones';
import * as escrow from './chain/escrow';
import { gameTypeForBlock, moduleFor } from './games';
export { moduleFor };
import { cellKey } from './grid';
import * as director from './director';
import * as hints from './hints';
import { hash, randomHex } from './hash';
import { env } from './env';
import { logger } from './logger';
import { difficultyForBlock, prizeCentsFor, prizeLabelFor, toTokenUnits } from './prizes';
import type { Attempt, BlockGame, Hunt, HuntKind, Player, Reveal, Zone, ZoneKind } from './types';

/**
 * The seam between the referee and storage.
 *
 * Durable state (players, zones, hunts, reveals, finished attempts) lives in
 * SQLite. In-flight races live in memory, because an attempt lasts about six
 * seconds and hitting disk per tap would buy nothing — a crash mid-race is
 * meant to fail closed, and boot recovery does exactly that.
 */

/** huntId → playerId → attempt (with module runtime state). Evicted on resolve. */
const liveAttempts = new Map<string, Map<string, Attempt>>();
/** attemptId → attempt, for direct lookup on the input path. */
const attemptIndex = new Map<string, Attempt>();
/** Write-through cache; single process, so this is the only writer. */
const playerCache = new Map<string, Player>();
/**
 * Identity matters here, not just speed: the referee mutates a hunt's status and
 * memoises its generated game on the object, so every caller must see the same
 * instance rather than a fresh row mapping.
 */
const huntCache = new Map<string, Hunt>();

const ZONE_SEED: Array<Pick<Zone, 'id' | 'name' | 'accent' | 'kind'>> = [
  { id: 'ridge', name: 'EASTERN RIDGE', accent: '#FF7A1A', kind: 'human' },
  { id: 'flats', name: 'GOLDEN FLATS', accent: '#FFD51F', kind: 'human' },
  { id: 'tide', name: 'NEON TIDE', accent: '#29E6E6', kind: 'human' },
  { id: 'hollow', name: 'DEEP HOLLOW', accent: '#8A3DFF', kind: 'human' },
  // The first agent zone. It could not exist before phase 6 — with no agent
  // module registered it would have been a zone that cannot host a cash hunt,
  // which is a zone with nothing in it. One, not four: this is the zone that
  // answers whether there is a challenge worth an agent solving, and until it
  // has, the grid should not be mostly given over to it.
  { id: 'lattice', name: 'THE LATTICE', accent: '#B7FF3B', kind: 'agent' },
];

/** Per zone kind — agent hunts outlive human ones. See config's ASYNC block. */
const huntTtlFor = (kind: ZoneKind): number => ASYNC.huntTtlMs[kind];

/**
 * Attempts rehydrated by the last {@link bootstrap}.
 *
 * Handed to the referee by the entry point rather than pushed from here: the
 * referee imports this module, so calling back into it would be a cycle. Same
 * reason its observers are wired in `index.ts`.
 */
let recoveredAtBoot: Attempt[] = [];

export const takeRecovered = (): Attempt[] => {
  const out = recoveredAtBoot;
  recoveredAtBoot = [];
  return out;
};

export function bootstrap(): void {
  migrate();

  // Long attempts come back; short ones cannot. An agent game runs for minutes
  // and its player is owed the rest of it, while a six-second reflex attempt
  // spanning a restart is unresumable by nature — nobody is mid-tap across a
  // deploy, and the clock it was racing is long gone.
  const resumed = attemptRepo.recoverable();
  for (const a of resumed) {
    if (!liveAttempts.has(a.huntId)) liveAttempts.set(a.huntId, new Map());
    liveAttempts.get(a.huntId)!.set(a.playerId, a);
    attemptIndex.set(a.id, a);
  }
  recoveredAtBoot = resumed;

  const abandoned = attemptRepo.abandonActiveOnBoot();
  if (abandoned > 0) {
    // These belong to a process that no longer exists and can never complete.
    logger.warn({ abandoned }, 'abandoned in-flight attempts from a previous run');
  }

  if (zoneRepo.list().length === 0) {
    seedZones();
    logger.info({ zones: ZONE_SEED.length }, 'seeded fresh world');
  }

  for (const z of zoneRepo.list()) replenish(z.id);
}

function seedZones(now = Date.now()): void {
  ZONE_SEED.forEach((z, i) => {
    const seedSecret = randomHex(32);
    zoneRepo.insert(
      {
        ...z,
        epoch: 1,
        seedSecret,
        seedCommit: hash(seedSecret).toString('hex'),
        // Staggered across the rotation window rather than all landing on the
        // same tick. Four zones resetting together would empty the whole world
        // at once; spread out, there is always a map partway through its life.
        rotatesAt: now + Math.round((EPOCH.rotateMs * (i + 1)) / ZONE_SEED.length),
      },
      now,
    );
  });
}

/**
 * Turn a zone's map over.
 *
 * ─────────────────────────── order is the guarantee ─────────────────────────
 *
 * The outgoing secret is archived *first*. `zoneRepo.rotate` overwrites it, and
 * once overwritten there is nothing left to prove what last epoch's map was —
 * publishing it is the whole reason `zone_seed_history` exists. Archive then
 * rotate, in one transaction, so a crash between the two cannot silently cost a
 * player the ability to audit the map they just played.
 *
 * Live hunts do not survive. They are keyed by epoch, so leaving them alone
 * would strand them on a map nobody can reach — and their pots are refundable
 * precisely because `replenish` clamped their expiry to this moment.
 */
export function rotateZone(zone: Zone, now = Date.now()): Hunt[] {
  const stranded = huntRepo.listLive(zone.id, zone.epoch);
  const seedSecret = randomHex(32);

  tx(() => {
    zoneRepo.archiveSeed(zone, now);
    zoneRepo.rotate(
      zone.id,
      seedSecret,
      hash(seedSecret).toString('hex'),
      zone.rotatesAt === null ? null : now + EPOCH.rotateMs,
    );
  });

  logger.info(
    { zoneId: zone.id, epoch: zone.epoch + 1, stranded: stranded.length },
    'epoch rotated — map reprinted',
  );
  return stranded;
}

export const zonesDueForRotation = (now = Date.now()) => zoneRepo.dueForRotation(now);

// ---------------------------------------------------------------- players

export function getPlayer(id: string): Player | undefined {
  const cached = playerCache.get(id);
  if (cached) return cached;
  const row = playerRepo.get(id);
  if (row) playerCache.set(id, row);
  return row;
}

export function ensurePlayer(id: string, handle: string): Player {
  const existing = getPlayer(id);
  if (existing) return existing;
  const created = playerRepo.ensure(id, handle);
  playerCache.set(id, created);
  return created;
}

/** Energy is the economy: mutate the cached object, then write through at once. */
export function savePlayerEnergy(p: Player): void {
  playerCache.set(p.id, p);
  playerRepo.saveEnergy(p.id, p.energyValue, p.energyAt);
}

/**
 * Award XP. Incremented in SQL, then mirrored onto the cached player.
 *
 * Never throws. XP is a reward, not a settlement — a counter that fails to
 * advance must not cost someone the tile they already paid energy for.
 */
export function awardXp(p: Player, amount: number): void {
  if (amount <= 0) return;
  try {
    playerRepo.addXp(p.id, amount);
    p.xp += amount;
    playerCache.set(p.id, p);
  } catch (err) {
    logger.warn({ err, playerId: p.id, amount }, 'xp award failed — the action stands');
  }
}

/**
 * Move the walkthrough forward. Never backwards — see migration 020.
 *
 * Never throws, for the same reason `awardXp` does not: a coach mark that
 * fails to advance must not cost the player the dig they already paid for.
 */
export function setTutorialStep(p: Player, step: number): void {
  if (step <= p.tutorialStep) return;
  try {
    playerRepo.setTutorialStep(p.id, step);
    p.tutorialStep = step;
    playerCache.set(p.id, p);
  } catch (err) {
    logger.warn({ err, playerId: p.id, step }, 'tutorial advance failed — the action stands');
  }
}

/** The Cycle Pass expiry. Mirrored onto the cached player — energy reads it. */
/**
 * Record that a player was here today. See `playerRepo.seen`.
 *
 * Mirrors onto the cached object so the write can be skipped for the rest of
 * the day without a read — the primary key would reject it anyway, but not
 * asking is cheaper than being rejected on every request.
 */
export function markSeen(p: Player, now = Date.now()): void {
  const today = Math.floor(now / 86_400_000);
  if (p.lastSeenDay === today) return;
  playerRepo.seen(p.id, now);
  p.lastSeenDay = today;
  playerCache.set(p.id, p);
}

export function setPass(p: Player, until: number | null): void {
  p.passUntil = until;
  playerCache.set(p.id, p);
  playerRepo.setPass(p.id, until);
}

export function setPassToppedUp(p: Player, at: number): void {
  p.passToppedUpAt = at;
  playerCache.set(p.id, p);
  playerRepo.setToppedUp(p.id, at);
}

export function setSessionKey(p: Player, sessionKey: string | null): void {
  p.sessionKey = sessionKey;
  playerCache.set(p.id, p);
  playerRepo.setSessionKey(p.id, sessionKey);
}

// ---------------------------------------------------------------- zones

export const getZone = (id: string) => zoneRepo.get(id);
export const listZones = () => zoneRepo.list();
export const revealsFor = (z: Zone, playerId: string) =>
  zoneRepo.revealsFor(z.id, z.epoch, playerId);
export const getReveal = (z: Zone, playerId: string, r: number, c: number) =>
  zoneRepo.getReveal(z.id, z.epoch, playerId, r, c);
export const seedHistory = (zoneId: string) => zoneRepo.seedHistory(zoneId);

/** False means this player had already opened this cell. See the repo. */
export function addReveal(z: Zone, reveal: Reveal & { playerId: string }): boolean {
  return zoneRepo.addReveal(z.id, z.epoch, reveal);
}

// ---------------------------------------------------------------- hunts

export function getHunt(id: string): Hunt | undefined {
  const cached = huntCache.get(id);
  if (cached) return cached;
  const row = huntRepo.get(id);
  if (row) huntCache.set(id, row);
  return row;
}

export const huntAt = (z: Zone, r: number, c: number) => huntRepo.at(z.id, z.epoch, r, c);
/**
 * Every live treasure in a zone — the server's own view.
 *
 * Survey measures against treasures nobody has found, hints are generated for
 * them and `replenish` counts them, so all of that has to see the whole truth.
 * **This is never what a client gets.** Serving it was the bug migration 019
 * closes; {@link visibleHuntsIn} is the one the API uses.
 */
export const liveHuntsIn = (z: Zone) => huntRepo.listLive(z.id, z.epoch);

/** Every hunt in a status, across zones. For restart recovery — see referee.ts. */
export const listHuntsByStatus = (status: string) => huntRepo.listByStatus(status);
/** What one player may see: everything public, plus what they personally dug up. */
export const visibleHuntsIn = (z: Zone, playerId: string, now = Date.now()) =>
  huntRepo.listVisible(z.id, z.epoch, playerId, now);
/** Hunts reserved for one player. Never part of the shared map — see types.Hunt. */
export const ownedHuntsIn = (z: Zone, ownerId: string) =>
  huntRepo.listOwned(z.id, z.epoch, ownerId);
export const expiredHunts = (now?: number) => huntRepo.expired(now);

/**
 * Record that this player just dug up a treasure.
 *
 * Returns true the first time this player finds it. The first finder anywhere
 * also starts the head start — twenty minutes of knowing about it before the
 * zone is told — and later finders join without extending it, because a head
 * start that any new arrival could reset would never end.
 *
 * The window buys PREPARATION, not an exclusive attempt: entry stays open to
 * everyone once the hunt is public, and the Crack is a fifteen-second window, so
 * an exclusive head start of this length would resolve nearly every hunt before
 * the field heard of it. See config.DISCOVERY.
 */
export function discoverHunt(hunt: Hunt, playerId: string, now = Date.now()): boolean {
  const fresh = huntRepo.addDiscovery(hunt.id, playerId, now, now + DISCOVERY.headStartMs);
  if (fresh) {
    // Re-read rather than assuming: `bringPublicForward` only moves the moment
    // earlier, so a second finder's write may legitimately have changed nothing.
    huntCache.delete(hunt.id);
    const updated = huntRepo.get(hunt.id);
    if (updated) huntCache.set(hunt.id, updated);
  }
  return fresh;
}

export const hasDiscovered = (huntId: string, playerId: string) =>
  huntRepo.hasDiscovered(huntId, playerId);

/** True once a treasure's location has stopped being private to its finders. */
export const isHuntPublic = (hunt: Hunt, now = Date.now()) =>
  hunt.publicAt !== null && hunt.publicAt <= now;

export function setHuntStatus(
  hunt: Hunt,
  status: Hunt['status'],
  winnerId: string | null = null,
  now: number | null = null,
): void {
  hunt.status = status;
  hunt.winnerId = winnerId;
  huntRepo.setStatus(hunt.id, status, winnerId, now);

  // A hunt that can no longer be played has nothing left to protect, so its
  // hint set — truth flags included — becomes publicly checkable. This is the
  // same moment the salt is disclosed, and doing it here rather than at the two
  // call sites means no future terminal status can forget to open the books.
  if (status === 'resolved' || status === 'expired') {
    hints.revealForHunt(hunt.id, now ?? Date.now());
  }
}

/**
 * The block's game — generated once from the salt, persisted, and served
 * identically to everyone racing it.
 */
export function blockGame(hunt: Hunt): BlockGame {
  // Director sessions live in memory, so a hunt that outlived a restart has a
  // chain that was opened by a process which no longer exists. Reopening here —
  // idempotent, and on the one path every attempt already takes — is what stops
  // a surviving hunt falling back on an empty salt and a guessed difficulty,
  // which would silently be a different game from the one it started as.
  director.open({ huntId: hunt.id, salt: hunt.salt, difficulty: hunt.difficulty });

  if (hunt.game) return hunt.game;

  // The zone decides which module pool the block may draw from — reflex games
  // for human zones, agent-native ones for agent zones. A missing zone falls
  // back to 'human', the stricter branch.
  const zoneKind = getZone(hunt.zoneId)?.kind ?? 'human';
  // A reserved hunt is a walkthrough hunt, and it plays The Crack regardless of
  // its kind.
  //
  // It is a `puzzle` hunt, so the draw above would hand it one of the four
  // reflex games — and the walkthrough would spend its one guaranteed find
  // teaching a tapping race that decides nothing and that the player will never
  // meet again, while The Crack, which decides every cash hunt in the game, is
  // first seen by someone who has already spent two days earning the right to
  // enter one. Teaching the wrong resolution is worse than teaching none.
  const type =
    hunt.ownerId !== null ? 'crack' : gameTypeForBlock(hunt.salt, hunt.id, hunt.kind, zoneKind);
  const mod = moduleFor(type);
  // The cell goes in because The Crack's answer must BE the treasure — hints
  // describe its real position, so a door that is some other cell would make
  // every hint noise. Every other module ignores it.
  const { spec, secret, limitMs } = mod.generate(hunt.salt, hunt.difficulty, {
    cell: { r: hunt.r, c: hunt.c },
  });
  const game: BlockGame = { type, spec, secret, limitMs };

  hunt.game = game;
  huntRepo.saveGame(hunt.id, game);
  return game;
}

/**
 * Keeps a zone stocked. Called at boot and whenever a hunt closes, so the grid
 * never runs dry — a treasure map with no treasure left is a dead app.
 */
export function replenish(zoneId: string, now = Date.now()): number {
  const zone = zoneRepo.get(zoneId);
  if (!zone) return 0;

  let open = huntRepo.countOpen(zone.id, zone.epoch);
  let openCash = huntRepo.countOpenCash(zone.id, zone.epoch);
  let created = 0;
  let guard = 0;

  // No hunt outlives its epoch.
  //
  // This is not tidiness — it is what makes an abandoned pot recoverable. The
  // escrow's `refund` reverts with NotExpired until `block.timestamp` passes the
  // pot's `expiresAt`, so a hunt carrying a 24h TTL created an hour before
  // rotation would be stranded on a dead map with its money locked for another
  // 23 hours. Clamping here means the moment an epoch closes, every pot it left
  // behind is already refundable.
  const epochEnd = zone.rotatesAt;
  const expiryFor = (from: number): number => {
    const ttl = from + huntTtlFor(zone.kind);
    return epochEnd === null ? ttl : Math.min(ttl, epochEnd);
  };

  while (open < HUNTS_PER_ZONE && guard < 200) {
    guard += 1;
    const r = Math.floor(Math.random() * GRID.rows);
    const c = Math.floor(Math.random() * GRID.cols);

    // Don't stack two hunts on one cell. There is deliberately no check for an
    // already-uncovered cell any more: under private fog "uncovered" is a fact
    // about one player, not about the zone, and a hunt is a property of the
    // zone. Placing around whoever happened to dig there would leak their map
    // into the placement — and would get harder to satisfy the more they dug,
    // which is the shared-map problem wearing a different hat.
    //
    // The consequence is that a hunt can appear beneath a tile a player has
    // already opened. They find it on their next visit, which is a good moment
    // rather than a bug.
    if (huntRepo.at(zone.id, zone.epoch, r, c)) continue;

    const salt = randomHex(32);
    const id = `${zone.id}-${zone.epoch}-${cellKey(r, c).replace(',', 'x')}-${randomHex(3)}`;
    // Drawn from the salt, like the game type: fixed before anyone enters and
    // checkable once the salt is revealed. It decides the prize, the entry fee
    // and how hard the block's game generates — every module has carried easy
    // and hard tables since phase 0, and a hardcoded 'med' here was the reason
    // two thirds of them never ran.
    const difficulty = difficultyForBlock(salt, id, zone.kind);

    // Cash first, then fill the rest of the zone with XP hunts.
    //
    // The count, not the coin flip, is what bounds the burn: a zone holds
    // exactly cashPerZone(kind) funded hunts no matter how many treasures are on
    // it. `kind` has been on `Hunt` since phase 0 with the energy cost, the
    // module pool and the entry path all handling 'puzzle' — and `replenish`
    // hardcoded 'cash', so a puzzle hunt had never once existed.
    // Per zone KIND: only cash hunts draw agent-playable games, so an agent zone
    // needs several to stay continuously playable while a human zone does not.
    const kind: HuntKind = openCash < cashPerZone(zone.kind) ? 'cash' : 'puzzle';

    const hunt: Hunt = {
      id,
      zoneId: zone.id,
      epoch: zone.epoch,
      r,
      c,
      salt,
      cellCommit: hash(id, zone.id, r, c, salt).toString('hex'),
      kind,
      // The shared map. Reserved tutorial hunts are created by tutorial.ts.
      ownerId: null,
      difficulty,
      // Derived from difficulty rather than cycled through a fixed array, so a
      // prize now means something about the hunt. See prizes.ts. A puzzle hunt
      // pays in XP and says so — showing "$0.00" would read as a broken prize
      // rather than a different kind of reward.
      prizeLabel: kind === 'cash' ? prizeLabelFor(difficulty) : 'XP',
      status: 'live',
      winnerId: null,
      game: null,
      // Hidden until somebody digs it, and not forever: a treasure nobody finds
      // goes public at a quarter of its life so the zone never carries a funded
      // hunt that cannot be played. See migration 019.
      publicAt: now + DISCOVERY.publicAfterMs[zone.kind],
      expiresAt: expiryFor(now),
      createdAt: now,
    };
    // The hint set and its commitment are written in the same transaction as the
    // hunt, so a hunt can never become playable without a published commitment.
    // That ordering IS the guarantee — a commitment made after play has begun
    // proves nothing about what the house decided beforehand.
    tx(() => {
      huntRepo.insert(hunt);
      hints.commitAtCreation(hunt, now);
      // Start the directive chain from the same salt the cell commitment uses,
      // so the transcript's first link is computable by anyone who later holds
      // the revealed salt. Opening it here means no hunt can be played before
      // its chain exists.
      director.open({ huntId: hunt.id, salt: hunt.salt, difficulty: hunt.difficulty });
      // Queue the prize alongside the hunt, so a created hunt and its funding
      // intent are recorded together or not at all. The worker funds it out of
      // band — an unfunded hunt still plays, it just carries no money yet.
      //
      // Only cash hunts have anything to fund. A puzzle hunt with an escrow row
      // would be a pot nobody can win, waiting to be refunded — pure gas.
      if (hunt.kind === 'cash') {
        escrow.enqueue(
          hunt.id,
          toTokenUnits(prizeCentsFor(hunt.difficulty), env.ESCROW_TOKEN_DECIMALS),
          hunt.expiresAt ?? expiryFor(now),
        );
      }
    });

    open += 1;
    if (hunt.kind === 'cash') openCash += 1;
    created += 1;
  }

  if (created > 0) logger.info({ zoneId, created, open, cash: openCash }, 'zone replenished');
  return created;
}

// ---------------------------------------------------------------- attempts

/**
 * Persist an in-flight attempt's module state.
 *
 * Only durable modules reach this — see `GameModule.durable`. Swallows its own
 * errors: the attempt is already valid in memory and playing on, so a failed
 * snapshot costs resumability after a restart that may never happen, and
 * failing the input would cost the player their turn for certain.
 */
export function saveAttemptState(a: Attempt): void {
  try {
    attemptRepo.saveState(a);
  } catch (err) {
    logger.warn({ err, attemptId: a.id }, 'attempt state not saved — it will not survive a restart');
  }
}

export function addAttempt(a: Attempt): void {
  attemptRepo.insert(a); // UNIQUE (hunt_id, player_id) — one shot per block
  if (!liveAttempts.has(a.huntId)) liveAttempts.set(a.huntId, new Map());
  liveAttempts.get(a.huntId)!.set(a.playerId, a);
  attemptIndex.set(a.id, a);
}

export const getAttempt = (id: string) => attemptIndex.get(id);

export function attemptOf(huntId: string, playerId: string): Attempt | undefined {
  // Memory first for live races; fall back to disk so a player cannot re-enter
  // a block whose race has already been evicted.
  return liveAttempts.get(huntId)?.get(playerId) ?? attemptRepo.ofPlayer(huntId, playerId);
}

export function attemptsFor(huntId: string): Attempt[] {
  return [...(liveAttempts.get(huntId)?.values() ?? [])];
}

/** Persists the outcome and its input log. The log is the anti-cheat audit trail. */
export function finishAttempt(a: Attempt, now = Date.now()): void {
  attemptRepo.finish(a, now);
  attemptRepo.saveEvents(a.id, a.events);
}

/** Once a block is resolved nothing more can happen on it — free the memory. */
export function evictHunt(huntId: string): void {
  for (const a of attemptsFor(huntId)) attemptIndex.delete(a.id);
  liveAttempts.delete(huntId);
  huntCache.delete(huntId);
}

export function chaserCount(huntId: string): number {
  return attemptsFor(huntId).filter(a => a.status === 'active').length;
}

/**
 * Total entrants in a hunt — memory for a live race, disk once it is over.
 *
 * `attemptsFor` is live-only, so it reports 0 the moment `evictHunt` runs, which
 * is immediately on resolution. A win attestation is requested *after* that
 * point, so it has to read through to the table or it would sign `racers: 0`.
 */
export function racerCount(huntId: string): number {
  const live = liveAttempts.get(huntId);
  if (live) return live.size;
  return attemptRepo.forHunt(huntId).length;
}

export const liveAttemptCount = () => attemptIndex.size;

/** Test-only: drops every module-level cache so a fresh database starts clean. */
export function resetForTests(): void {
  liveAttempts.clear();
  attemptIndex.clear();
  playerCache.clear();
  huntCache.clear();
}

export function attemptHistory(playerId: string, limit = 50) {
  return attemptRepo.recentForPlayer(playerId, limit);
}

export const attemptEvents = (attemptId: string) => attemptRepo.eventsFor(attemptId);

/**
 * Whether this is the player's very first attempt at anything.
 *
 * Read after the insert, so the attempt itself is counted — exactly one means
 * this is the first. Asking before the insert would race two concurrent
 * entries into both believing they were first.
 */
export const isFirstAttempt = (a: Attempt): boolean => attemptRepo.countForPlayer(a.playerId) === 1;

/** Tiles this player dug before a given moment. The taps in taps-to-treasure. */
export const digsBefore = (playerId: string, before: number): number =>
  zoneRepo.countRevealsBefore(playerId, before);
