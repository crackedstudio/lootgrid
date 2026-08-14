import { ASYNC, GRID, HUNTS_PER_ZONE } from './config';
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
import type { Attempt, BlockGame, Hunt, Player, Reveal, Zone, ZoneKind } from './types';

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
  for (const z of ZONE_SEED) {
    const seedSecret = randomHex(32);
    zoneRepo.insert(
      { ...z, epoch: 1, seedSecret, seedCommit: hash(seedSecret).toString('hex') },
      null,
      now,
    );
  }
}

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

export function setSessionKey(p: Player, sessionKey: string | null): void {
  p.sessionKey = sessionKey;
  playerCache.set(p.id, p);
  playerRepo.setSessionKey(p.id, sessionKey);
}

// ---------------------------------------------------------------- zones

export const getZone = (id: string) => zoneRepo.get(id);
export const listZones = () => zoneRepo.list();
export const revealsFor = (z: Zone) => zoneRepo.revealsFor(z.id, z.epoch);
export const getReveal = (z: Zone, r: number, c: number) => zoneRepo.getReveal(z.id, z.epoch, r, c);
export const seedHistory = (zoneId: string) => zoneRepo.seedHistory(zoneId);

/** False means someone else opened this cell first; the caller refunds energy. */
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
export const liveHuntsIn = (z: Zone) => huntRepo.listLive(z.id, z.epoch);
export const expiredHunts = (now?: number) => huntRepo.expired(now);

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
  if (hunt.game) return hunt.game;

  // The zone decides which module pool the block may draw from — reflex games
  // for human zones, agent-native ones for agent zones. A missing zone falls
  // back to 'human', the stricter branch.
  const zoneKind = getZone(hunt.zoneId)?.kind ?? 'human';
  const type = gameTypeForBlock(hunt.salt, hunt.id, hunt.kind, zoneKind);
  const mod = moduleFor(type);
  const { spec, secret, limitMs } = mod.generate(hunt.salt, hunt.difficulty);
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
  let created = 0;
  let guard = 0;

  while (open < HUNTS_PER_ZONE && guard < 200) {
    guard += 1;
    const r = Math.floor(Math.random() * GRID.rows);
    const c = Math.floor(Math.random() * GRID.cols);

    // Don't stack a hunt on an occupied or already-uncovered cell.
    if (huntRepo.at(zone.id, zone.epoch, r, c)) continue;
    if (zoneRepo.getReveal(zone.id, zone.epoch, r, c)) continue;

    const salt = randomHex(32);
    const id = `${zone.id}-${zone.epoch}-${cellKey(r, c).replace(',', 'x')}-${randomHex(3)}`;
    // Drawn from the salt, like the game type: fixed before anyone enters and
    // checkable once the salt is revealed. It decides the prize, the entry fee
    // and how hard the block's game generates — every module has carried easy
    // and hard tables since phase 0, and a hardcoded 'med' here was the reason
    // two thirds of them never ran.
    const difficulty = difficultyForBlock(salt, id, zone.kind);
    const hunt: Hunt = {
      id,
      zoneId: zone.id,
      epoch: zone.epoch,
      r,
      c,
      salt,
      cellCommit: hash(id, zone.id, r, c, salt).toString('hex'),
      kind: 'cash',
      difficulty,
      // Derived from difficulty rather than cycled through a fixed array, so a
      // prize now means something about the hunt. See prizes.ts.
      prizeLabel: prizeLabelFor(difficulty),
      status: 'live',
      winnerId: null,
      game: null,
      expiresAt: now + huntTtlFor(zone.kind),
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
      escrow.enqueue(
        hunt.id,
        toTokenUnits(prizeCentsFor(hunt.difficulty), env.ESCROW_TOKEN_DECIMALS),
        hunt.expiresAt ?? now + huntTtlFor(zone.kind),
      );
    });

    open += 1;
    created += 1;
  }

  if (created > 0) logger.info({ zoneId, created, open }, 'zone replenished');
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
