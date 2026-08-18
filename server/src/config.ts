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
 * `costFog` is 2 now that Survey exists to compete with it. The two prices are
 * the whole choice the player makes each turn: a dig at 2 buys one tile of
 * certainty, a survey at 6 buys a reading over the whole neighbourhood and
 * consumes no map. Three digs to one survey is the exchange rate, and it is
 * meant to make surveying the obvious opener and digging the way you finish.
 */
export const ENERGY = {
  max: 40,
  /** 75% of a bar, as before — enough to matter, short of full. */
  start: 30,
  /** 4h ÷ 40. */
  regenMs: 360_000,
  costFog: 2,
  costCashHunt: 3,
  costPuzzleHunt: 2,
} as const;

/**
 * What the five tile types actually do.
 *
 * ─────────────────────────── the first tap taught a lie ─────────────────────
 *
 * `grid.ts` has labelled tiles empty / clue / trap / mystery / puzzle since
 * phase 0, and **none of them did anything**. A trap cost nothing. A clue gave
 * no clue. The onboarding copy promised "clues run warm when treasure is near"
 * about a mechanic that did not exist anywhere in the game. A new player's very
 * first tap was a lesson that our words are decorative — which is an expensive
 * thing to teach in the first fifteen seconds.
 *
 * The distribution is unchanged (56/17/12/9/6). Only the consequences are new,
 * and each is chosen to push toward the same thing: knowing more about *where*
 * rather than getting more of *what*.
 */
export const TILES = {
  /** A clue always pays a hint. The 35% drop roll is skipped, not improved. */
  clue: { guaranteedHint: true },
  /**
   * A trap costs double and hands you a hint drawn from the false ones.
   *
   * The hint comes out of the hunt's already-committed set, so the published
   * honesty numbers are untouched — see `pickFrom` in hints/index.ts. It is a
   * real cost with a real consequence, and it is survivable: a false hint that
   * contradicts your others is itself information, which is why traps make the
   * deduction better rather than merely more expensive.
   */
  trap: { energyMultiplier: 2, falseHint: true, guaranteedHint: true },
  /** Opens one neighbour for free. Only coherent because fog is per-player. */
  mystery: { freeNeighbours: 1 },
  /** Pays XP. Not cash — see the four rules in §7b of the review. */
  puzzle: { xp: 10 },
} as const;

/** XP for finding a treasure that carries no money. Most of them. */
export const PUZZLE_HUNT_XP = 50;

/**
 * Survey: the hot/cold detector.
 *
 * ─────────────────────────── why this exists ───────────────────────────
 *
 * There was exactly one thing to do in this game — uncover a tile — and that
 * was the poverty at the centre of it. Digging is a slot machine: you pay, you
 * mostly get nothing, and nothing you learn compounds. Survey is the thinking
 * move. Three readings from different places triangulate a location the way
 * three people pointing at a sound locate its source, which is a puzzle rather
 * than a pull of the lever.
 *
 * It does four jobs at once, and the last two are the ones that make it worth
 * its cost:
 *
 *   1. It is the actual deduction the whole economy is priced around.
 *   2. **It burns energy without consuming map.** On a 3,600-cell grid that is
 *      what lets a zone survive being played hard — see EPOCH. Every other
 *      energy sink takes a tile out of the world permanently.
 *   3. It makes the onboarding true. "Clues run warm when treasure is near" has
 *      been on the tutorial card since phase 0 describing a mechanic that did
 *      not exist. Survey *is* warmth.
 *   4. It always tells you something. There is no wasted spend, which is what a
 *      35% hint drop cannot say.
 *
 * ─────────────────────────── the vagueness is the knob ──────────────────────
 *
 * Bands, not distances. A number would collapse the game: two readings and a
 * little arithmetic give an exact answer, and the map stops mattering. Coarse
 * bands mean a reading narrows the field without solving it, so three or four
 * of them from different places are worth more than one precise one.
 *
 * The review left "how vague" explicitly open and said to start coarse and tune
 * from real data. These are deliberately wide — it is far easier to sharpen a
 * detector players find useless than to blunt one that has already taught them
 * the game is trivial.
 */
export const SURVEY = {
  /** Three times a dig. It has to compete with digging, not replace it. */
  cost: 6,
  /**
   * Chebyshev distance to the nearest treasure, in bands. Upper bounds,
   * inclusive; anything past the last is `cold`.
   *
   * Scaled to the map: `burning` is a 5-cell reach on a 60-wide grid, so a
   * burning reading leaves ~121 candidate cells — narrow enough to be thrilling
   * and wide enough to still need work.
   */
  bands: [
    { name: 'burning', within: 5 },
    { name: 'hot', within: 12 },
    { name: 'warm', within: 25 },
    { name: 'cool', within: 40 },
  ],
  /** Everything beyond the last band. */
  coldest: 'cold',
} as const;

