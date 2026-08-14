import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from './appTypes';
import { canonicalHttp } from './auth/canonical';
import * as registry from './auth/registry';
import { verifyHttp, type Credentials } from './auth/verify';
import * as agents from './agents';
import * as director from './director';
import * as attestor from './chain/attestor';
import * as escrowChain from './chain/escrow';
import * as relayer from './chain/relayer';
import { GRID } from './config';
import { getDb } from './db/index';
import * as energy from './energy';
import { stdev } from './games/tap';
import { inBounds, tileType } from './grid';
import * as hints from './hints';
import * as hintStats from './hints/stats';
import * as market from './market';
import { quoteEntry } from './payments/fees';
import * as x402 from './payments/x402';
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
const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed address');

// Prices are whole cents, always. A float here would be a rounding error with a
// wallet attached — see prizes.ts.
const centsField = z.number().int().min(1).max(100_000);
const listingBody = z.object({ hintId: z.string().min(1).max(128), askCents: centsField });
const priceBody = z.object({ priceCents: centsField });
const browseQuery = z.object({
  zoneId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('invalid_request', 'request failed validation', result.error.flatten());
  }
  return result.data;
}

// ---------------------------------------------------------------- auth

/** A single header value, or null. Headers may arrive as arrays. */
function headerOrNull(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

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
        // Drawn from the salt at creation. Surfaced because it now decides the
        // prize, the entry fee AND how hard the block's game generates — a
        // player choosing between two hunts is choosing between those.
        difficulty: h.difficulty,
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

  app.post('/hunts/:id/attempts', async (req, reply) => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    limit(`attempt:${player.id}`, env.RATE_ATTEMPT_PER_MIN, 60_000, 'attempt');

    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');

    // Entry gate. Energy is the free route and is tried first: a player who has
    // it never sees a payment prompt, which keeps a no-cost path to every prize.
    // Only when energy is exhausted does a fee apply, and only if fees are on at
    // all — ENTRY_FEES_ENABLED is false by default and legally gated.
    const zone = store.getZone(hunt.zoneId);
    const quote = quoteEntry(
      hunt.difficulty,
      zone?.kind ?? 'human',
      store.chaserCount(hunt.id),
      energy.currentEnergy(player, Date.now()) > 0,
    );

    metrics.entryEvRatio.set(
      { zone: hunt.zoneId, difficulty: hunt.difficulty },
      Number.isFinite(quote.evRatio) ? quote.evRatio : 0,
    );

    if (x402.enabled() && quote.feeCents > 0 && !quote.freeEntryAvailable) {
      const terms = x402.termsFor(hunt.id, quote.feeCents);
      const settled = await x402.settleEntry(terms, headerOrNull(req, 'x-payment'));
      if (!settled.ok) {
        // 402 with the terms attached is what the protocol expects; the client
        // signs and retries against the same URL. The challenge is built for
        // the *authenticated* player, so a signed authorisation can only ever
        // spend the balance of whoever asked for it.
        const challenge = x402.challengeFor(terms, player.id as `0x${string}`);
        return reply.code(402).send(x402.paymentRequiredBody(terms, challenge));
      }
      metrics.entriesPaid.inc();
    } else if (quote.freeEntryAvailable) {
      metrics.entriesFree.inc();
    }

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

  /**
   * Attestation for a prize, against LootGridEscrow.
   *
   * The same `Resolution` fields as the record above, signed under the escrow's
   * own domain with the payout key — so a signature minted to write a public log
   * cannot move money, and the two keys can be protected differently.
   *
   * Nothing is paid here. The response carries `claim` calldata the winner sends
   * themselves, and `withdraw` calldata for afterwards: the escrow credits on
   * claim and pays on withdraw, with the challenge window in between. Both are
   * permissionless and both always pay the winner the referee named, so a player
   * with an empty wallet can have either sent for them.
   */
  app.post('/hunts/:id/attestations/payout', async req => {
    if (!attestor.escrowEnabled()) throw notFound('payouts_disabled');

    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);

    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');
    if (hunt.status !== 'resolved' || !hunt.winnerId) throw conflict('hunt_not_resolved');
    // Scoped to the winner even though the contract would accept whoever pays
    // the gas. The referee will not sign a claim it did not decide.
    if (hunt.winnerId !== player.id) throw forbidden('not_the_winner');

    const attempt = store.attemptOf(hunt.id, player.id);
    if (!attempt) throw conflict('no_winning_attempt');

    return attestor.signPayout(
      player.id as `0x${string}`,
      attestor.toBytes32Id(hunt.id),
      attempt.elapsedMs ?? 0,
      store.racerCount(hunt.id),
    );
  });

  /**
   * What the escrow owes the caller, read from the chain.
   *
   * The server issued the attestation but never saw the transaction, so only the
   * contract knows whether a claim actually landed. A UI that assumed would tell
   * a player their prize was ready when it was not.
   */
  app.get('/escrow/balance', async req => {
    const player = await requirePlayer(req);
    if (!escrowChain.readable()) throw notFound('payouts_disabled');

    const balance = await escrowChain.readBalance(player.id as `0x${string}`);
    const nowSec = Math.floor(Date.now() / 1000);

    return {
      // A decimal string: base units of an 18dp token exceed Number's safe range.
      owed: balance.owed.toString(),
      withdrawableAt: balance.withdrawableAt,
      withdrawable: balance.owed > 0n && nowSec >= balance.withdrawableAt,
      call: attestor.withdrawCall(player.id as `0x${string}`),
    };
  });

  // ---- player agents ----
  //
  // Every state change that matters is a transaction the PLAYER signs. The
  // server derives the agent key, proves it consents, encodes calldata and reads
  // results back — but binding, funding, capping and revoking are all theirs.
  // That is what makes "the house cannot spend your money" a property rather
  // than a promise.

  app.get('/agent', async req => {
    const player = await requirePlayer(req);
    return { agent: agents.ensure(player) };
  });

  /**
   * The two transactions that bring an agent to life: bind it as a session key,
   * then create the vault naming it as spender. Returned together so the UI can
   * show the whole commitment before any of it is made.
   */
  app.post('/agent/setup', async req => {
    const player = await requirePlayer(req);
    limit(`agent:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'agent');
    return await agents.setupOffer(player);
  });

  /** Record the vault once the player's transaction has landed. */
  app.post('/agent/vault', async req => {
    const player = await requirePlayer(req);
    const { vault } = parse(z.object({ vault: hexAddress }), req.body);
    return { agent: agents.attachVault(player, vault as `0x${string}`) };
  });

  app.put('/agent/config', async req => {
    const player = await requirePlayer(req);
    limit(`agent:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'agent');
    return { agent: agents.configure(player, req.body) };
  });

  /**
   * Stop the agent.
   *
   * The server refuses its next turn immediately, but the row is NOT the kill
   * switch — the returned call is, and until the player sends it the agent still
   * holds on-chain spending rights the server cannot revoke.
   */
  app.post('/agent/kill', async req => {
    const player = await requirePlayer(req);
    return agents.killOffer(player);
  });

  app.post('/agent/resume', async req => {
    const player = await requirePlayer(req);
    return { agent: agents.resume(player) };
  });

  /** Owner-only vault transactions, encoded here and sent by the player. */
  app.post('/agent/vault/:action', async req => {
    const player = await requirePlayer(req);
    const { action } = parse(
      z.object({ action: z.enum(['withdrawAll', 'setCaps', 'setTarget']) }),
      req.params,
    );
    const args = parse(
      z
        .object({
          perTxCents: z.number().int().min(1).max(100_000).optional(),
          perDayCents: z.number().int().min(1).max(1_000_000).optional(),
          target: hexAddress.optional(),
          allowed: z.boolean().optional(),
        })
        .optional(),
      req.body ?? {},
    );
    return {
      call: agents.vaultCallFor(player, action, {
        ...args,
        target: args?.target as `0x${string}` | undefined,
      }),
    };
  });

  app.get('/agent/ledger', async req => {
    const player = await requirePlayer(req);
    return agents.ledger(player);
  });

  // ---- the hint market ----
  //
  // The server never holds a buyer's money here. It vouches for what is being
  // sold, hands back the transaction the buyer sends themselves, and grants the
  // hint once HintEscrow says the payment settled. Every route below is either
  // a database write about intent or a read of the chain — none of them move
  // funds, which is what keeps a compromised server unable to steal a trade.

  app.get('/market/listings', async req => {
    const { zoneId, limit } = parse(browseQuery, req.query);
    // Public: an order book only participants can read is not a market, and the
    // listing view deliberately cannot carry a hint's payload.
    return { listings: market.browse(zoneId ?? null, limit) };
  });

  app.post('/market/listings', async req => {
    const player = await requirePlayer(req);
    const { hintId, askCents } = parse(listingBody, req.body);
    limit(`market:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'market');
    return { listing: market.list(player, hintId, askCents) };
  });

  app.get('/market/listings/mine', async req => {
    const player = await requirePlayer(req);
    return { listings: market.myListings(player) };
  });

  app.delete('/market/listings/:id', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    market.cancel(player, id);
    return { ok: true };
  });

  /** The book for one listing. Seller only — see `market.bidsFor`. */
  app.get('/market/listings/:id/bids', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    return { bids: market.bidsFor(player, id) };
  });

  app.post('/market/listings/:id/bids', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    const { priceCents } = parse(priceBody, req.body);
    limit(`market:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'market');
    return { bid: market.bid(player, id, priceCents) };
  });

  app.delete('/market/bids/:id', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    market.withdrawBid(player, id);
    return { ok: true };
  });

  /** Seller accepts a bid, which quotes the *bidder* — it does not move money. */
  app.post('/market/bids/:id/accept', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    limit(`market:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'market');
    return { quote: await market.acceptBid(player, id) };
  });

  /**
   * Take a listing at its ask.
   *
   * Returns a quote, not a purchase: the buyer still has to escrow the money
   * themselves with the calldata attached. Nothing is owed until they do, and
   * nothing is delivered until the contract says it settled.
   */
  app.post('/market/listings/:id/buy', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    limit(`market:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'market');
    return { quote: await market.buy(player, id) };
  });

  app.get('/market/trades', async req => {
    const player = await requirePlayer(req);
    return { trades: market.myTrades(player) };
  });

  /**
   * Bring a trade up to date with the chain.
   *
   * The buyer polls this after funding: it reads HintEscrow, hands back a
   * release attestation once the money is there, and delivers the hint once the
   * release has actually settled. Idempotent — the hint is granted once however
   * often either party asks.
   */
  app.post('/market/trades/:id/sync', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(idParams, req.params);
    limit(`market:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'market');
    return { trade: await market.sync(player, id) };
  });

  /**
   * Rake as it actually landed, per zone. Unauthenticated, like the other audit
   * surfaces: a fee whose size players have to take on trust is worse than one
   * they can check.
   */
  app.get('/market/stats', async () => ({ zones: market.rakeStats() }));

  // ---- audit ----

  /** Revealed seeds for finished epochs: anyone can recompute the old map. */
  /**
   * Hint honesty, in public.
   *
   * Live hunts show a commitment and nothing else. Finished ones show the whole
   * set — truth flags included — plus the salt, so anyone can regenerate it and
   * confirm it matches what was published before the hunt opened.
   *
   * Unauthenticated on purpose, exactly like `/audit/zones/:id`. A guarantee only
   * players can check is a weaker guarantee than one anybody can.
   */
  app.get('/audit/hints/:id', async req => {
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    return hintStats.auditZone(zone.id);
  });

  /**
   * A hunt's directive transcript, and the signed head.
   *
   * Unauthenticated on purpose, like every other audit surface: a guarantee only
   * players can check is weaker than one anybody can. The response carries
   * everything needed to recompute the chain independently — the salt is
   * included only once the hunt is over, for the same reason it always is.
   */
  app.get('/audit/transcript/:id', async req => {
    const { id } = parse(idParams, req.params);
    const hunt = store.getHunt(id);
    if (!hunt) throw notFound('no_such_hunt');

    const transcript = director.transcriptOf(hunt.id);
    if (!transcript) throw notFound('not_directed');

    const settled = hunt.status === 'resolved' || hunt.status === 'expired';
    return {
      huntId: hunt.id,
      // Withheld while the hunt is live: it is the same secret the cell
      // commitment rests on, and publishing it early would hand over the map.
      salt: settled ? hunt.salt : null,
      chainHead: transcript.chainHead,
      rounds: transcript.length,
      entries: transcript.list(),
      // Signed at resolution, so the head cannot be revised afterwards. Absent
      // until then, and absent entirely when attestations are switched off.
      attestation:
        settled && attestor.enabled()
          ? await attestor.signTranscript(
              attestor.toBytes32Id(hunt.id),
              transcript.chainHead,
              transcript.length,
            )
          : null,
      /**
       * What this proves, stated rather than implied: the rounds were not chosen
       * differently per player and were not rewritten after the fact. NOT that
       * they were fair — a live Director trades that away, and the chain is the
       * replacement, not an equivalent.
       */
      proves: 'one version of events, identical for every racer',
    };
  });

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
