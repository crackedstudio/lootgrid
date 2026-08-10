import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { LogController } from 'fastify';
import * as registry from './auth/registry';
import { startNoncePruner, stopNoncePruner } from './auth/verify';
import { closeDb, openDb } from './db/index';
import { corsOrigins, env, isProd } from './env';
import { registerRoutes } from './http';
import { logger } from './logger';
import * as metrics from './metrics';
import * as ratelimit from './ratelimit';
import * as referee from './referee';
import * as rooms from './rooms';
import * as store from './store';
import { attachWs } from './ws';

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true, // behind Caddy — needed for correct client IPs
  bodyLimit: 64 * 1024,
  // Per-request logging is noise in production (metrics cover it) but useful
  // locally. The top-level `disableRequestLogging` is deprecated in Fastify 5.
  logController: new LogController({ disableRequestLogging: isProd }),
});

await app.register(helmet, {
  // The API serves JSON to a wallet webview on another origin; a restrictive
  // CSP here would do nothing useful and CORP would break legitimate reads.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
});

await app.register(cors, {
  origin: corsOrigins(),
  credentials: false,
  allowedHeaders: ['content-type', 'x-player', 'x-timestamp', 'x-nonce', 'x-signature', 'authorization'],
  methods: ['GET', 'POST', 'OPTIONS'],
});

registerRoutes(app);

// ---- metrics wiring (kept out of the referee so it stays dependency-light) ----
referee.observers.onAttemptFinished = (attempt, outcome) => {
  metrics.attemptsFinished.inc({ game_type: attempt.gameType, outcome });
  if (outcome === 'failed' && attempt.failReason) {
    metrics.attemptFailures.inc({ game_type: attempt.gameType, reason: attempt.failReason });
  }
};
referee.observers.onHuntResolved = (_huntId, elapsedMs, racers) => {
  metrics.raceResolutions.inc();
  metrics.winnerElapsed.observe(elapsedMs);
  metrics.raceRacers.observe(racers);
};

// ---- boot ----
openDb();
store.bootstrap();
referee.start();
ratelimit.start();
startNoncePruner();

if (env.AUTH_MODE === 'chain') {
  const reachable = await registry.checkReachable();
  // Warn rather than exit: the RPC may just be flapping, and /ready already
  // reports unhealthy so a load balancer will hold traffic off until it recovers.
  if (!reachable) logger.warn('starting with an unreachable registry RPC — /ready will fail');
} else {
  logger.warn('AUTH_MODE=dev — every request is trusted. Never use this outside local work.');
}

await app.listen({ port: env.PORT, host: env.HOST });
const wss = attachWs(app.server);

logger.info(
  {
    port: env.PORT,
    authMode: env.AUTH_MODE,
    zones: store.listZones().length,
    db: env.DATABASE_PATH,
  },
  'lootgrid referee ready',
);

// ---- shutdown ----
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref?.();

  try {
    referee.stop();
    ratelimit.stop();
    stopNoncePruner();
    // Tell clients to reconnect rather than dropping them silently.
    for (const client of [...rooms.allClients()]) client.ws.close(1001, 'server shutting down');
    wss.close();
    await app.close();
    // Checkpoints the WAL, so a snapshot of DATABASE_PATH taken after this is
    // complete on its own.
    closeDb();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', err => {
  logger.error({ err }, 'unhandled rejection');
});
process.on('uncaughtException', err => {
  logger.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});
