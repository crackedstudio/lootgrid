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

export async function render(): Promise<string> {
  return registry.metrics();
}
