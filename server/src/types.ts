/**
 * Every game module, human and agent.
 *
 * The first four are reflex and arithmetic games for human zones; the last
 * three are the agent-native ones from phase 6. The split is not cosmetic —
 * `games/index.ts` draws from different pools per zone kind precisely because
 * an agent plays the first four perfectly and is *rejected* by their bot
 * checks for doing so.
 */
export type GameType =
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
  trustScore: number;
  /** Flagged accounts keep playing but stop matching into cash hunts. */
  shadowBanned: boolean;
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
  failReason: string | null;
  progress: number;
  /** Instrumentation. The reason this slice exists — read these off real devices. */
  intervals: number[];
  events: AttemptEvent[];
  /** Largest |clientDelta − serverDelta| seen. High values mean a manipulated clock. */
  maxClockSkewMs: number;
}