/**
 * Keys — the second currency, and the one that cannot be bought.
 *
 * Energy buys digging and surveying: exploration and information, sold freely,
 * and the actual product. Keys buy entry to a cash hunt, and nothing buys keys
 * — not money, not referrals, not a streak.
 *
 * See keys.ts for why there is deliberately no balance to credit. The numbers
 * here are the entire configuration surface, and `perDay` is meant to be
 * invisible: there are about four cash treasures on the whole map in a day, so
 * a normal player never approaches five. A good cap is invisible to normal
 * players and painful to abusers.
 */
export const KEYS = {
  perDay: 5,
  /** Fixed UTC days rather than a rolling window — see the escrow's daily cap
   *  for the same reasoning: a sliding window needs stored history to prove the
   *  same property, and the cap exists to bound damage, not to be precise. */
  dayMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * Prospector rank, and what a cash hunt requires of it.
 *
 * The numbers are deliberately modest. This gate exists to make a *farm*
 * expensive, not to make a first cash hunt hard to reach — a real player who
 * digs for two or three days clears it without noticing, while fifty burner
 * wallets need fifty times that in energy and, crucially, the same two or three
 * days each. Time is the axis an attacker cannot buy.
 *
 * See rank.ts for why the gate is time-and-volume while the ladder above it is
 * accuracy, and why conflating the two would break both.
 */
export const RANK = {
  /** Hints that have resolved — held on hunts which have since closed. */
  minResolvedHints: 6,
  /** Distinct UTC days on which hints were acquired. The part money cannot rush. */
  minActiveDays: 2,
  /** The tier a cash hunt demands. Everything below it is refused with a reason. */
  minTierForCash: 'prospector' as const,

  /** Above the gate the ladder is accuracy. 60% and 75% of held hints true. */
  surveyor: { resolved: 20, accuracyBps: 6_000 },
  cartographer: { resolved: 60, accuracyBps: 7_500 },
} as const;

/**
 * Wallet age, and the tier a cash hunt demands.
 *
 * ─────────────────────────── what age actually buys ─────────────────────────
 *
 * An empty new wallet costs nothing to create — that is the whole sybil
 * problem in one sentence. A wallet with history is a different object: it took
 * real time, and in `AUTH_MODE=chain` it took real transactions someone paid
 * for.
 *
 * The honest limitation, stated rather than hidden: this measures when the
 * account first appeared *to us*, not the age of the wallet on chain. An
 * attacker who registers fifty wallets today and waits two days defeats it, and
 * the rank gate is what makes that wait expensive rather than merely long —
 * they must also *play* on each of those days. Reading true wallet age from
 * chain is the stronger check and belongs with the on-chain identity work; this
 * is the part that can be enforced without an RPC on the entry path.
 */
export const WALLET = {
  /** How long an account must have existed before it can win money. */
  minAgeMs: 2 * 24 * 60 * 60 * 1000,
  /** Mirrors RANK.minTierForCash; kept here so `admission.ts` reads one config. */
  minTierForCash: 'prospector' as const,
} as const;

/**
 * The first sixty seconds.
 *
 * Four out of five new players never found a single treasure in their first
 * session, and that was on a grid a seventeenth of the current size. No
 * top-grossing mobile game leaves the first win to chance — this one does not
 * either. See tutorial.ts.
 */
export const TUTORIAL = {
  /** Keep the start cell off the edges, so all eight neighbours exist. */
  margin: 4,
  /**
   * Where the placed treasure sits relative to the start cell.
   *
   * Close enough to reach in one move after the survey, far enough that the
   * survey is doing visible work rather than pointing at the tile you are
   * standing on. Chebyshev distance 2 reads `burning` on the SURVEY bands.
   */
  treasureOffset: { r: 2, c: 1 },
  /** Long enough to survive a session and a night's sleep. */
  ttlMs: 48 * 60 * 60 * 1000,
  /** What the placed treasure pays. Energy AND xp — see tutorial.ts on why not cash. */
  reward: { xp: 100, energy: 10 },
} as const;

/**
 * The Cycle Pass — the only subscription-shaped thing sold.
 *
 * It sells *tempo*, which is the category the review marks as freely sellable:
 * it buys attempts at finding, never a chance at winning. A pass holder digs
 * more; they do not get a sixth key, and their hints are not truer.
 *
 * Three days on purpose. That is one cycle, so a pass expires when the map
 * does — one that straddled a reset would be selling speed on a board that no
 * longer exists.
 */
export const PASS = {
  /** Regen multiplier while active. Four hours to a full bar becomes two. */
  regenMultiplier: 2,
  /** A full bar once per UTC day, claimed on first sight rather than pushed. */
  dailyTopUp: true,
  dayMs: 24 * 60 * 60 * 1000,
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

/**
 * When a treasure you found becomes a treasure everyone can see.
 *
 * ─────────────────────────── the two failure modes ──────────────────────────
 *
 * Hunt locations used to ship to every client, which made Survey, hints and the
 * whole 3,600-cell map pointless — see migration 019. Making them private fixes
 * that and immediately risks the opposite failure: a treasure visible only to
 * its finder is a treasure nobody races for, and the multiplayer game
 * disappears without anyone deciding to remove it.
 *
 * So visibility is time-bounded. The rule is already written down for hints in
 * AGENTIC_ARCHITECTURE.md §5 — "exclusivity must be time-bounded, a head start
 * and not a monopoly" — and it applies to discovery for exactly the same reason.
 *
 * ─────────────────────────── twenty minutes of WHAT ─────────────────────────
 *
 * Preparation, not an exclusive attempt. This distinction decides whether the
 * game has multiplayer in it at all.
 *
 * The Crack resolves in fifteen seconds (CRACK.windowMs). An exclusive-attempt
 * head start of twenty minutes would therefore mean the finder resolves almost
 * every hunt alone, long before anyone else is told it exists — a hunt would
 * reach the zone already dead. What the finder gets instead is twenty minutes of
 * knowing: time to apply hints, buy a scout report and narrow the candidate set
 * before the field arrives. Then the Crack opens for everyone at once and the
 * finder simply plays it better informed.
 *
 * That is also what keeps the reward proportionate. Finding a treasure is worth
 * a real edge, and it is not worth the prize.
 */
export const DISCOVERY = {
  /** How long a finder holds a treasure privately before the zone is told. */
  headStartMs: 20 * 60 * 1000,
  /**
   * How long a treasure nobody has found stays hidden.
   *
   * A quarter of the hunt's TTL, so three quarters of its life stays raceable
   * even in the worst case. Without it a badly placed treasure would sit
   * invisible until it expired — a hunt the treasury paid to fund that nobody
   * could ever play.
   */
  publicAfterMs: {
    human: ASYNC.huntTtlMs.human / 4,
    agent: ASYNC.huntTtlMs.agent / 4,
  },
} as const;

/**
 * The Crack — the one way to win money.
 *
 * ─────────────────────────── what it replaces ───────────────────────────
 *
 * Every design decision in this codebase pointed at deduction, and then the
 * prize went to whoever tapped fourteen times fastest. Someone who worked out
 * the location and someone who wandered onto the tile by luck competed
 * identically, on thumb speed. Worse than the unfairness is the *feeling*: "I
 * lost because my phone is slow" is a belief no amount of server-side fairness
 * can argue with, and it is the belief a reflex race on a cheap Android
 * produces.
 *
 * Six doors, the same six for everyone, fifteen seconds, everyone locks, all
 * reveal at once. Right pick wins.
 *
 * ─────────────────────────── what decides it ───────────────────────────
 *
 * Correctness first, then **fewer hints used**, then a deterministic hash of
 * the hunt and player. Elapsed time appears nowhere, and neither does arrival
 * order: both are proxies for hardware and connection. That is the whole point
 * — phone speed and internet speed stop mattering entirely.
 *
 * The hint tiebreak is doing real work. It means the player who reached the
 * answer on fewer purchased hints beats the one who bought their way to the
 * same answer, so spending actively costs you the close ones. It is the third
 * of the four anti-pay-to-win rules, and the only one that lives in the
 * scoring rather than in a cap.
 *
 * ─────────────────────────── why six ───────────────────────────
 *
 * A blind guess is 1-in-6, which is a real chance and a poor plan. Three good
 * hints typically leave two, which is a coin flip you earned. Fewer doors and
 * hints would be decisive rather than helpful; more and a hintless player would
 * never win at all, which removes the free path the legal argument rests on.
 */
export const CRACK = {
  doors: 6,
  /** Everyone gets the same fifteen seconds. Long enough to think, not to look up. */
  limitMs: 15_000,
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
