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
