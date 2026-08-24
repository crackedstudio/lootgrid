import { describe, expect, it } from 'vitest';
import { canonicalHttp, canonicalWs } from './canonical';

/**
 * The client signs; this server verifies. They are separate codebases in
 * separate languages of JavaScript, and nothing but this test stops them
 * drifting apart.
 *
 * Drift has two failure modes and only one of them is loud:
 *
 *  - the client signs MORE or DIFFERENTLY than the server checks → every
 *    request 401s at once, which is obvious and gets fixed in minutes.
 *  - the client signs LESS than the server checks → also loud.
 *  - but if BOTH are changed to sign less, the signature stops covering a field
 *    that decides what the request does, and a captured request becomes
 *    replayable somewhere it should not be. That one is silent.
 *
 * So this pins the exact bytes rather than merely asserting the two agree: the
 * literal below is the wire format, and changing it should require changing
 * this file on purpose.
 *
 * The implementation under `client()` is transcribed from `src/api/sign.js`.
 * If you edit that file, edit this one.
 */

// ─────────────────────── transcribed from src/api/sign.js ───────────────────

async function bodyHashClient(body?: string): Promise<string> {
  const bytes = body ? new TextEncoder().encode(body) : new Uint8Array(0);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function clientHttp(p: {
  player: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body?: string;
}): Promise<string> {
  return [
    'lootgrid-http-v1',
    p.player.toLowerCase(),
    p.method.toUpperCase(),
    p.path,
    String(p.timestamp),
    p.nonce,
    await bodyHashClient(p.body),
  ].join('\n');
}

const clientWs = (p: { playerId: string; timestamp: number; nonce: string }): string =>
  ['lootgrid-ws-v1', p.playerId.toLowerCase(), String(p.timestamp), p.nonce].join('\n');

// ─────────────────────────────────── tests ──────────────────────────────────

const PLAYER = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';

describe('client and server canonical strings', () => {
  it('agree on a plain GET', async () => {
    const p = { player: PLAYER, method: 'get', path: '/me', timestamp: 1, nonce: 'n1' };
    expect(await clientHttp(p)).toBe(canonicalHttp(p));
  });

  it('agree on a POST with a body', async () => {
    const p = {
      player: PLAYER,
      method: 'post',
      path: '/shop/refill/buy',
      timestamp: 1787406594272,
      nonce: 'deadbeef',
      body: JSON.stringify({ qty: 2 }),
    };
    expect(await clientHttp(p)).toBe(canonicalHttp(p));
  });

  it('agree on non-ASCII bodies', async () => {
    // TextEncoder is UTF-8 and Buffer.from(s,'utf8') is too, but only because
    // both were chosen to be. A body with a multi-byte character is where a
    // latin1 assumption on either side would surface.
    const p = {
      player: PLAYER,
      method: 'POST',
      path: '/market/listings',
      timestamp: 99,
      nonce: 'z',
      body: JSON.stringify({ note: 'ünicode ✓ 🕳' }),
    };
    expect(await clientHttp(p)).toBe(canonicalHttp(p));
  });

  it('agree that the query string is part of the signed path', async () => {
    const p = {
      player: PLAYER,
      method: 'GET',
      path: '/market/listings?zone=ridge&min=1',
      timestamp: 5,
      nonce: 'q',
    };
    expect(await clientHttp(p)).toBe(canonicalHttp(p));
    // Dropping the query must change the signature, or a filtered read could be
    // replayed as an unfiltered one.
    expect(canonicalHttp({ ...p, path: '/market/listings' })).not.toBe(canonicalHttp(p));
  });

  it('agree on the websocket hello', () => {
    const p = { playerId: PLAYER, timestamp: 7, nonce: 'ws' };
    expect(clientWs(p)).toBe(canonicalWs(p));
  });

  it('pins the exact wire format', async () => {
    const p = { player: PLAYER, method: 'GET', path: '/me', timestamp: 1, nonce: 'n' };
    expect(await clientHttp(p)).toBe(
      [
        'lootgrid-http-v1',
        '0xabcdef0123456789abcdef0123456789abcdef01',
        'GET',
        '/me',
        '1',
        'n',
        // sha256 of the empty string
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });

  it('separates the HTTP and websocket domains', () => {
    // An HTTP signature must never verify as a socket handshake.
    expect(canonicalHttp({ player: PLAYER, method: 'GET', path: '/me', timestamp: 1, nonce: 'n' }))
      .not.toContain('lootgrid-ws-v1');
    expect(canonicalWs({ playerId: PLAYER, timestamp: 1, nonce: 'n' }))
      .not.toContain('lootgrid-http-v1');
  });
});
