import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { LogController } from 'fastify';
import * as registry from './auth/registry';
import { startNoncePruner, stopNoncePruner } from './auth/verify';
import * as attestor from './chain/attestor';
import * as escrowWorker from './chain/escrow';
import * as relayer from './chain/relayer';
import { closeDb, openDb } from './db/index';
import { corsOrigins, env, isProd } from './env';
import { registerRoutes } from './http';
import * as funnel from './funnel';
import { wireObservers } from './observability';
import { logger } from './logger';
import * as hints from './hints';
import * as metrics from './metrics';
import * as agentDriver from './agents/driver';
import * as puzzleAuthor from './games/author';
import * as x402 from './payments/x402';
import * as ratelimit from './ratelimit';
import * as referee from './referee';
import * as rooms from './rooms';
import * as store from './store';
import { attachWs } from './ws';

const app = Fastify({
  loggerInstance: logger,
  // A hop COUNT, never `true`. With `true`, Fastify takes the leftmost
  // X-Forwarded-For entry, which is written by the client — every per-IP rate
  // limit would then be keyed on a value the attacker rotates at will.
  trustProxy: env.TRUST_PROXY_HOPS === 0 ? false : env.TRUST_PROXY_HOPS,
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
  // DELETE is for the market's cancel routes, PUT for the agent config. A
  // method missing from this list fails at the browser's preflight, so it
  // looks like a network error rather than a CORS one — and only in production,
  // where CORS_ORIGINS is explicit.
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

registerRoutes(app);

// Observers live in observability.ts so they can be exercised by tests — see
// the note there. Wired before boot, so nothing can run unobserved.
wireObservers();

// ---- boot ----
openDb();
store.bootstrap();
referee.start();
// Put resumed attempts' deadlines back in the wheel. Only the agent games can
// be here — see migrations/008.
referee.resume(store.takeRecovered());
ratelimit.start();
// Sweeps the binding cache and subscribes to on-chain key rotations, so a
// revocation takes effect on the next request rather than the next minute.
registry.start();
// Drains the on-chain outbox. A no-op unless RELAY_ENABLED=true.
relayer.start();
// Funds prize pots. A no-op unless ESCROW_FUNDING_ENABLED=true; hunts open
// either way, they simply carry no money until a pot lands.
escrowWorker.start();
startNoncePruner();
// The five funnel numbers. Two of them are cohort aggregates that cannot be
// accumulated as they happen, so they are recomputed on a timer — see funnel.ts.
funnel.start();
// Enters hunts and takes turns for players who have an agent. A no-op unless
// AGENTS_ENABLED=true — and until this existed, every other agent module was a
// capability nothing ever called.
agentDriver.start();
// Asks a model to design each block's puzzle, a few at a time, in the
// background. A no-op unless inference is configured — and every hunt is fully
// playable without it, on the recipe its own salt implies.
puzzleAuthor.start();

if (x402.enabled()) {
  // The one thing no test can establish offline: whether the token's real
  // EIP-712 domain matches what we sign against. Get it wrong and every payment
  // is rejected with nothing in our logs to explain it — so ask the token now,
  // at boot, rather than discovering it from a player.
  const domain = await x402.checkTokenDomain();
  if (!domain.ok) {
    logger.error({ domain }, 'entry fees are ON but the token domain does not check out');
  }
} else {
  logger.info({ why: x402.disabledReason() }, 'entry fees are off');
}

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
    registry.stop();
    relayer.stop();
    escrowWorker.stop();
    agentDriver.stop();
    stopNoncePruner();
    funnel.stop();
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
