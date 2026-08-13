import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from './appTypes';
import { canonicalHttp } from './auth/canonical';
import * as registry from './auth/registry';
import { verifyHttp, type Credentials } from './auth/verify';
import * as attestor from './chain/attestor';
import * as relayer from './chain/relayer';
import { GRID } from './config';
import { getDb } from './db/index';
import * as energy from './energy';
import { stdev } from './games/tap';
import { inBounds, tileType } from './grid';
import * as hints from './hints';
import { badRequest, conflict, forbidden, isAppError, notFound, toWireError, tooManyRequests, unauthorized } from './errors';
import { env, isProd } from './env';
import { logger } from './logger';
import * as metrics from './metrics';
import * as ratelimit from './ratelimit';
import * as referee from './referee';
import * as rooms from './rooms';
import * as store from './store';
import type { Player } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

// ---------------------------------------------------------------- validation

const zoneParams = z.object({ id: z.string().min(1).max(64) });
const tileParams = zoneParams.extend({
  r: z.coerce.number().int().min(0).max(GRID.rows - 1),
  c: z.coerce.number().int().min(0).max(GRID.cols - 1),
});
const idParams = z.object({ id: z.string().min(1).max(128) });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('invalid_request', 'request failed validation', result.error.flatten());
  }
  return result.data;
}

// ---------------------------------------------------------------- auth

function credentialsFrom(req: FastifyRequest): Credentials {
  const h = req.headers;
  const pick = (name: string) => {
    const v = h[name];
    return typeof v === 'string' ? v : '';
  };
  return {
    player: pick('x-player'),
    timestamp: Number(pick('x-timestamp')),
    nonce: pick('x-nonce'),
    signature: pick('x-signature'),
  };
}

async function requirePlayer(req: FastifyRequest): Promise<Player> {
  const creds = credentialsFrom(req);

  // Per-IP gate BEFORE any verification work. Signature recovery succeeds for
  // any well-formed signature over junk, and the chain read follows it, so
  // without this an unauthenticated peer can drive one RPC call per request.
  // The global bucket below is keyed on player.id, which does not exist until
  // auth succeeds — it can never rate-limit a failed attempt. ws.ts has carried
  // the equivalent throttle since it was written; HTTP did not.
  // Key is length-clamped: even with a correct trustProxy hop count, the bucket
  // key must never be an unbounded attacker-supplied string.
  limit(`preauth:${String(req.ip).slice(0, 45)}`, env.RATE_PREAUTH_PER_MIN, 60_000, 'preauth');

  try {
    const player = await verifyHttp(creds, {
      player: creds.player,
      method: req.method,
      // Sign the path including the query string — otherwise a captured
      // signature could be replayed with different filters.
      path: req.url,
      timestamp: creds.timestamp,
      nonce: creds.nonce,
      body: req.rawBody ?? null,
    });

    // A global bucket per identity, so one account cannot monopolise the box
    // no matter which mix of endpoints it hits.
    limit(`global:${player.id}`, env.RATE_GLOBAL_PER_MIN, 60_000, 'global');
    return player;
  } catch (err) {
    if (isAppError(err) && err.statusCode === 401) {
      metrics.authFailures.inc({ reason: err.code });
    }
    throw err;
  }
}

function limit(key: string, max: number, windowMs: number, bucket: string): void {
  const decision = ratelimit.consume(key, max, windowMs);
  if (!decision.ok) {
    metrics.rateLimited.inc({ bucket });
    throw tooManyRequests('rate_limited', `retry in ${Math.ceil(decision.retryAfterMs / 1000)}s`);
  }
}

// ---------------------------------------------------------------- routes

