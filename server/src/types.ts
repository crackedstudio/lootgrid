/**
 * Every game module, human and agent.
 *
 * `crack` is the only one that decides money on a human zone. The four reflex
 * and arithmetic games below it now guard XP alone — they were deciding cash on
 * thumb speed, which is not the skill this game is built around. The last three
 * are the agent-native ones from phase 6.
 *
 * The split is not cosmetic: `games/index.ts` draws from different pools per
 * zone kind precisely because an agent plays the reflex games perfectly and is
 * *rejected* by their bot checks for doing so.
 */
export type GameType =
  | 'crack'
  | 'tap'
  | 'math'
  | 'sequence'
  | 'memory'
  | 'deduction'
  | 'negotiation'
  | 'search';
export type Difficulty = 'easy' | 'med' | 'hard';
export type HuntKind = 'cash' | 'puzzle';

export type TileType = 'empty' | 'clue' | 'trap' | 'mystery' | 'puzzle';

export interface Player {
  /** Wallet address, lowercased, once AUTH_MODE=chain. */
  id: string;
  handle: string;
  /** Address bound via PlayerRegistry; requests are signed with its private key. */
  sessionKey: string | null;
  /** Lazily-computed energy: value at `energyAt`, plus regen since. Never ticked. */
  energyValue: number;
  energyAt: number;
  /**
   * When the Cycle Pass ends, or null.
   *
   * On the player rather than only in `entitlements` because it changes the
   * regen RATE, and `currentEnergy` is a pure function called on nearly every
   * request. See migration 017.
   */
  passUntil: number | null;
  /** When the pass's daily top-up was last taken. Claimed, never pushed. */
  passToppedUpAt: number | null;
  /**
   * UTC day this player was last recorded active, in memory only.
   *
   * Not a column — it exists so `markSeen` can skip a write it already made
   * this process's lifetime. The durable record is `player_days`.
   */
  lastSeenDay?: number;
  trustScore: number;
  /** Flagged accounts keep playing but stop matching into cash hunts. */
  shadowBanned: boolean;
  /**
   * What everything that is not money pays in.
   *
   * Most treasures are XP-only — see `CASH_PER_ZONE`. A counter rather than a
   * balance: XP buys nothing and is never spent, so there is no ledger and no
   * solvency question. Phase 5's Prospector rank reads it.
   */
  xp: number;
  createdAt: number;
}

/**
 * Who plays a zone. Decides which game modules are eligible, and therefore
 * whether anti-automation applies — see `games/index.ts`.
 *
 * Distinct from {@link HuntKind} ('cash' | 'puzzle'), which describes a hunt's
 * stakes rather than its players. Both are called `kind` on their own type; read
 * the owner, not the field name.
 */
export type ZoneKind = 'human' | 'agent';

export interface Zone {
  id: string;
  name: string;
  accent: string;
  /** Defaults to 'human'. See {@link ZoneKind}. */
  kind: ZoneKind;
  /**
   * Secret for the life of the epoch — this is the whole fog. Published when the
   * epoch rotates so players can audit that the map was fixed in advance.
   */
  seedSecret: string;
  seedCommit: string;
  epoch: number;
  /**
   * When this map is torn up and reprinted. Null means never — the phase 0
   * behaviour, kept reachable because an agent zone mid-experiment is not
   * always something you want reset under you.
   *
   * Load-bearing beyond scheduling: a hunt's TTL is clamped to it, so no hunt
   * can outlive the epoch that created it. See `store.replenish`.
   */
  rotatesAt: number | null;
}

export interface Reveal {
  r: number;
  c: number;
  type: TileType;
  byHandle: string;
  at: number;
}

/**
 * The game a block holds. Derived from the hunt's salt, generated once, and served
 * identically to everyone racing it — if you got Math Dash and I got Tap Challenge
 * we would not be racing the same thing.
 */
export interface BlockGame {
  type: GameType;
  spec: unknown;
  secret: unknown;
  limitMs: number;
}

export interface Hunt {
  id: string;
  zoneId: string;
  epoch: number;
  r: number;
  c: number;
  /** Revealed at settlement; proves the block was not relocated mid-race. */
  salt: string;
  cellCommit: string;
  kind: HuntKind;
  /**
   * Reserved for one player, or null for the shared map.
   *
   * An owned hunt is invisible to everyone else and enterable only by its
   * owner. It exists so a new player's first treasure can be *placed* rather
   * than left to a two-percent chance — see migration 016. Owned hunts are
   * XP-only; a cash prize handed to an ungated new wallet is the sybil hole
   * phase 5 closed.
   */
  ownerId: string | null;
  difficulty: Difficulty;
  /** Display only until the escrow contract lands — no money moves yet. */
  prizeLabel: string;
  status: 'live' | 'resolving' | 'resolved' | 'expired';
  winnerId: string | null;
  game: BlockGame | null;
  expiresAt: number | null;
  createdAt: number;
}

export type AttemptStatus = 'active' | 'won' | 'lost' | 'failed' | 'abandoned';

export interface AttemptEvent {
  seq: number;
  kind: string;
  tClient: number;
  tServer: number;
}

export interface Attempt {
  id: string;
  huntId: string;
  playerId: string;
  handle: string;
  gameType: GameType;
  startedAt: number;
  deadlineAt: number;
  status: AttemptStatus;
  lastSeq: number;
  /** Module-owned runtime state. In memory only — never persisted. */
  state: unknown;
  elapsedMs: number | null;
  /**
   * Hints held about this hunt at the moment the answer was committed.
   *
   * Null until the attempt completes, and null for games that do not use it.
   * The Crack's tiebreak: correct pick first, then fewer hints. Snapshotted at
   * the decision rather than recomputed at resolution, because a hint arriving
   * in the fifteen seconds before the reveal must not cost someone a tiebreak
   * they had already earned.
   */
  hintsUsed: number | null;
  failReason: string | null;
  progress: number;
  /** Instrumentation. The reason this slice exists — read these off real devices. */
  intervals: number[];
  events: AttemptEvent[];
  /** Largest |clientDelta − serverDelta| seen. High values mean a manipulated clock. */
  maxClockSkewMs: number;
}
