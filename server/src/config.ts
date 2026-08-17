/**
 * Every tunable in one place. These numbers are the whole point of the slice —
 * expect to change them once real humans on real Android hardware have played.
 */

/**
 * The map.
 *
 * ─────────────────────────── why it got big ───────────────────────────
 *
 * 216 cells with four treasures on them is 1.85% density: a new player's first
 * energy bar bought twelve taps and a one-in-five chance of finding anything.
 * Brute force was not just viable, it was the *dominant* strategy — and a game
 * whose best line is "tap everything" has no use for the deduction, the hints
 * or the market that three phases were spent building.
 *
 * At 3,600 cells a full cycle's energy uncovers a few percent of the map.
 * Sweeping stops working, and reading the hints becomes the only way to play.
 * The grid is not big to be impressive; it is big to make information the
 * scarce thing.
 *
 * ─────────────────────────── what scales with it ───────────────────────────
 *
 * This is not a number you can change alone, and everything downstream of it is
 * now *derived* rather than hand-tuned, so the next change is a one-liner:
 *
 *   * hint band widths and distance radii — see hints/types.ts. They were
 *     constants picked against 216 cells, and carried over unchanged they would
 *     have turned every tier-3 hint into a near-exact answer.
 *   * `DEDUCTION.budget`, which is a function of ⌈log₂ cells⌉ (below).
 *   * `hints/types.ts` MID_ROW / MID_COL, already derived.
 *
 * {@link SEARCH} deliberately does NOT scale with it. See the note there.
 */
export const GRID = {
  cols: 60,
  rows: 60,
} as const;

/** Cells on the map. The quantity most of the derivations below are about. */
export const GRID_CELLS = GRID.rows * GRID.cols;

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

/**
 * Energy.
 *
 * ─────────────────────────── it has to be a real limit ──────────────────────
 *
 * A full bar used to refill in **108 seconds**. Nobody has ever paid money to
 * skip under two minutes, so the thing the business plans to sell could not be
 * sold — and nothing carried between sessions, so there was no reason to come
 * back tomorrow. A four-hour refill makes the bar something you spend
 * deliberately and something a Cycle Pass can meaningfully accelerate.
 *
 * 40 at 4h is one point every six minutes: 240/day, 720 over a three-day cycle.
 * Against 3,600 cells that is a few percent of the map per cycle even before
 * Survey starts competing for the same bar — which is the point. You cannot
 * sweep your way to a treasure any more.
 *
 * `costFog` stays at 1 until phase 3 splits digging from surveying; raising it
 * now would only make the game slower, not deeper.
 */
export const ENERGY = {
  max: 40,
  /** 75% of a bar, as before — enough to matter, short of full. */
  start: 30,
  /** 4h ÷ 40. */
  regenMs: 360_000,
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

/**
 * How many treasures a zone keeps live, and how many of them carry money.
 *
 * ─────────────────────────── why the split exists ───────────────────────────
 *
 * Twenty-four treasures on a 3,600-cell map is roughly the density the old
 * 216-cell grid had — enough that exploring finds *something*, which is what
 * keeps a huge map from feeling empty. But 24 cash hunts per zone at the prize
 * band below would burn about **$168/day**, against a self-funded floor of
 * $100–300 *per month*. The grid resize and the prize budget only reconcile if
 * most treasures pay in XP rather than cash.
 *
 * `HuntKind` has had a 'puzzle' member since phase 0 — the energy cost, the
 * module pool, the entry path all handle it — and `replenish` hardcoded 'cash',
 * so it had never once been created. This turns it on.
 *
 * ─────────────────────────── the arithmetic ───────────────────────────
 *
 * Cash hunts created per day = zones × CASH_PER_ZONE ÷ TTL in days.
 *
 *   human: 4 zones × 1 ÷ 1 day  = 4.00/day × 95.2c = $3.81/day
 *   agent: 1 zone  × 1 ÷ 3 days = 0.33/day × 112.8c = $0.38/day
 *                                                     ─────────────
 *                                                     $4.19/day
 *                                                     ≈ $127/month
 *
 * That sits in the lower half of the $100–300/month band on purpose. The
 * headline prize is meant to be *concentrated* — one large weekly final beats a
 * hundred small hunts for the same money — so routine hunts should not spend
 * the whole budget before that exists.
 *
 * Worst case (every hunt hard AND every one claimed) is ~$22/day, which is well
 * over the floor but is the tail, not the mean; the escrow's per-day claim cap
 * is the backstop that makes it survivable rather than a surprise.
 *
 * Four cash hunts a day across the world also matches the target density the
 * review asked for — few enough that finding one is an event.
 */
export const HUNTS_PER_ZONE = 24;

/** Of those, how many carry a prize. The rest are XP-only puzzle hunts. */
export const CASH_PER_ZONE = 1;

// ─────────────────────────── agent games ───────────────────────────
//
// None of these carry a timing floor, and their absence is the point. The human
// modules reject inputs that arrive too fast because a script that plays them
// perfectly is a cheat. Here a perfect player is the intended audience, so the
// budget — how many questions you may ask — is what makes the game hard.

/** Questions a perfect binary search needs to isolate one cell of the map. */
const OPTIMAL_PROBES = Math.ceil(Math.log2(GRID_CELLS));

export const DEDUCTION = {
  /**
   * Probes allowed, per difficulty.
   *
   * `hard` is exactly the information-theoretic optimum: nothing but perfect
   * information gain gets there, and a probe that fails to halve the remaining
   * space is a probe you cannot afford. `med` allows one wasted question and
   * `easy` four, which is room to be sloppy without room to guess.
   *
   * **Derived, not written down.** This used to read `{ easy: 12, med: 9,
   * hard: 8 }` with a comment explaining that 8 was ⌈log₂ 216⌉ — correct, and
   * silently wrong the moment the grid changed. At 3,600 cells the optimum is
   * 12, so the old `hard` was four questions short of winnable. The deduction
   * game probes in the same vocabulary the fog's hints use (see
   * `agents/validate.ts`), so its board genuinely IS the map and genuinely must
   * scale with it.
   */
  budget: {
    easy: OPTIMAL_PROBES + 4,
    med: OPTIMAL_PROBES + 1,
    hard: OPTIMAL_PROBES,
  },
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
   * The board this game is played on — **deliberately not the map**.
   *
   * Every other grid-derived number in this file scales with {@link GRID}.
   * This one must not, and the reason is that the budgets below are an
   * *empirical* bound rather than a formula: they come from measuring how many
   * probes a filter-based hunt needs against an evader that moves in response
   * to being looked at. That analysis was done on an 18×12 board and does not
   * survive being handed a 3,600-cell one — a pursuit problem does not scale
   * like a search problem, and the honest position is that nobody has measured
   * the big-board version.
   *
   * Nothing ties this game to the fog. Its probes are plain cells rather than
   * the hint vocabulary deduction borrows, and the board size travels to the
   * client in the block's spec, so keeping it at its tuned size costs nothing
   * and keeps a tested game tested. Revisit only with fresh measurement.
   */
  board: { rows: 18, cols: 12 },
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