export function registerRoutes(app: App): void {
  // Capture the raw body: the signature covers exactly the bytes sent, and
  // re-serialising the parsed object would not reproduce them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(badRequest('invalid_json'), undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toWireError(err);
    if (status >= 500) logger.error({ err, url: req.url }, 'request failed');
    else logger.debug({ err: (err as Error).message, url: req.url }, 'request rejected');
    reply.code(status).send(body);
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    metrics.httpRequests.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  // ---- liveness / readiness ----

  // Liveness: is the process up? No dependencies, so a slow disk cannot cause
  // an orchestrator to kill a server that is merely busy.
  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = { db: false, registry: true };
    try {
      getDb().prepare('SELECT 1').get();
      checks.db = true;
    } catch (err) {
      logger.error({ err }, 'readiness: db check failed');
    }
    if (env.AUTH_MODE === 'chain') checks.registry = await registry.checkReachable();

    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  if (env.METRICS_ENABLED) {
    app.get('/metrics', async (req, reply) => {
      if (env.METRICS_TOKEN) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${env.METRICS_TOKEN}`) throw unauthorized('bad_metrics_token');
      }
      metrics.activeAttempts.set(store.liveAttemptCount());
      metrics.pendingDeadlines.set(referee.pendingDeadlines());
      metrics.wsConnections.set(rooms.connectionCount());
      reply.header('content-type', metrics.registry.contentType);
      return metrics.render();
    });
  }

  // ---- player ----

  app.get('/me', async req => {
    const player = await requirePlayer(req);
    return {
      playerId: player.id,
      handle: player.handle,
      energy: energy.view(player, Date.now()),
      trustScore: player.trustScore,
    };
  });

  // ---- world ----

  app.get('/zones', async () => ({
    zones: store.listZones().map(z => ({
      id: z.id,
      name: z.name,
      accent: z.accent,
      // Who plays here. The client uses it to route between the reflex UI and
      // the agent UI; it is not a secret.
      kind: z.kind,
      epoch: z.epoch,
      // Published up front; the secret is revealed when the epoch rotates, so
      // the map can be proved to have been fixed in advance.
      seedCommit: z.seedCommit,
      hunts: store.liveHuntsIn(z).length,
    })),
  }));

  app.get('/zones/:id/grid', async req => {
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');

    return {
      cols: GRID.cols,
      rows: GRID.rows,
      epoch: zone.epoch,
      // Only what has actually been uncovered. Everything else is absent and
      // the client renders fog — the map itself never leaves the server.
      reveals: store.revealsFor(zone),
      hunts: store.liveHuntsIn(zone).map(h => ({
        id: h.id,
        r: h.r,
        c: h.c,
        kind: h.kind,
        prizeLabel: h.prizeLabel,
        status: h.status,
        chasers: store.chaserCount(h.id),
      })),
    };
  });

  app.post('/zones/:id/tiles/:r/:c/open', async req => {
    const player = await requirePlayer(req);
    const { id, r, c } = parse(tileParams, req.params);
    limit(`tile:${player.id}`, env.RATE_TILE_PER_MIN, 60_000, 'tile');

    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    if (!inBounds(r, c, GRID.rows, GRID.cols)) throw badRequest('out_of_bounds');

    const now = Date.now();

    if (store.huntAt(zone, r, c)) throw conflict('is_hunt', 'open this one from the hunt sheet');

    const existing = store.getReveal(zone, r, c);
    if (existing) return { cell: existing, energy: energy.view(player, now), alreadyOpen: true };

    const spent = energy.spend(player, 1, now);
    if (!spent.ok) throw conflict('insufficient_energy', 'out of energy', spent.energy);
    store.savePlayerEnergy(player);

    const cell = { r, c, type: tileType(zone, r, c), byHandle: player.handle, at: now };
    const won = store.addReveal(zone, { ...cell, playerId: player.id });

    if (!won) {
      // Someone opened it between our read and our write — give the energy back.
      const refunded = energy.refund(player, 1, now);
      store.savePlayerEnergy(player);
      return { cell: store.getReveal(zone, r, c), energy: refunded, alreadyOpen: true };
    }

    metrics.tilesRevealed.inc({ type: cell.type });

    // Published after the reveal is committed, never before: the chain records
    // what happened, and a relay failure must not undo a tile the player has
    // already paid energy for. The dedupe key is the reveal's own primary key.
    relayer.enqueue('reveal', `reveal:${zone.id}:${zone.epoch}:${r}:${c}`, {
      player: player.id as `0x${string}`,
      zoneId: relayer.toBytes32Id(zone.id),
      epoch: zone.epoch,
      r,
      c,
      tileType: relayer.tileTypeCode(cell.type),
    });

    // Awarded after the reveal is committed, and never allowed to throw: the
    // player has already paid energy for this tile, so a hint that fails to
    // generate is a missing bonus rather than a failed request.
    const hint = hints.awardForReveal(
      zone.seedSecret,
      player.id,
      r,
      c,
      store.liveHuntsIn(zone),
      now,
    );

    rooms.broadcast(rooms.zoneRoom(zone.id), { t: 'tile:revealed', ...cell });
    return { cell, energy: spent.energy, hint };
  });

  /**
   * The player's unexpired hints.
   *
   * There is deliberately no `POST /hints/:id/apply`: applying a hint is a
   * client-side view filter over `cellMatches`, and an endpoint that mutates
   * nothing would be noise. What phase 1 actually needs to learn — whether hints
   * change where people dig — is answered by the `hints_awarded` and
   * `hunts_found{hinted=}` counters instead.
   */
  app.get('/hints', async req => {
    const player = await requirePlayer(req);
    return { hints: hints.forPlayer(player.id) };
  });

  // ---- hunts ----

  app.get('/hunts/:id', async req => {
    const { id } = parse(idParams, req.params);
    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');
    return {
      id: hunt.id,
      zoneId: hunt.zoneId,
      r: hunt.r,
      c: hunt.c,
      kind: hunt.kind,
      difficulty: hunt.difficulty,
      prizeLabel: hunt.prizeLabel,
      status: hunt.status,
      chasers: store.chaserCount(hunt.id),
      expiresAt: hunt.expiresAt,
    };
  });

  app.post('/hunts/:id/attempts', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    limit(`attempt:${player.id}`, env.RATE_ATTEMPT_PER_MIN, 60_000, 'attempt');

    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');

    const result = referee.openAttempt(player, hunt);
    if (!result.ok) throw conflict(result.error);

    return {
      attemptId: result.attempt.id,
      gameType: result.gameType,
      spec: result.spec,
      limitMs: result.limitMs,
      startedAt: result.attempt.startedAt,
      energy: energy.view(player, Date.now()),
    };
  });

  /** Resume after a reconnect — the attempt kept running without you. */
  app.get('/attempts/:id', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    const attempt = store.getAttempt(id);
    if (!attempt) throw notFound('no_such_attempt');
    if (attempt.playerId !== player.id) throw forbidden('not_your_attempt');

    return {
      id: attempt.id,
      huntId: attempt.huntId,
      gameType: attempt.gameType,
      status: attempt.status,
      progress: attempt.progress,
      lastSeq: attempt.lastSeq,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      remainingMs: Math.max(0, attempt.deadlineAt - Date.now()),
      failReason: attempt.failReason,
    };
  });

  // ---- self-published records ----
  //
  // These hand the caller a referee-signed EIP-712 attestation which they submit
  // themselves, paying their own gas. Nothing here writes game state: an
  // attestation only restates a decision the referee already made, so a player
  // who never calls these — or whose transaction never lands — has lost nothing
  // but a public record.

  /**
   * Attestation for the caller's own entry in a hunt.
   *
   * Scoped to the authenticated player: the referee will not sign a claim that
   * someone else entered, even though the contract would accept whoever pays.
   */
  app.post('/hunts/:id/attestations/entry', async req => {
    if (!attestor.enabled()) throw notFound('attestations_disabled');

    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);

    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');

    const attempt = store.attemptOf(hunt.id, player.id);
    if (!attempt) throw forbidden('not_in_this_hunt');

    return attestor.signEntry(
      player.id as `0x${string}`,
      attestor.toBytes32Id(hunt.id),
      relayer.gameTypeCode(attempt.gameType),
    );
  });

  /**
   * Attestation for a win. Only the winner of a resolved hunt gets one, and the
   * numbers come from the referee's record rather than from the request.
   */
  app.post('/hunts/:id/attestations/resolution', async req => {
    if (!attestor.enabled()) throw notFound('attestations_disabled');

    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);

    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');
    if (hunt.status !== 'resolved' || !hunt.winnerId) throw conflict('hunt_not_resolved');
    if (hunt.winnerId !== player.id) throw forbidden('not_the_winner');

    const attempt = store.attemptOf(hunt.id, player.id);
    if (!attempt) throw conflict('no_winning_attempt');

    return attestor.signResolution(
      player.id as `0x${string}`,
      attestor.toBytes32Id(hunt.id),
      attempt.elapsedMs ?? 0,
      // Total entrants, not live chasers — the race is over by now.
      store.racerCount(hunt.id),
    );
  });

  // ---- audit ----

  /** Revealed seeds for finished epochs: anyone can recompute the old map. */
  app.get('/audit/zones/:id', async req => {
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    return {
      zoneId: zone.id,
      currentEpoch: zone.epoch,
      currentCommit: zone.seedCommit,
      revealed: store.seedHistory(zone.id),
    };
  });

  // ---- instrumentation ----

  // Exposes per-attempt timing distributions, so it is gated exactly like
  // /metrics rather than left open.
  const debugGuard = async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!isProd) return;
    if (!env.METRICS_TOKEN) throw notFound('not_found');
    if (req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) throw notFound('not_found');
  };

  app.get('/debug/attempts/:id', { preHandler: debugGuard }, async req => {
    const { id } = parse(idParams, req.params);
    const a = store.getAttempt(id);
    if (!a) throw notFound('no_such_attempt');
    return {
      id: a.id,
      hunt: a.huntId,
      handle: a.handle,
      gameType: a.gameType,
      status: a.status,
      failReason: a.failReason,
      elapsedMs: a.elapsedMs,
      progress: a.progress,
      maxClockSkewMs: a.maxClockSkewMs,
      intervals: a.intervals,
      sigma: Number(stdev(a.intervals).toFixed(2)),
      distinctIntervals: new Set(a.intervals).size,
      events: a.events.length,
    };
  });

  app.get('/debug/hunts/:id', { preHandler: debugGuard }, async req => {
    const { id } = parse(idParams, req.params);
    const h = store.getHunt(id);
    if (!h) throw notFound('no_such_hunt');
    return {
      hunt: { id: h.id, zone: h.zoneId, r: h.r, c: h.c, status: h.status, winnerId: h.winnerId },
      gameType: store.blockGame(h).type,
      attempts: store.attemptsFor(h.id).map(a => ({
        handle: a.handle,
        status: a.status,
        elapsedMs: a.elapsedMs,
        sigma: Number(stdev(a.intervals).toFixed(2)),
        failReason: a.failReason,
      })),
    };
  });
}

/** Exported for tests, which build canonical strings the same way clients do. */
export { canonicalHttp };
