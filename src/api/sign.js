import { getSessionAccount, getPlayerId } from './session';

/**
 * The exact bytes the server verifies. Mirrors `server/src/auth/canonical.ts`.
 *
 * Every field that changes what a request DOES is inside the signature —
 * identity, method, path, body — so a captured signature cannot be replayed
 * against another endpoint, with different contents, or under a different
 * claimed player. The version prefix is domain separation: an HTTP signature
 * can never be reused as a WebSocket handshake.
 *
 * If this drifts from the server's copy every request fails at once, which is
 * the good failure mode. The bad one would be signing LESS than the server
 * checks, so keep the field list and its order identical.
 */

const HTTP_DOMAIN = 'lootgrid-http-v1';
const WS_DOMAIN = 'lootgrid-ws-v1';

/** sha256 of the raw body, hex. Empty body hashes the empty string. */
async function bodyHash(body) {
  const bytes = body ? new TextEncoder().encode(body) : new Uint8Array(0);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Headers proving this request came from the bound session key.
 *
 * `path` must be exactly what goes on the wire, query string included — the
 * server signs the raw path, so signing a normalised version fails to verify.
 */
export async function signRequest(method, path, body) {
  const player = getPlayerId();
  if (!player) throw new Error('not authenticated');

  const timestamp = Date.now();
  const n = nonce();
  const canonical = [
    HTTP_DOMAIN,
    player.toLowerCase(),
    method.toUpperCase(),
    path,
    String(timestamp),
    n,
    await bodyHash(body),
  ].join('\n');

  const signature = await getSessionAccount().signMessage({ message: canonical });

  return {
    'x-player': player,
    'x-timestamp': String(timestamp),
    'x-nonce': n,
    'x-signature': signature,
  };
}

/** The socket handshake. Fewer fields — there is no method, path or body. */
export async function signHello() {
  const player = getPlayerId();
  if (!player) throw new Error('not authenticated');

  const timestamp = Date.now();
  const n = nonce();
  const canonical = [WS_DOMAIN, player.toLowerCase(), String(timestamp), n].join('\n');
  const signature = await getSessionAccount().signMessage({ message: canonical });

  return { t: 'hello', player, timestamp, nonce: n, signature };
}
