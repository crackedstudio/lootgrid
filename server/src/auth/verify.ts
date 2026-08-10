import { getAddress, isAddress, recoverMessageAddress, type Address } from 'viem';
import * as nonces from '../db/repos/nonces';
import { env } from '../env';
import { unauthorized } from '../errors';
import { logger } from '../logger';
import * as store from '../store';
import type { Player } from '../types';
import { canonicalHttp, canonicalWs, type HttpParts, type WsParts } from './canonical';
import * as registry from './registry';

export interface Credentials {
  /** Wallet address, as sent by the client. */
  player: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export function defaultHandle(address: string): string {
  return `@${address.slice(2, 8).toLowerCase()}`;
}

function normalisePlayer(raw: string): Address {
  if (!isAddress(raw)) throw unauthorized('bad_player_address');
  return getAddress(raw);
}

/**
 * Shared verification for both transports.
 *
 * Order matters: the cheap local checks run before the chain read, so an
 * attacker cannot make us do RPC work by spraying malformed requests.
 */
async function authenticate(creds: Credentials, message: string, now: number): Promise<Player> {
  const address = normalisePlayer(creds.player);
  const id = address.toLowerCase();

  if (!Number.isFinite(creds.timestamp)) throw unauthorized('bad_timestamp');
  if (Math.abs(now - creds.timestamp) > env.REQUEST_MAX_SKEW_MS) {
    throw unauthorized('stale_request');
  }

  if (typeof creds.nonce !== 'string' || creds.nonce.length < 8 || creds.nonce.length > 128) {
    throw unauthorized('bad_nonce');
  }
  // The nonce is inside the signed message, so a conflict is a replay of the
  // exact same request — never a legitimate retry.
  if (!nonces.claim(id, creds.nonce, now)) throw unauthorized('replayed_request');

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: creds.signature as `0x${string}`,
    });
  } catch {
    throw unauthorized('bad_signature');
  }

  const bound = await registry.sessionKeyOf(address, now);
  if (!bound) throw unauthorized('no_session_key_bound');
  if (bound.toLowerCase() !== recovered.toLowerCase()) throw unauthorized('session_key_mismatch');

  return store.ensurePlayer(id, defaultHandle(address));
}

export async function verifyHttp(
  creds: Credentials,
  parts: HttpParts,
  now = Date.now(),
): Promise<Player> {
  if (env.AUTH_MODE === 'dev') return devPlayer(creds.player);
  return authenticate(creds, canonicalHttp(parts), now);
}

export async function verifyWs(
  creds: Credentials,
  parts: WsParts,
  now = Date.now(),
): Promise<Player> {
  if (env.AUTH_MODE === 'dev') return devPlayer(creds.player);
  return authenticate(creds, canonicalWs(parts), now);
}

/**
 * AUTH_MODE=dev trusts the claimed identity outright. `env.ts` refuses to boot
 * with this in production — it is for local work and tests only.
 */
function devPlayer(raw: string): Player {
  const id = (raw || '').toLowerCase();
  if (!id) throw unauthorized('no_session');
  return store.ensurePlayer(id, defaultHandle(id.startsWith('0x') ? id : `0x${id}`));
}

let pruneTimer: NodeJS.Timeout | null = null;

export function startNoncePruner(): void {
  const keepMs = env.REQUEST_MAX_SKEW_MS * 4;
  pruneTimer = setInterval(() => {
    try {
      // Anything older than the skew window can no longer be replayed, because
      // the timestamp check would reject it first.
      const dropped = nonces.prune(Date.now() - keepMs);
      if (dropped > 0) logger.debug({ dropped }, 'pruned expired nonces');
    } catch (err) {
      logger.error({ err }, 'nonce prune failed');
    }
  }, 60_000);
  pruneTimer.unref?.();
}

export function stopNoncePruner(): void {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}
