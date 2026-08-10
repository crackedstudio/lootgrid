/**
 * Every tunable in one place. These numbers are the whole point of the slice —
 * expect to change them once real humans on real Android hardware have played.
 */

export const GRID = {
  cols: 12,
  rows: 18,
} as const;

export const ENERGY = {
  max: 12,
  start: 9,
  regenMs: 9_000,
  costFog: 1,
  costCashHunt: 3,
  costPuzzleHunt: 2,
} as const;

export const RACE = {
  /**
   * When the first player completes, hold the result open this long and collect
   * everyone else who lands inside it, then award to the lowest *server-measured*
   * elapsed time. Imperceptible to players, and it stops the prize going to
   * whoever happens to have the best connection.
   */
  settlementWindowMs: 400,
  /** Slack added to a game's limit before the server calls it late. */
  latencyGraceMs: 400,
} as const;

export const TAP = {
  target: 14,
  limitMs: 6_000,
  /**
   * The human tapping record is ~15/sec (≈66ms). 25ms is deliberately generous —
   * we want to reject scripts, not punish fast thumbs.
   */
  minIntervalMs: 25,
  /**
   * The highest-signal check in the system. A bot on a fixed timer produces
   * σ≈0; human mashing sits somewhere around 15–40ms. Measured at completion,
   * because σ over two samples is meaningless.
   */
  minSigmaMs: 8,
  minDistinctIntervals: 3,
} as const;

export const MATH = {
  count: 3,
  limitMs: 20_000,
  /** Reading `7 × 8` and four options cannot happen faster than this. */
  minAnswerMs: 300,
  maxAnswerMs: 8_000,
} as const;

export const SEQUENCE = {
  n: 5,
  limitMs: 12_000,
  /** Deliberately looser than Tap: these are aimed taps at distinct targets. */
  minIntervalMs: 90,
} as const;

export const MEMORY = {
  length: 4,
  padCount: 4,
  /** Playback timing, matched to the client's animation so the two agree. */
  stepMs: 700,
  leadMs: 400,
  tailMs: 200,
  inputBudgetMs: 8_000,
  /** Human recall-and-reach floor. */
  minIntervalMs: 120,
} as const;

export const NET = {
  /** Progress fan-out is coalesced to one message per room per tick. */
  progressHz: 5,
  /** Deadline sweeper cadence. One loop for the whole process. */
  deadlineSweepMs: 100,
} as const;

/** How many cash hunts each zone seeds with. */
export const HUNTS_PER_ZONE = 4;
