import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { env } from './env';

export const registry = new Registry();

if (env.METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry, prefix: 'lootgrid_' });
}

export const httpRequests = new Counter({
  name: 'lootgrid_http_requests_total',
  help: 'HTTP requests by route and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'lootgrid_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const wsConnections = new Gauge({
  name: 'lootgrid_ws_connections',
  help: 'Open WebSocket connections',
  registers: [registry],
});

export const wsMessages = new Counter({
  name: 'lootgrid_ws_messages_total',
  help: 'Inbound WebSocket messages by type and result',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
});

export const attemptsFinished = new Counter({
  name: 'lootgrid_attempts_finished_total',
  help: 'Finished attempts by game type and outcome',
  labelNames: ['game_type', 'outcome'] as const,
  registers: [registry],
});

/**
 * The anti-cheat signal to actually watch. A spike in `timing_too_regular` means
 * bots; a spike in `interval_floor` more likely means the floor is too tight for
 * real hardware and legitimate players are being failed.
 */
export const attemptFailures = new Counter({
  name: 'lootgrid_attempt_failures_total',
  help: 'Failed attempts by reason',
  labelNames: ['game_type', 'reason'] as const,
  registers: [registry],
});

export const raceResolutions = new Counter({
  name: 'lootgrid_race_resolutions_total',
  help: 'Hunts resolved with a winner',
  registers: [registry],
});

export const winnerElapsed = new Histogram({
  name: 'lootgrid_winner_elapsed_ms',
  help: 'Winning elapsed time per race',
  buckets: [500, 1000, 1500, 2000, 3000, 4000, 6000, 10000, 20000],
  registers: [registry],
});

export const raceRacers = new Histogram({
  name: 'lootgrid_race_racers',
  help: 'Players per resolved race',
  buckets: [1, 2, 3, 5, 8, 13, 21],
  registers: [registry],
});

export const tilesRevealed = new Counter({
  name: 'lootgrid_tiles_revealed_total',
  help: 'Fog tiles uncovered',
  labelNames: ['type'] as const,
  registers: [registry],
});

/**
 * Treasures dug up, as opposed to treasures that went public on the clock.
 *
 * The ratio between this and hunts created is the honest read on whether the
 * map is findable: if most hunts reach the zone by timing out rather than by
 * someone digging them up, Survey and hints are not doing their job and the
 * 3,600-cell grid is too big for the energy budget.
 */
export const huntsDiscovered = new Counter({
  name: 'lootgrid_hunts_discovered_total',
  help: 'Treasures located by a player digging their cell',
  labelNames: ['kind'] as const,
  registers: [registry],
});

// ---- escrow funding ----
//
// A dead row here is a hunt that will never carry a prize. Alert on it.

export const escrowEnqueued = new Counter({
  name: 'lootgrid_escrow_enqueued_total',
  help: 'Prize pots queued for funding',
  registers: [registry],
});

export const escrowDeduped = new Counter({
  name: 'lootgrid_escrow_deduped_total',
  help: 'Funding enqueues rejected as duplicates',
  registers: [registry],
});

export const escrowFunded = new Counter({
  name: 'lootgrid_escrow_funded_total',
  help: 'Prize pots confirmed on chain',
  registers: [registry],
});

export const escrowFailed = new Counter({
  name: 'lootgrid_escrow_failed_total',
  help: 'Funding attempts that failed',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const escrowDead = new Counter({
  name: 'lootgrid_escrow_dead_total',
  help: 'Pots abandoned after exhausting retries — alert on this',
  registers: [registry],
});

export const escrowQueueDepth = new Gauge({
  name: 'lootgrid_escrow_queue_depth',
  help: 'Rows in the escrow outbox by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

// ---- entry fees ----

export const entryFeesCollected = new Counter({
  name: 'lootgrid_entry_fees_total',
  help: 'Entry payment outcomes',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const entriesFree = new Counter({
  name: 'lootgrid_entries_free_total',
  help: 'Entries admitted without payment (energy path)',
  registers: [registry],
});

/**
 * Entries a player actually paid for.
 *
 * Watch it against {@link entriesFree}. If almost nobody ever pays, the fee is
 * not filtering anything and the legal exposure it carries is being taken for
 * no benefit — which is a reason to turn it off, not to raise it.
 */
export const entriesPaid = new Counter({
  name: 'lootgrid_entries_paid_total',
  help: 'Entries admitted after a settled payment',
  registers: [registry],
});

/**
 * Fee as a fraction of one entrant's expected prize share, per zone.
 *
 * THE metric for this phase. A rational agent refuses a hunt where this reaches
 * 1.0, so crossing it does not slow participation — it stops it. Alert well
 * below, at 0.6, because by the time it is observed at 1.0 the agents are gone.
 */
export const entryEvRatio = new Gauge({
  name: 'lootgrid_entry_ev_ratio',
  help: 'Entry fee divided by expected prize share per entrant',
  labelNames: ['zone', 'difficulty'] as const,
  registers: [registry],
});

// ---- hints ----
//
// Phase 1 exists to answer one question — is hint-driven discovery fun? — and
// these are how it gets answered with data rather than opinion. Watch the ratio
// of hunts found by hint-holders to hunts found without: if holding hints does
// not visibly change where players dig, the loop is not working.

export const hintsAwarded = new Counter({
  name: 'lootgrid_hints_awarded_total',
  help: 'Hints granted to players',
  labelNames: ['tier'] as const,
  registers: [registry],
});

/** Split by whether the finder held any live hint for that hunt. */
/**
 * Survey readings, by how warm they came back.
 *
 * The distribution is the tuning signal for how vague the detector should be —
 * the review left that explicitly open. Mostly-cold means the bands are too
 * tight to be worth six energy; mostly-burning means it is solving the map.
 */
export const surveysTaken = new Counter({
  name: 'lootgrid_surveys_total',
  help: 'Survey readings taken, by band',
  labelNames: ['band'],
  registers: [registry],
});

/**
 * The shop, counted per SKU and per category — never as one lump.
 *
 * The whole business thesis is a claim about WHICH of these sells. The review
 * ranks the rake as not-revenue, house-sold hints as real money, and energy
 * burned manufacturing hints for sale as the actual business — which implies
 * the Compass matters more than its ten cents suggests, because it is the only
 * item that makes another item sell more.
 *
 * A single revenue counter could not falsify any of that. These can.
 */
// ─────────────────────────── the funnel ───────────────────────────
//
// Five numbers, and deliberately only five. The review is explicit: "nothing
// else until those five are trustworthy". Forty-odd counters already existed
// here before this block and every one of them measured the SYSTEM — escrow
// queue depth, inference failures, realised rake. Not one measured a player.
//
// Six phases were built on top of that silence. These are the numbers that say
// whether any of it worked.

/**
 * 1. Taps to first treasure.
 *
 * The number behind "four out of five new players never find a single treasure
 * in their first session". Observed once per player, at the moment they first
 * enter a hunt — so the histogram is one sample per person, not per attempt,
 * and its count is "players who ever found anything".
 *
 * Buckets are shaped around a bar rather than round numbers: 20 digs is a full
 * bar at the current cost, so the first three buckets are the first three bars.
 * If phase 6's placed treasure works, this collapses towards 3.
 */
export const tapsToFirstTreasure = new Histogram({
  name: 'lootgrid_taps_to_first_treasure',
  help: 'Tiles a player dug before entering their first hunt',
  buckets: [1, 3, 5, 10, 20, 40, 60, 100, 200],
  registers: [registry],
});

/**
 * 2. Hints held at entry.
 *
 * Whether the deduction loop is actually reachable. `huntsFound{hinted=}` has
 * carried the yes/no version since phase 1 and it was too coarse to answer the
 * real question: three hints about one treasure is the thing the whole economy
 * is priced around, and a boolean cannot tell one from three.
 */
export const hintsHeldAtEntry = new Histogram({
  name: 'lootgrid_hints_held_at_entry',
  help: 'Live hints a player held about a hunt when they entered it',
  buckets: [0, 1, 2, 3, 4, 6, 10],
  labelNames: ['kind'],
  registers: [registry],
});

/**
 * 3. Energy-empty moments.
 *
 * The highest-intent moment in the session, and until phase 6 it was dead air.
 * Labelled by what the player was trying to do, because "stopped mid-dig" and
 * "could not afford a survey" are different problems with different fixes.
 */
export const energyEmpty = new Counter({
  name: 'lootgrid_energy_empty_total',
  help: 'Times a player was refused for want of energy, by action',
  labelNames: ['action'],
  registers: [registry],
});

/**
 * 4. Day-1 and day-7 return.
 *
 * A gauge rather than a counter because it is a cohort question — of the people
 * who joined on a given day, how many came back — and cohorts are computed from
 * history, not accumulated as they happen. See funnel.ts.
 */
export const retention = new Gauge({
  name: 'lootgrid_retention_ratio',
  help: 'Share of a cohort active N days after signing up',
  labelNames: ['day'],
  registers: [registry],
});

/**
 * 5. Share of players who ever pay.
 *
 * The single biggest unknown in the business: whether one-tap payment converts
 * better than an app store would. The gap between the pessimistic and
 * optimistic answers is 10x — break-even at 950 players or at 9,500 — and
 * nothing but this number decides which.
 */
export const payingShare = new Gauge({
  name: 'lootgrid_paying_players_ratio',
  help: 'Share of players who have ever completed a purchase',
  registers: [registry],
});

export const playersTotal = new Gauge({
  name: 'lootgrid_players_total',
  help: 'Distinct players, by whether they have ever paid',
  labelNames: ['paid'],
  registers: [registry],
});

export const shopPurchases = new Counter({
  name: 'lootgrid_shop_purchases_total',
  help: 'Completed purchases, by SKU',
  labelNames: ['sku', 'category'],
  registers: [registry],
});

export const shopRevenueCents = new Counter({
  name: 'lootgrid_shop_revenue_cents_total',
  help: 'Revenue in cents, by SKU',
  labelNames: ['sku', 'category'],
  registers: [registry],
});

export const shopCreditsUsed = new Counter({
  name: 'lootgrid_shop_refill_credits_used_total',
  help: 'Banked refills actually spent',
  registers: [registry],
});

/**
 * Hints redirected by a Compass.
 *
 * The number that says whether targeting is worth paying for. If this stays
 * near zero while refills sell, the thesis that targeting is the scarce thing
 * is wrong, and that is worth learning from a counter rather than an argument.
 */
export const compassHintsAimed = new Counter({
  name: 'lootgrid_compass_hints_aimed_total',
  help: 'Hints granted about a Compass-chosen treasure',
  registers: [registry],
});

export const passTopUps = new Counter({
  name: 'lootgrid_pass_topups_total',
  help: 'Daily Cycle Pass top-ups claimed',
  registers: [registry],
});

export const huntsFound = new Counter({
  name: 'lootgrid_hunts_found_total',
  help: 'Hunts discovered, by whether the finder held a hint for them',
  labelNames: ['hinted'] as const,
  registers: [registry],
});

// ---- the hint market ----
//
// Phase 5 asks whether a market forms and whether deduction creates value.
// These are how that gets answered with data. The one to watch is
// `marketRealisedRakeBps`: stuck near zero means every trade is under the
// waiver, which means the market is all dust and the rake is not worth taking.

export const marketListings = new Counter({
  name: 'lootgrid_market_listings_total',
  help: 'Hints offered for sale, by tier',
  labelNames: ['tier'] as const,
  registers: [registry],
});

/**
 * Listings refused before they existed.
 *
 * `not_bonded` rising is the requirement working. `bond_unavailable` rising is
 * an RPC problem being paid for by sellers, and is the one to alert on.
 */
export const marketListingRefusals = new Counter({
  name: 'lootgrid_market_listing_refusals_total',
  help: 'Listings refused, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const marketBids = new Counter({
  name: 'lootgrid_market_bids_total',
  help: 'Bids placed below an ask',
  registers: [registry],
});

/** `delivered` is a completed trade; `mismatch` is money escrowed for something we did not quote. */
export const marketTrades = new Counter({
  name: 'lootgrid_market_trades_total',
  help: 'Trade outcomes',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const marketTradePriceCents = new Histogram({
  name: 'lootgrid_market_trade_price_cents',
  help: 'What hints actually sell for',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

export const marketRealisedRakeBps = new Gauge({
  name: 'lootgrid_market_realised_rake_bps',
  help: 'Rake actually collected as a fraction of volume, per zone',
  labelNames: ['zone'] as const,
  registers: [registry],
});

// ---- player agents ----
//
// Phase 7 puts a model in charge of a wallet. These are how that stays
// observable: what agents are doing, how often the model fails to produce a
// legal move, and how much thinking is being billed.

export const agentMoves = new Counter({
  name: 'lootgrid_agent_moves_total',
  help: 'Agent moves by game and where the move came from',
  labelNames: ['game', 'source'] as const,
  registers: [registry],
});

/**
 * Responses that did not parse into a legal move, per model.
 *
 * **Architecture §7 asks for this specifically, and calls a regression an
 * incident.** A model that starts failing the schema is a model about to cost
 * money for nothing: every violation is a call that was billed and produced a
 * fallback move the server could have computed for free.
 */
export const agentSchemaViolations = new Counter({
  name: 'lootgrid_agent_schema_violations_total',
  help: 'Model responses that were not a legal move',
  labelNames: ['model', 'reason'] as const,
  registers: [registry],
});

export const agentInferenceFailures = new Counter({
  name: 'lootgrid_agent_inference_failures_total',
  help: 'Inference calls that did not return usable text',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Mills billed to agents. Cost of goods sold against the same deposits. */
export const agentSeatsSold = new Counter({
  name: 'lootgrid_agent_seats_sold_total',
  help: 'Funded agent seats sold',
  registers: [registry],
});

export const agentInferenceMills = new Counter({
  name: 'lootgrid_agent_inference_mills_total',
  help: 'Inference spend metered to agents, in mills',
  registers: [registry],
});

/** Turns refused before a call was made — the budget doing its job. */
export const agentBudgetRefusals = new Counter({
  name: 'lootgrid_agent_budget_refusals_total',
  help: 'Agent actions refused by a budget check',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Turns the driver actually drove. Zero means agents are not playing at all. */
export const agentTurns = new Counter({
  name: 'lootgrid_agent_turns_total',
  help: 'Turns submitted to the referee by the driver',
  labelNames: ['source'] as const,
  registers: [registry],
});

export const agentEntries = new Counter({
  name: 'lootgrid_agent_entries_total',
  help: 'Hunts entered by an agent on its owner\'s behalf',
  registers: [registry],
});

export const agentHintPurchases = new Counter({
  name: 'lootgrid_agent_hint_purchases_total',
  help: 'Hint trades funded from a vault',
  registers: [registry],
});

// ---- reputation ----
//
// Phase 9 asks whether trust scales past players who already know each other.
// `reputationRefusals` against `agentHintPurchases` is the answer: refusals near
// zero mean the threshold is decorative, refusals near everything mean the
// market has closed to newcomers.

export const reputationFeedback = new Counter({
  name: 'lootgrid_reputation_feedback_total',
  help: 'Feedback transactions prepared for players to send',
  registers: [registry],
});

export const reputationRefusals = new Counter({
  name: 'lootgrid_reputation_refusals_total',
  help: 'Trades refused because a counterparty fell below the trust threshold',
  registers: [registry],
});

/** A registry outage must read as "unrated", never as "untrusted". */
export const reputationReadFailures = new Counter({
  name: 'lootgrid_reputation_read_failures_total',
  help: 'ERC-8004 summary reads that failed',
  registers: [registry],
});

/** Queue depth in the shared runtime. One busy tenant must not starve a hunt. */
/**
 * Tokens the provider actually charged for.
 *
 * The reconciliation against `budget.CALL_MILLS`, which is a fixed estimate
 * because the budget must be checked BEFORE a call. Under house-funded tokens
 * this is the difference between a seat that is profitable and one that is
 * quietly subsidised — and a fixed estimate cannot notice a prompt that grew.
 *
 * Compare `sum(rate(lootgrid_inference_tokens_total)) * price` against the
 * provider's invoice. A gap means the estimate needs re-deriving, not that the
 * cap needs raising.
 */
export const inferenceTokens = new Counter({
  name: 'lootgrid_inference_tokens_total',
  help: 'Tokens billed by the provider, by direction',
  labelNames: ['direction', 'model'],
  registers: [registry],
});

/**
 * Ticks where an agent had nothing to do and so cost no network.
 *
 * The scaling metric. Against `agent_ticks_total` it says what fraction of the
 * sweep is free — and because an idle tick skips the chain read, this is
 * directly the RPC calls NOT made. If it falls toward zero the sweep is doing
 * real work every pass and the tick interval, not the concurrency, is what
 * needs revisiting.
 */
/**
 * Ticks an agent sat out for temperament rather than for lack of work.
 *
 * Distinct from `agentTicksIdle` on purpose: idle means nothing to do, held
 * means something to do and a persona not ready to start it yet. They look
 * identical from outside the process and mean opposite things — one is a quiet
 * board, the other is the pacing working.
 */
/**
 * How long a turn sat in the queue before a provider slot opened.
 *
 * THE metric for sizing `runtime.MAX_IN_FLIGHT`, and the one whose absence made
 * the ceiling something you discovered from a queue that had stopped draining.
 * Buckets run past ten seconds on purpose: the interesting readings are the ones
 * approaching a turn deadline, and a histogram that topped out at two seconds
 * would report every disaster as "at least two".
 */
export const agentQueueWaitSeconds = new Histogram({
  name: 'lootgrid_agent_queue_wait_seconds',
  help: 'Time a turn waited for an inference slot — alert on the upper percentiles',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Ticks where an agent looked at viable hunts and took none.
 *
 * The opportunism signal. Zero forever means `initiative.APPETITE` is doing
 * nothing and agents are still taking whatever is in front of them; near-100%
 * means the bar is too high and the zone looks abandoned. Both are bugs, and
 * neither is visible from the entry counter alone.
 */
export const agentEntriesDeclined = new Counter({
  name: 'lootgrid_agent_entries_declined_total',
  help: 'Ticks where viable hunts existed but none cleared the agent’s appetite',
  registers: [registry],
});

export const agentTicksHeld = new Counter({
  name: 'lootgrid_agent_ticks_held_total',
  help: 'Ticks where an agent had work but its persona was pacing itself',
  registers: [registry],
});

export const agentTicksIdle = new Counter({
  name: 'lootgrid_agent_ticks_idle_total',
  help: 'Agent ticks that returned before reading the chain',
  registers: [registry],
});

export const agentTicksTotal = new Counter({
  name: 'lootgrid_agent_ticks_total',
  help: 'Agent ticks attempted',
  registers: [registry],
});

/** Wall time for one full sweep. If this approaches TICK_MS, passes get skipped. */
export const agentSweepSeconds = new Histogram({
  name: 'lootgrid_agent_sweep_seconds',
  help: 'Wall time of one full agent sweep',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

/**
 * Sweeps skipped because the previous one was still running.
 *
 * `tick()` opens with `if (ticking) return`, so an overrun does not queue — it
 * SKIPS, and the only symptom is agents being served less often. A silent
 * `return` is the worst shape a degradation can have, so it is counted.
 */
export const agentSweepSkipped = new Counter({
  name: 'lootgrid_agent_sweep_skipped_total',
  help: 'Sweeps skipped because the previous one had not finished',
  registers: [registry],
});

export const agentQueueDepth = new Gauge({
  name: 'lootgrid_agent_queue_depth',
  help: 'Turns waiting in the multi-tenant inference pool',
  registers: [registry],
});

// ---- agent to agent ----
//
// A rising `a2aDropped{reason="inbox_full"}` is the signal worth alerting on:
// it means somebody is flooding, and the per-sender quota is doing its job.

export const a2aMessages = new Counter({
  name: 'lootgrid_a2a_messages_total',
  help: 'Messages delivered between agents, by intent',
  labelNames: ['intent'] as const,
  registers: [registry],
});

export const a2aDropped = new Counter({
  name: 'lootgrid_a2a_dropped_total',
  help: 'Messages refused at the mailbox, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const a2aDeals = new Counter({
  name: 'lootgrid_a2a_deals_total',
  help: 'Negotiations that ended in an agreed price or a walk-away',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// ---- seller validation ----
//
// `sellerVerdicts{reason="slashable"}` staying at zero while the market grows is
// the mechanism reporting that nobody is rigging their sales — or that the
// thresholds are too high to notice. The other reasons are what tell them apart.

export const sellerVerdicts = new Counter({
  name: 'lootgrid_seller_verdicts_total',
  help: 'Seller validation outcomes, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const sellerSlashClaims = new Counter({
  name: 'lootgrid_seller_slash_claims_total',
  help: 'Signed slash claims produced',
  registers: [registry],
});

// ---- the director ----
//
// Phase 8 asks whether live difficulty beats deterministic generation. The
// honest way to answer it is to watch how often the Director actually decides
// anything: a `fallback` share near 100% means the model is contributing
// nothing and the phase's answer is no.

export const directiveIssued = new Counter({
  name: 'lootgrid_directives_issued_total',
  help: 'Rounds issued, by whether the Director or the fallback chose them',
  labelNames: ['source'] as const,
  registers: [registry],
});

/**
 * Prefetches that produced nothing usable.
 *
 * `too_slow` is the one to watch against `directiveIssued{source="model"}`: it
 * is the pipeline losing its race, and it is the difference between a Director
 * that is live and one that is decorative.
 */
export const directiveDropped = new Counter({
  name: 'lootgrid_directives_dropped_total',
  help: 'Director answers discarded before being issued',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// ---- the living world ----
//
// The same question as the Director, asked per zone instead of per round: is the
// model contributing weather, or is every epoch the deterministic fallback? The
// `kind` label is here because a world model that only ever says `calm` is
// working and useless, and that is invisible in a bare issued/fallback ratio.

export const worldConditionIssued = new Counter({
  name: 'lootgrid_world_conditions_issued_total',
  help: 'Zone conditions issued, by source and kind',
  labelNames: ['source', 'kind'] as const,
  registers: [registry],
});

export const worldConditionDropped = new Counter({
  name: 'lootgrid_world_conditions_dropped_total',
  help: 'World answers discarded before being issued',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// ---- the treasury ----
//
// Phase 10 asks whether the economy can self-regulate. The band moving at all
// is the answer: a `prizeBandCents` that never leaves its starting value means
// inflow is not reaching the sizing, and the treasury is decorative.

export const prizeBandCents = new Gauge({
  name: 'lootgrid_prize_band_cents',
  help: 'The prize in force for each difficulty',
  labelNames: ['difficulty'] as const,
  registers: [registry],
});

export const treasuryProposals = new Counter({
  name: 'lootgrid_treasury_proposals_total',
  help: 'Allocation proposals the treasury agent made',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const authFailures = new Counter({
  name: 'lootgrid_auth_failures_total',
  help: 'Rejected authentication attempts by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'lootgrid_rate_limited_total',
  help: 'Requests rejected by a rate limiter',
  labelNames: ['bucket'] as const,
  registers: [registry],
});

export const activeAttempts = new Gauge({
  name: 'lootgrid_active_attempts',
  help: 'Attempts currently in flight',
  registers: [registry],
});

export const pendingDeadlines = new Gauge({
  name: 'lootgrid_pending_deadlines',
  help: 'Entries in the deadline wheel',
  registers: [registry],
});

// ---- on-chain relay ----
//
// The one to alert on is `relay_dead_total`. Everything else can lag without
// consequence — a dead row is a game event that will never reach the chain.

export const relayEnqueued = new Counter({
  name: 'lootgrid_relay_enqueued_total',
  help: 'Actions queued for on-chain publication',
  labelNames: ['kind'] as const,
  registers: [registry],
});

/** Idempotency working as designed. A steady low rate is healthy; a spike is not. */
export const relayDeduped = new Counter({
  name: 'lootgrid_relay_deduped_total',
  help: 'Enqueues rejected as duplicates',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const relayConfirmed = new Counter({
  name: 'lootgrid_relay_confirmed_total',
  help: 'Actions confirmed on chain',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const relayFailed = new Counter({
  name: 'lootgrid_relay_failed_total',
  help: 'Relay attempts that failed, by stage',
  labelNames: ['kind', 'reason'] as const,
  registers: [registry],
});

export const relayDead = new Counter({
  name: 'lootgrid_relay_dead_total',
  help: 'Actions abandoned after exhausting retries — alert on this',
  labelNames: ['kind'] as const,
  registers: [registry],
});

/** Sustained growth in `pending` means the relayer cannot keep up with play. */
export const relayQueueDepth = new Gauge({
  name: 'lootgrid_relay_queue_depth',
  help: 'Relay outbox rows by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export async function render(): Promise<string> {
  return registry.metrics();
}
