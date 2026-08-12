import { createHash } from 'node:crypto';

/**
 * The exact bytes a client signs.
 *
 * Every field that affects what the request *does* is inside the signature:
 * method, path and body — so a captured signature cannot be replayed against a
 * different endpoint or with altered contents. The version prefix is domain
 * separation: an HTTP signature can never be replayed as a WebSocket handshake,
 * and a future v2 scheme can never be confused with this one.
 */
export const HTTP_DOMAIN = 'lootgrid-http-v1';
export const WS_DOMAIN = 'lootgrid-ws-v1';

export function bodyHash(body: string | Buffer | undefined | null): string {
  const buf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')) : Buffer.alloc(0);
  return createHash('sha256').update(buf).digest('hex');
}

export interface HttpParts {
  /** The acting identity. MUST be signed — see below. */
  player: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body?: string | Buffer | null;
}

export function canonicalHttp(p: HttpParts): string {
  return [
    HTTP_DOMAIN,
    // The acting identity is inside the signature, not just the x-player header.
    // Without this a signature proves an action but not who performed it, so a
    // captured request could be replayed under a different claimed player — and
    // the replay nonce is namespaced by that same claimed player, so it would
    // not collide. canonicalWs has always signed the identity; this omission on
    // the HTTP side was the asymmetry.
    p.player.toLowerCase(),
    p.method.toUpperCase(),
    p.path,
    String(p.timestamp),
    p.nonce,
    bodyHash(p.body),
  ].join('\n');
}

export interface WsParts {
  playerId: string;
  timestamp: number;
  nonce: string;
}

export function canonicalWs(p: WsParts): string {
  return [WS_DOMAIN, p.playerId.toLowerCase(), String(p.timestamp), p.nonce].join('\n');
}
