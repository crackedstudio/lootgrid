import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import * as registry from './auth/registry';
import { verifyWs } from './auth/verify';
import { env } from './env';
import { isAppError } from './errors';
import { logger } from './logger';
import * as metrics from './metrics';
import * as ratelimit from './ratelimit';
import * as referee from './referee';
import * as rooms from './rooms';
import * as store from './store';

const helloSchema = z.object({
  t: z.literal('hello'),
  player: z.string().min(1).max(64),
  timestamp: z.number().optional(),
  nonce: z.string().optional(),
  signature: z.string().optional(),
});

const roomSchema = z.object({
  t: z.enum(['join', 'leave']),
  room: z.string().regex(/^(zone|hunt):[A-Za-z0-9_-]+$/, 'bad room'),
});

const inputSchema = z.object({
  t: z.literal('input'),
  attemptId: z.string().min(1).max(128),
  events: z
    .array(
      z.object({
        seq: z.number().int().nonnegative(),
        kind: z.string().min(1).max(32),
        t: z.number().nonnegative(),
        value: z.union([z.number(), z.string(), z.boolean()]).optional(),
      }),
    )
    .min(1)
    // A legitimate client flushes every ~200ms; a batch larger than this is
    // either broken or probing.
    .max(64),
});

const incoming = z.discriminatedUnion('t', [helloSchema, roomSchema, inputSchema]);

interface SocketState {
  alive: boolean;
  authed: boolean;
}

