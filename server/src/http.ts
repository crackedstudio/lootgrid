import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from './appTypes';
import { canonicalHttp } from './auth/canonical';
import * as registry from './auth/registry';
import { verifyHttp, type Credentials } from './auth/verify';
import * as agents from './agents';
import * as reputation from './agents/reputation';
import * as director from './director';
import * as attestor from './chain/attestor';
import * as escrowChain from './chain/escrow';
import * as relayer from './chain/relayer';
import { ENERGY, GRID, SURVEY, TILES } from './config';
import { getDb } from './db/index';
import * as energy from './energy';
import * as funnel from './funnel';
import * as keys from './keys';
import * as rank from './rank';
import { stdev } from './games/tap';
import { inBounds, tileType } from './grid';
import * as hints from './hints';
import * as hintStats from './hints/stats';
import * as market from './market';
import { quoteEntry } from './payments/fees';
import * as x402 from './payments/x402';
import * as seats from './agents/seats';
import { badRequest, conflict, forbidden, isAppError, notFound, toWireError, tooManyRequests, unauthorized } from './errors';
import { env, isProd } from './env';
import { logger } from './logger';
import * as metrics from './metrics';
import * as ratelimit from './ratelimit';
import * as referee from './referee';
import * as rooms from './rooms';
import * as shop from './shop';
import * as store from './store';
import * as tutorial from './tutorial';
import * as survey from './survey';
import type { Player, Zone } from './types';

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
const skuParams = z.object({ sku: z.string().min(1).max(64) });
const aimBody = z.object({ huntId: z.string().min(1).max(128) });
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

    // Every authenticated request passes through here, which is exactly why the
    // activity record goes here and nowhere else — a funnel that only counts
    // players who happened to hit an instrumented route measures the route.
    //
    // Costs one write per player per day, not one per request: the day row's
    // primary key rejects the repeats. Swallows its own errors, because a
    // measurement must never be able to fail a request it is only observing.
    try {
      store.markSeen(player);
    } catch (err) {
      logger.warn({ err, playerId: player.id }, 'activity not recorded');
    }

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
      xp: player.xp,
      /**
       * The two currencies, side by side on purpose.
       *
       * Energy is the product and can be bought. Keys are entries and cannot
       * be, by anyone, at any price — see keys.ts. Showing them together is
       * what makes the boundary legible rather than a rule buried in a FAQ.
       */
      keys: keys.balance(player.id),
      /** Standing, and what is still missing to climb. See rank.ts. */
      rank: rank.rankOf(player.id),
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

  /**
   * One player's view of a zone.
   *
   * Authenticated, where it used to be public — there is no longer any such
   * thing as "the zone's map" to serve anonymously. Neither the fog nor the
   * treasure locations are common knowledge: a hunt reaches this payload only
   * once it has gone public, or once this player has dug it up themselves.
   */
  app.get('/zones/:id/grid', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    const now = Date.now();

    return {
      cols: GRID.cols,
      rows: GRID.rows,
      epoch: zone.epoch,
      // Only what THIS PLAYER has uncovered. Everything else is absent and the
      // client renders fog — the map itself never leaves the server, and one
      // player's digs never reach another.
      reveals: store.revealsFor(zone, player.id),
      /**
       * Where the player is in the first-run script, or null once it is done.
       *
       * Served with the grid rather than from its own endpoint because it is a
       * property of this player's view of this map, and because a tutorial that
       * needs a second round trip is a tutorial that stutters on 3G.
       */
      tutorial: tutorial.stateFor(player, zone),
      // What THIS PLAYER may see: treasures already public, ones they personally
      // dug up, and anything reserved for them.
      //
      // This used to be `liveHuntsIn` — every live hunt, with coordinates, to
      // everybody. That single line undid phases 1 through 3: Survey reported
      // the distance to a treasure the client could already locate, hints
      // narrowed toward a cell that was already on screen, and the overview drew
      // all twenty-four of them on a map whose whole point was that you had to
      // find them. See migration 019.
      hunts: [
        ...store.visibleHuntsIn(zone, player.id, now),
        ...store.ownedHuntsIn(zone, player.id),
      ].map(h => ({
        id: h.id,
        r: h.r,
        c: h.c,
        kind: h.kind,
        // Drawn from the salt at creation. Surfaced because it now decides the
        // prize, the entry fee AND how hard the block's game generates — a
        // player choosing between two hunts is choosing between those.
        difficulty: h.difficulty,
        prizeLabel: h.prizeLabel,
        // What game this block runs, before anyone commits energy to it.
        //
        // The type was hidden until you had already entered, so a player chose
        // between hunts with no idea what they were walking into. It is a
        // property of the block, fixed by the salt at creation and checkable
        // afterwards — hiding it protected nothing. Hide the answer, not the
        // shape.
        gameType: store.blockGame(store.getHunt(h.id) ?? h).type,
        /** Non-null means this one was placed for you and only you can enter it. */
        ownerId: h.ownerId,
        /**
         * When the rest of the zone finds out about this one.
         *
         * In the future means this player found it and is inside its head start;
         * the client needs that to draw the countdown, and to know not to drop
         * the hunt when a `zone:hunts` broadcast arrives without it.
         */
        publicAt: h.publicAt,
        status: h.status,
        chasers: store.chaserCount(h.id),
      })),
    };
  });

  /**
   * Open free neighbours around a mystery tile.
   *
   * Free means free: no energy, and no hint either. A mystery that also paid
   * hints would be strictly better than a clue at a lower rarity, and the
   * distribution has clue at 17% against mystery at 9% precisely because a hint
   * is meant to be the more common reward. What this buys is *map*, which is
   * the scarce thing on a 3,600-cell grid.
   *
   * Skips cells holding a hunt. Handing someone a treasure they did not dig for
   * would make the mystery tile the best thing on the board by a wide margin,
   * and would do it invisibly.
   */
  function openNeighbours(
    zone: Zone,
    player: Player,
    r: number,
    c: number,
    now: number,
  ): Array<{ r: number; c: number; type: string; byHandle: string; at: number }> {
    const out: Array<{ r: number; c: number; type: string; byHandle: string; at: number }> = [];

    // Deterministic order, so the same mystery tile always opens the same
    // neighbour — it is a property of the map, not of when you happened to tap.
    const around = [
      [-1, 0],
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ] as const;

    for (const [dr, dc] of around) {
      if (out.length >= TILES.mystery.freeNeighbours) break;
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc, GRID.rows, GRID.cols)) continue;
      if (store.huntAt(zone, nr, nc)) continue;
      if (store.getReveal(zone, player.id, nr, nc)) continue;

      const neighbour = {
        r: nr,
        c: nc,
        type: tileType(zone, nr, nc),
        byHandle: player.handle,
        at: now,
      };
      // A neighbour that is itself a trap or a mystery does NOT chain. One free
      // tile is a bonus; a cascade is an exploit, and on a map this size an
      // unbounded chain could uncover a meaningful fraction of it for 2 energy.
      if (store.addReveal(zone, { ...neighbour, playerId: player.id })) {
        metrics.tilesRevealed.inc({ type: neighbour.type });
        out.push(neighbour);
      }
    }

    return out;
  }

  app.post('/zones/:id/tiles/:r/:c/open', async req => {
    const player = await requirePlayer(req);
    const { id, r, c } = parse(tileParams, req.params);
    limit(`tile:${player.id}`, env.RATE_TILE_PER_MIN, 60_000, 'tile');

    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    if (!inBounds(r, c, GRID.rows, GRID.cols)) throw badRequest('out_of_bounds');

    const now = Date.now();

    // ─────────────────────── digging up a treasure ───────────────────────
    //
    // This used to answer 409 `is_hunt` and tell the player to open it from the
    // hunt sheet — which made sense only while the sheet listed every treasure
    // on the map. It does not any more (migration 019), so digging the cell IS
    // how a treasure is found, and refusing the dig would leave the game with no
    // discovery mechanism at all.
    //
    // Energy is deliberately not charged. The tile is not revealed, nothing is
    // written to the player's fog, and the reward for spending a dig on the
    // right cell is the find itself.
    const treasure = store.huntAt(zone, r, c);
    // A treasure reserved for THIS player is theirs and is already on their map,
    // so digging it is a find like any other. Without this branch it fell
    // through to the 409 below and the walkthrough's own instruction — "both of
    // them point here, dig it" — answered "open this one from the hunt sheet".
    // An instruction that errors is worse than no instruction.
    if (treasure && (treasure.ownerId === null || treasure.ownerId === player.id)) {
      const mine = treasure.ownerId === player.id;
      const found = mine ? false : store.discoverHunt(treasure, player.id, now);
      if (found) metrics.huntsDiscovered.inc({ kind: treasure.kind });
      tutorial.advance(player, zone, { kind: 'dig', r, c }, now);
      const hunt = store.getHunt(treasure.id) ?? treasure;
      return {
        found: true,
        alreadyFound: !found && !mine,
        hunt: {
          id: hunt.id,
          r: hunt.r,
          c: hunt.c,
          kind: hunt.kind,
          difficulty: hunt.difficulty,
          prizeLabel: hunt.prizeLabel,
          gameType: store.blockGame(hunt).type,
          status: hunt.status,
          // When everyone else finds out. The client shows it as a countdown:
          // the head start is only worth something if you know it is running.
          publicAt: hunt.publicAt,
          headStartMs: Math.max(0, (hunt.publicAt ?? now) - now),
        },
        energy: energy.view(player, now),
      };
    }
    // A hunt reserved for someone else is not on this player's map at all, so it
    // behaves exactly as fog would rather than confirming something is there.
    if (treasure) throw conflict('is_hunt', 'open this one from the hunt sheet');

    const existing = store.getReveal(zone, player.id, r, c);
    if (existing) return { cell: existing, energy: energy.view(player, now), alreadyOpen: true };

    // The tile's type is known before it is paid for, because a trap costs
    // double. That is the first thing in this handler that has ever read the
    // type for anything but a label.
    const type = tileType(zone, r, c);
    const cost = ENERGY.costFog * (type === 'trap' ? TILES.trap.energyMultiplier : 1);

    const spent = energy.spend(player, cost, now, 'dig');
    if (!spent.ok) throw conflict('insufficient_energy', 'out of energy', spent.energy);
    store.savePlayerEnergy(player);

    // Read BEFORE advancing, because advancing is what makes it false.
    //
    // `isFirstStepCell` tests `tutorialStep === 0`, and `advance` below moves
    // it to 1. Consulting it after the advance — which is what happened — meant
    // `wantTrue` was never set on the walkthrough's first dig, so the hint was
    // drawn honestly and was false about a quarter of the time. The guarantee
    // held only by luck, and the test for it failed roughly one run in four.
    const firstWalkthroughDig = tutorial.isFirstStepCell(player, zone, r, c);

    tutorial.advance(player, zone, { kind: 'dig', r, c }, now);

    const cell = { r, c, type, byHandle: player.handle, at: now };
    const opened = store.addReveal(zone, { ...cell, playerId: player.id });

    if (!opened) {
      // The same player double-tapped: the read above missed it, the write hit
      // the primary key. Not a lost race — under private fog there is nobody to
      // race — so give the energy back and serve what they already had.
      const refunded = energy.refund(player, cost, now);
      store.savePlayerEnergy(player);
      return { cell: store.getReveal(zone, player.id, r, c), energy: refunded, alreadyOpen: true };
    }

    metrics.tilesRevealed.inc({ type: cell.type });

    // ─────────────────────── no reveal goes on chain ───────────────────────
    //
    // This used to publish every dig, deduped on (zone, epoch, r, c). Private
    // fog is incompatible with that in both directions: the dedupe key now
    // collides between players who legitimately open the same tile, and — the
    // real problem — a public per-player reveal log republishes the map, which
    // is exactly what this phase exists to stop. A chain record of who dug
    // where would hand any observer the pooled map we just took away.
    //
    // The claims that carry the audit story are untouched: hunt commitments,
    // hint sets and their truth flags, entries, resolutions and payouts. What
    // is lost is "every dig is on chain", the weakest of them, and the only one
    // private fog contradicts.

    // Awarded after the reveal is committed, and never allowed to throw: the
    // player has already paid energy for this tile, so a hint that fails to
    // generate is a missing bonus rather than a failed request.
    //
    // A clue always pays; a trap pays a hint drawn from the false ones. Both
    // draw from the hunt's committed set, so neither disturbs the published
    // honesty numbers — see hints/index.ts.
    // A trap is guaranteed too, not only a clue. A tile that charges double and
    // then rolls 35% for anything at all is pure punishment — the player pays
    // more and may learn nothing, which teaches avoidance rather than caution.
    // Guaranteed-but-false is a real cost with a real consequence, and it is
    // survivable: a hint that contradicts your others is itself information.
    const hint = hints.awardForReveal(
      zone.seedSecret,
      player.id,
      r,
      c,
      // Own hunts included, so the tutorial's first clue is about the treasure
      // the tutorial is walking you towards. Hints target the NEAREST hunt, and
      // the placed one is two tiles away.
      [...store.liveHuntsIn(zone), ...store.ownedHuntsIn(zone, player.id)],
      now,
      {
        targetHuntId: shop.targetFor(player.id, now),
        guaranteed:
          type === 'clue'
            ? TILES.clue.guaranteedHint
            : type === 'trap'
              ? TILES.trap.guaranteedHint
              : false,
        /*
          A trap always lies; the walkthrough's first clue always tells the
          truth; everything else draws honestly from the committed set.

          The middle case is new and is worth stating. Tier is drawn by the
          same roll either way, so the first hint can be a SHARP one — a
          coin flip by design — and on a first playthrough it lands with
          nothing to cross-check it against. Observed on the first end-to-end
          run of the new script: the tutorial's hint was false, so at The
          Crack all six doors read RULED OUT and the one hunt a new player
          cannot lose demonstrated deduction failing.

          This does not touch the published honesty numbers. `pickFrom`
          filters the hunt's already-committed set, exactly as the trap path
          does in the other direction — the same hint that was going to exist
          either way, chosen rather than rolled.
        */
        wantTrue:
          type === 'trap' && TILES.trap.falseHint
            ? false
            : firstWalkthroughDig
              ? true
              : undefined,
      },
    );

    // A Compass charge is spent only when it actually delivered — a hint that
    // was granted AND was about the treasure it was aimed at. A charge burned
    // on a dig that turned up nothing would be selling five hints and handing
    // over fewer.
    const aimedAt = shop.targetFor(player.id, now);
    if (hint && aimedAt && hint.huntId === aimedAt) shop.consumeCharge(player.id, now);

    // A mystery tile opens a neighbour on the house. Only coherent because the
    // fog is per-player: under a shared map this would have been spending
    // someone else's tile.
    const bonus = type === 'mystery' ? openNeighbours(zone, player, r, c, now) : [];

    // A puzzle tile pays XP. Small — it is a garnish on exploring, not a reason
    // to hunt for puzzle tiles specifically.
    if (type === 'puzzle') store.awardXp(player, TILES.puzzle.xp);

    // Deliberately NOT broadcast to the zone. Telling the room which tile just
    // opened is the free-riding leak in socket form — it was how a player who
    // spent nothing learned where treasure was not.
    rooms.toPlayer(player.id, { t: 'tile:revealed', ...cell });
    for (const b of bonus) rooms.toPlayer(player.id, { t: 'tile:revealed', ...b });

    return {
      cell,
      energy: spent.energy,
      hint,
      bonus,
      xp: type === 'puzzle' ? { gained: TILES.puzzle.xp, total: player.xp } : null,
    };
  });

  /**
   * Survey: spend energy to learn how close the nearest treasure is.
   *
   * Uncovers nothing. That is the point rather than a limitation — it is the
   * only energy sink in the game that does not permanently consume part of the
   * map, which is what lets a zone survive being played hard. See the SURVEY
   * block in config.ts.
   *
   * Deliberately allowed on a cell that already holds a hunt or has already
   * been dug: you are reading the ground from a position, not interacting with
   * the tile, and forbidding it would leak which cells are special.
   */
  app.post('/zones/:id/survey/:r/:c', async req => {
    const player = await requirePlayer(req);
    const { id, r, c } = parse(tileParams, req.params);
    limit(`tile:${player.id}`, env.RATE_TILE_PER_MIN, 60_000, 'tile');

    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');
    if (!inBounds(r, c, GRID.rows, GRID.cols)) throw badRequest('out_of_bounds');

    const now = Date.now();
    // The player's own reserved treasure counts. It is on the map, it is theirs
    // to find, and a detector that could not see it would report a reading
    // about something else — which would make the tutorial's second step a lie
    // at exactly the moment it is teaching what Survey means.
    const live = [...store.liveHuntsIn(zone), ...store.ownedHuntsIn(zone, player.id)];
    // Read before charging. A zone with nothing in it would answer "cold",
    // which implies a treasure is out there somewhere — charging six energy for
    // a misleading answer is worse than refusing.
    const reading = survey.read(live, r, c, now);
    if (!reading) throw conflict('nothing_to_find', 'this zone has no live treasure');

    const spent = energy.spend(player, SURVEY.cost, now, 'survey');
    if (!spent.ok) throw conflict('insufficient_energy', 'out of energy', spent.energy);
    store.savePlayerEnergy(player);

    metrics.surveysTaken.inc({ band: reading.band });
    tutorial.advance(player, zone, { kind: 'survey' }, now);
    return { reading, energy: spent.energy };
  });

  /**
   * What to do when the bar is empty.
   *
   * ─────────────────────────── the moment this exists for ─────────────────────
   *
   * An empty bar is the highest-intent moment in the session — someone who has
   * been narrowing down a patch of map and has just been stopped — and it was
   * dead air. 108 seconds of nothing, with no prompt and no reason to come back.
   * Phase 2 made the bar four hours, which turns a shrug into a departure
   * unless the moment says something.
   *
   * So it says two things: how close the nearest treasure is, and when the bar
   * returns. The first is a reason to come back; the second is a time to come
   * back. Neither costs the player anything, and the warmth reading is free
   * here on purpose — charging six energy to a player with none would be a joke
   * at their expense.
   *
   * The refill offer belongs here too and is not built: there is no shop until
   * phase 7. That is the one thing this endpoint is shaped for and does not yet
   * do.
   */
  app.get('/zones/:id/stuck', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');

    const now = Date.now();
    const view = energy.view(player, now);
    const live = [...store.liveHuntsIn(zone), ...store.ownedHuntsIn(zone, player.id)];

    // Warmth from the last place they dug, which is where their attention is.
    // Falling back to the middle of the map is honest but much less useful, so
    // it is only for someone who has not dug at all.
    const mine = store.revealsFor(zone, player.id);
    const from = mine.length > 0
      ? mine.reduce((latest, r) => (r.at > latest.at ? r : latest))
      : { r: Math.floor(GRID.rows / 2), c: Math.floor(GRID.cols / 2) };

    const reading = survey.read(live, from.r, from.c, now);

    return {
      energy: view,
      /** Where the reading was taken from, so the client can point at it. */
      from: { r: from.r, c: from.c },
      /** Null only when the zone holds nothing at all. */
      nearest: reading ? { band: reading.band } : null,
      /** Enough energy for one dig — what "come back" actually means. */
      digCostEnergy: ENERGY.costFog,
      // Time until a DIG is affordable, not until the next single point lands.
      // At two energy a dig and one point every six minutes, "next regen" would
      // routinely promise the bar back twice as soon as it is actually usable.
      msUntilPlayable:
        view.value >= ENERGY.costFog
          ? 0
          : view.nextRegenMs + (ENERGY.costFog - view.value - 1) * ENERGY.regenMs,
      /** XP hunts stay open when cash ones do not; say so rather than imply it. */
      hintsHeld: hints.countForPlayer(player.id, now),
    };
  });

  // ---- shop ----

  /**
   * What is for sale, and what this player already holds.
   *
   * The catalogue is a constant in code rather than a table, and served from
   * there — see shop/catalogue.ts for why the set of sellable things is closed.
   */
  app.get('/shop', async req => {
    const player = await requirePlayer(req);
    return shop.stateFor(player.id);
  });

  /**
   * Buy something.
   *
   * Payment goes through the same x402 path entry fees use: a 402 carrying the
   * terms and a ready-to-sign payload, then the client signs and retries. When
   * fees are switched off — the default — the shop still works and records the
   * purchase at its listed price, which is what lets the whole flow be exercised
   * without a facilitator.
   */
  app.post('/shop/:sku/buy', async (req, reply) => {
    const player = await requirePlayer(req);
    const { sku } = parse(skuParams, req.params);
    limit(`shop:${player.id}`, env.RATE_ATTEMPT_PER_MIN, 60_000, 'shop');

    const item = shop.itemFor(sku);
    if (!item) throw notFound('no_such_item');

    let paymentRef: string | null = null;
    if (x402.enabled()) {
      const terms = x402.termsFor(`shop/${item.sku}`, item.priceCents);
      const settled = await x402.settleEntry(terms, headerOrNull(req, 'x-payment'));
      if (!settled.ok) {
        const challenge = x402.challengeFor(terms, player.id as `0x${string}`);
        return reply.code(402).send(x402.paymentRequiredBody(terms, challenge));
      }
      paymentRef = settled.reference;
    }

    return shop.fulfil(player, item, paymentRef);
  });

  /** Spend a banked refill. Free — it was paid for when it was bought. */
  app.post('/shop/refill/use', async req => {
    const player = await requirePlayer(req);
    const now = Date.now();
    if (!shop.useRefillCredit(player, now)) throw conflict('no_refills_left');
    return { energy: energy.view(player, now) };
  });

  /**
   * Point a Compass at a treasure.
   *
   * Free and separate from buying one: choosing a target at the checkout would
   * mean choosing before you had a reason to prefer any.
   */
  app.post('/shop/compass/aim', async req => {
    const player = await requirePlayer(req);
    const { huntId } = parse(aimBody, req.body);

    const hunt = store.getHunt(huntId);
    if (!hunt || hunt.status !== 'live') throw notFound('no_such_hunt');
    if (!shop.aim(player.id, huntId)) throw conflict('no_compass');

    return { aimedAt: huntId, entitlements: shop.stateFor(player.id).entitlements };
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
    if (!result.ok) {
      // The refusal's detail travels with it. A money-gate refusal that says
      // only "no" reads as rigged; one that says "two more days" is something
      // a player can act on, and it gives away nothing an attacker could not
      // read in rank.ts. `shadow_banned` never reaches here — it is disguised
      // as `hunt_not_live` inside the referee.
      throw conflict(result.error, undefined, result.detail);
    }

    if (zone) tutorial.advance(player, zone, { kind: 'enter' });

    return {
      attemptId: result.attempt.id,
      gameType: result.gameType,
      spec: result.spec,
      limitMs: result.limitMs,
      startedAt: result.attempt.startedAt,
      energy: energy.view(player, Date.now()),
    };
  });

  /**
   * "Got it" on a walkthrough step that has no tap.
   *
   * Half the steps teach something with no control attached — what a hint is,
   * what a survey band means, what energy is, what a key is. Those need an
   * acknowledgement, and it has to be a server call rather than client state:
   * the position is a column on the player (migration 020), so a client that
   * advanced locally would show the right thing until the next reload and the
   * wrong thing after it.
   *
   * Deliberately not "set step N". The client says *that* it acknowledged, and
   * the server decides whether the current step was one that could be — so a
   * replayed or spoofed ack cannot skip a step that requires a real dig.
   */
  app.post('/zones/:id/tutorial/ack', async req => {
    const player = await requirePlayer(req);
    const { id } = parse(zoneParams, req.params);
    const zone = store.getZone(id);
    if (!zone) throw notFound('no_such_zone');

    tutorial.advance(player, zone, { kind: 'ack' });
    return { tutorial: tutorial.stateFor(player, zone) };
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

  /**
   * Find the vault on chain once the player's transaction has landed.
   *
   * Takes no address: it is read from the factory. One a client could supply
   * would be one the server then lets an agent spend against.
   */
  app.post('/agent/vault', async req => {
    const player = await requirePlayer(req);
    limit(`agent:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'agent');
    return { agent: await agents.attachVault(player) };
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
  /**
   * Buy a seat: inference the house pays for on this player's behalf.
   *
   * ─────────────────────────── what this route must never become ─────────────
   *
   * It sells COMPUTE. It does not sell entry, and there is deliberately no
   * seat check anywhere on the hunt-entry path — an unseated agent enters the
   * same hunts, races the same opponents and wins the same prizes, playing its
   * deterministic line instead of a model's.
   *
   * AGENT_TIER.md §2 explains why that separation is load-bearing rather than
   * fussy: charging for something a player NEEDS in order to compete for a cash
   * prize is an entry fee with extra steps, which is the gambling definition in
   * many jurisdictions. `payments/x402.ts` carries the same warning.
   *
   * GET returns the offer and costs nothing. POST answers 402 with terms the
   * client signs, exactly as the entry path does, and credits the seat on
   * settlement.
   */
  app.get('/agent/seat', async req => {
    const player = await requirePlayer(req);
    const agent = agents.ensure(player);
    return {
      seat: seats.offer(agent.id),
      purchasable: x402.seatsEnabled(),
      why: x402.seatsDisabledReason(),
    };
  });

  app.post('/agent/seat', async (req, reply) => {
    const player = await requirePlayer(req);
    limit(`agent:${player.id}`, env.RATE_MARKET_PER_MIN, 60_000, 'agent');
    const agent = agents.ensure(player);

    if (!x402.seatsEnabled()) throw conflict('seats_unavailable');

    // The cap is a budget, not a queue: selling past it would promise inference
    // the house has not budgeted for. Refusing the SALE is safe; refusing the
    // play would not be, which is why nothing here touches whether they play.
    if (seats.seatsLeft() <= 0 && !seats.get(agent.id)) {
      throw conflict('no_seats_left', undefined, 'All funded seats are taken. You can still play for free.');
    }

    const terms = x402.termsForSeat(agent.id, seats.SEAT_PRICE_CENTS);
    const settled = await x402.settleEntry(terms, headerOrNull(req, 'x-payment'));
    if (!settled.ok) {
      const challenge = x402.challengeFor(terms, player.id as `0x${string}`);
      return reply.code(402).send(x402.paymentRequiredBody(terms, challenge));
    }

    const seat = seats.grant(agent.id, player.id, {
      // `txRef` is UNIQUE, so a replayed envelope raises rather than crediting
      // twice. The client hands back what we gave it, so it is untrusted input.
      txRef: settled.reference,
    });
    metrics.agentSeatsSold.inc();
    return { seat: seats.offer(agent.id), credit: seat.millsGranted - seat.millsSpent };
  });

  app.post('/agent/kill', async req => {
    const player = await requirePlayer(req);
    return agents.killOffer(player);
  });

  /** Stop hunting for now. Keeps the vault and the on-chain rights. */
  app.post('/agent/pause', async req => {
    const player = await requirePlayer(req);
    return { agent: agents.pause(player) };
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

  /** Move-by-move: what the agent played, and whether a model chose it. */
  app.get('/agent/activity', async req => {
    const player = await requirePlayer(req);
    return agents.activity(player);
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

  /**
   * A seller's weighted trust, for a buyer deciding whether to pay them.
   *
   * The weighted number, never the registry's raw score — showing a figure a
   * wash farm can manufacture would be worse than showing nothing, because it
   * looks like diligence. Unauthenticated, like every other market surface.
   */
  app.get('/market/trust/:id', async req => {
    const { id } = parse(idParams, req.params);
    return await reputation.trustFor(id);
  });

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
    return { listing: await market.list(player, hintId, askCents) };
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

  /**
   * The five funnel numbers, in one place.
   *
   * Prometheus carries all of these and is the right home for graphing them,
   * but a funnel nobody can read without a Grafana login is a funnel nobody
   * reads. This is the version you can curl during a playtest.
   *
   * Under /debug and behind the metrics token, NOT under /audit. That prefix
   * means something specific in this server — hint sets, zone seeds and
   * Director transcripts are published there precisely so a player can check
   * our honesty without asking us. Conversion rate and retention are the
   * opposite: our numbers, about them. Filing them beside the audit trail
   * would have served a competitor our funnel on an open endpoint.
   */
  app.get('/debug/funnel', { preHandler: debugGuard }, async () => funnel.report());

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
