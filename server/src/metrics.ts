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