export function attachWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Reject oversized frames at the protocol level, before any parsing.
    maxPayload: env.WS_MAX_MESSAGE_BYTES,
  });

  const sockets = new WeakMap<WebSocket, SocketState>();

  wss.on('connection', (ws: WebSocket, req) => {
    const state: SocketState = { alive: true, authed: false };
    sockets.set(ws, state);
    metrics.wsConnections.set(rooms.connectionCount() + 1);

    const ip = req.socket.remoteAddress ?? 'unknown';

    // An unauthenticated socket is a free resource — give it a short fuse.
    const helloTimer = setTimeout(() => {
      if (!state.authed) ws.close(4401, 'hello timeout');
    }, 10_000);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', raw => {
      void handleMessage(ws, state, String(raw), ip).catch(err => {
        logger.error({ err }, 'ws message handler threw');
      });
    });

    const cleanup = () => {
      clearTimeout(helloTimer);
      rooms.unregister(ws);
      metrics.wsConnections.set(rooms.connectionCount());
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  /**
   * Reaps half-open sockets AND re-checks each socket's session key.
   *
   * Authentication used to happen exactly once, at `hello` — after which the
   * socket was authorised for its entire lifetime by an in-memory lookup. That
   * meant `clear()` could not terminate an established connection at all: a
   * stolen key survived its own revocation indefinitely, with this very
   * heartbeat keeping it alive. The socket's authority now has to be renewed.
   */
  async function sweepSockets(): Promise<void> {
    for (const client of [...rooms.allClients()]) {
      const state = sockets.get(client.ws);
      if (state && !state.alive) {
        client.ws.terminate();
        continue;
      }
      if (state) state.alive = false;

      if (env.AUTH_MODE === 'chain' && client.sessionKey) {
        try {
          const bound = await registry.sessionKeyOf(client.playerId as `0x${string}`);
          if (!bound || bound.toLowerCase() !== client.sessionKey.toLowerCase()) {
            metrics.wsMessages.inc({ type: 'revalidate', result: 'revoked' });
            logger.info({ player: client.playerId }, 'closing socket — session key revoked');
            client.ws.close(4401, 'session revoked');
            continue;
          }
        } catch (err) {
          // Fail open for this tick rather than mass-disconnecting on an RPC
          // blip. Event-driven invalidation is the primary path; this is the
          // backstop, and it retries in WS_HEARTBEAT_MS.
          logger.warn({ err }, 'socket revalidation failed — retrying next tick');
        }
      }

      try {
        client.ws.ping();
      } catch {
        /* socket already gone */
      }
    }
  }

  const heartbeat = setInterval(() => {
    void sweepSockets().catch(err => logger.error({ err }, 'socket sweep threw'));
  }, env.WS_HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

async function handleMessage(
  ws: WebSocket,
  state: SocketState,
  raw: string,
  ip: string,
): Promise<void> {
  let msg: z.infer<typeof incoming>;
  try {
    msg = incoming.parse(JSON.parse(raw));
  } catch {
    metrics.wsMessages.inc({ type: 'unknown', result: 'invalid' });
    return rooms.send(ws, { t: 'error', error: 'bad_message' });
  }

  if (msg.t === 'hello') {
    if (state.authed) return rooms.send(ws, { t: 'error', error: 'already_authenticated' });

    // Cheap per-IP throttle so an unauthenticated peer cannot make us do
    // signature recovery and an RPC read in a loop.
    const gate = ratelimit.consume(`wshello:${ip}`, 20, 60_000);
    if (!gate.ok) {
      metrics.wsMessages.inc({ type: 'hello', result: 'rate_limited' });
      return ws.close(4429, 'too many attempts');
    }

    try {
      const player = await verifyWs(
        {
          player: msg.player,
          timestamp: msg.timestamp ?? 0,
          nonce: msg.nonce ?? '',
          signature: msg.signature ?? '',
        },
        {
          playerId: msg.player,
          timestamp: msg.timestamp ?? 0,
          nonce: msg.nonce ?? '',
        },
      );

      if (rooms.countForPlayer(player.id) >= env.WS_MAX_CONNECTIONS_PER_PLAYER) {
        metrics.wsMessages.inc({ type: 'hello', result: 'too_many_connections' });
        return ws.close(4429, 'too many connections');
      }

      // Remember the key so the heartbeat can notice if it is later rotated.
      let boundKey: string | null = null;
      if (env.AUTH_MODE === 'chain') {
        try {
          boundKey = await registry.sessionKeyOf(player.id as `0x${string}`);
        } catch {
          // Fail closed. Registering with a null key would make the socket
          // permanently exempt from revalidation, because the heartbeat skips
          // clients without a recorded key — an RPC blip would mint a session
          // that outlives every future revocation.
          metrics.wsMessages.inc({ type: 'hello', result: 'registry_unavailable' });
          rooms.send(ws, { t: 'error', error: 'registry_unavailable' });
          return ws.close(4503, 'registry unavailable');
        }
        if (!boundKey) {
          rooms.send(ws, { t: 'error', error: 'no_session_key_bound' });
          return ws.close(4401, 'unauthorized');
        }
      }

      rooms.register(ws, player.id, player.handle, boundKey);
      state.authed = true;
      metrics.wsMessages.inc({ type: 'hello', result: 'ok' });
      return rooms.send(ws, { t: 'ready', playerId: player.id, handle: player.handle });
    } catch (err) {
      const code = isAppError(err) ? err.code : 'unauthorized';
      metrics.authFailures.inc({ reason: code });
      metrics.wsMessages.inc({ type: 'hello', result: 'rejected' });
      rooms.send(ws, { t: 'error', error: code });
      return ws.close(4401, 'unauthorized');
    }
  }

  const client = rooms.clientFor(ws);
  if (!client) {
    metrics.wsMessages.inc({ type: msg.t, result: 'unauthenticated' });
    return rooms.send(ws, { t: 'error', error: 'say_hello_first' });
  }

  switch (msg.t) {
    case 'join':
      rooms.join(ws, msg.room);
      metrics.wsMessages.inc({ type: 'join', result: 'ok' });
      return;

    case 'leave':
      rooms.leave(ws, msg.room);
      metrics.wsMessages.inc({ type: 'leave', result: 'ok' });
      return;

    case 'input': {
      const attempt = store.getAttempt(msg.attemptId);
      // An attempt belongs to exactly one player. Never take input for someone
      // else's race, and do not confirm whether the id exists.
      if (!attempt || attempt.playerId !== client.playerId) {
        metrics.wsMessages.inc({ type: 'input', result: 'rejected' });
        return;
      }
      const gate = ratelimit.consume(`input:${client.playerId}`, 600, 60_000, msg.events.length);
      if (!gate.ok) {
        metrics.wsMessages.inc({ type: 'input', result: 'rate_limited' });
        metrics.rateLimited.inc({ bucket: 'ws_input' });
        return;
      }
      referee.submitInputs(msg.attemptId, msg.events);
      metrics.wsMessages.inc({ type: 'input', result: 'ok' });
      return;
    }
  }
}
