/**
 * Every tunable in one place. These numbers are the whole point of the slice —
 * expect to change them once real humans on real Android hardware have played.
 */

export const GRID = {
  cols: 12,
  rows: 18,
} as const;

/**
 * How long a map lives before it is torn up and reprinted.
 *
 * ─────────────────────────── why a world needs an end ───────────────────────
 *
 * Reveals are permanent within an epoch, so without rotation a zone is a
 * consumable: every dig removes a tile from the world and none ever come back.
 * One player working through an energy bar every 108 seconds strips a 216-cell
 * grid in about half an hour, and nothing in the system replaces what they
 * took. The schema has been ready for this since phase 0 — `zones.rotates_at`
 * and `zone_seed_history` were written for it — but nothing ever bumped the
 * epoch, so the fog only ever thinned.
 *
 * ─────────────────────────── per zone, not global ───────────────────────────
 *
 * `rotates_at` is a per-zone column and rotation reads it per zone, so this is
 * only the default for a freshly seeded world. Staggering zones is the point:
 * every map resetting on the same tick would empty the whole game at once.
 */
export const EPOCH = {
  /** Default lifetime of a map. Three days — long enough to be worth learning. */
  rotateMs: 3 * 24 * 60 * 60 * 1000,
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
   *
   * See {@link settlementWindowFor} — this is the human number, and it is far
   * too short for a zone where attempts last minutes.
   */
  settlementWindowMs: 400,
  /** Slack added to a game's limit before the server calls it late. */
  latencyGraceMs: 400,
} as const;

/**
 * The async clock.
 *
 * ─────────────────────────── two different games ───────────────────────────
 *
 * A human attempt is six seconds and everyone racing a block is online at the
 * same moment. An agent attempt is minutes: it thinks, probes, thinks again,
 * and its rivals may not have started yet. Every timing constant below exists
 * because a number that is obviously right for the first is obviously wrong for
 * the second.
 *
 * ─────────────────────────── the settlement window ──────────────────────────
 *
 * This is the one that is easy to get wrong, because the bug is invisible and
 * unfair rather than loud.
 *
 * Attempts are scored on **their own elapsed time**, not on wall-clock arrival.
 * The window is how long the result stays open after the first completion, so
 * that a slightly later finisher still competes on merit. At 400ms that covers
 * network jitter between players who all started together — exactly right for a
 * human race.
 *
 * On an agent zone the starts are spread over hours. An agent that begins an
 * hour later and solves in half the time has genuinely won, and a 400ms window
 * would hand the prize to whoever merely *started* first. So the window is
 * minutes there. The cost is real and worth stating: a hunt sits in `resolving`
 * for that long before the grid replenishes, so this trades grid liveliness for
 * fairness. It is not a free parameter to raise.
 */
export const ASYNC = {
  /** How long a hunt stays open, by who plays the zone. */
  huntTtlMs: {
    human: 24 * 60 * 60 * 1000,
    // Longer, because an agent may need several attempts' worth of thinking
    // time to be worth entering at all, and a hunt that expires mid-reasoning
    // is a hunt no rational agent starts.
    agent: 72 * 60 * 60 * 1000,
  },
  /** How long a finished result stays open for later finishers. */
  settlementWindowMs: {
    human: RACE.settlementWindowMs,
    agent: 15 * 60 * 1000,
  },
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

// ─────────────────────────── agent games ───────────────────────────
//
// None of these carry a timing floor, and their absence is the point. The human
// modules reject inputs that arrive too fast because a script that plays them
// perfectly is a cheat. Here a perfect player is the intended audience, so the
// budget — how many questions you may ask — is what makes the game hard.

export const DEDUCTION = {
  /**
   * Probes allowed, per difficulty.
   *
   * The grid is 18×12 = 216 cells, so a perfect binary search needs
   * ⌈log₂ 216⌉ = 8 questions. `hard` is exactly 8: nothing but optimal
   * information gain gets there, and a probe that fails to halve the remaining
   * space is a probe you cannot afford. `easy` leaves room to be sloppy.
   */
  budget: { easy: 12, med: 9, hard: 8 },
  /** Minutes. An agent is expected to think between probes, not react. */
  limitMs: 10 * 60 * 1000,
} as const;

export const NEGOTIATION = {
  /** Offers allowed before the counterparty walks. */
  rounds: { easy: 10, med: 7, hard: 5 },
  /**
   * The share the agent must still hold when the deal closes, in basis points.
   *
   * Without it the game is trivial — offer the counterparty everything and it
   * accepts instantly. This is what makes conceding expensive and turns the
   * hunt into "find the least you can pay", which is the actual skill.
   */
  minKeepBps: { easy: 3_000, med: 4_500, hard: 6_000 },
  /**
   * How far below the counterparty's line an offer may fall before it walks
   * away for good — the width of the corridor you are searching blind.
   *
   * This is the rule that makes the game a game. Without it, offering the bare
   * minimum every round is safe and eventually accepted on every block, and no
   * reasoning is involved. With it, that line gets you thrown out of any
   * negotiation whose counterparty opens late.
   */
  insultBps: { easy: 2_500, med: 1_800, hard: 1_200 },
  /** The pot shrinks by this fraction each round. Waiting has to cost. */
  decayBps: 800,
  limitMs: 10 * 60 * 1000,
} as const;

export const SEARCH = {
  /**
   * Probes allowed before the evader escapes for good.
   *
   * Set from measurement, not taste. A player who tracks every position
   * consistent with the readings and advances them through the published escape
   * rule catches it in **four probes, worst case, on every block** — so these
   * budgets leave a filter-based hunt four, two and one spare probe.
   *
   * The other end matters more. Hill-climbing on hot/cold never works at any
   * budget, because the evader outruns a hunter that ignores its motion — that
   * is the adversarial property doing its job. What a loose budget WOULD buy is
   * luck: random probing lands on it about 15% of the time given fourteen
   * probes, and under 2% given five. Tight budgets are what keep this a
   * reasoning game rather than a lottery with extra steps.
   */
  probes: { easy: 8, med: 6, hard: 5 },
  /**
   * How far the evader moves per probe. One step, Chebyshev — enough to make a
   * naive binary search fail, slow enough that herding it into a corner works.
   */
  evaderStep: 1,
  limitMs: 10 * 60 * 1000,
} as const;
