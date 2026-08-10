import { createHash, randomBytes } from 'node:crypto';

/**
 * Deterministic hashing for everything the server must be able to prove later:
 * tile types, per-block game specs, tie-breaks.
 *
 * NOTE: sha256 here. When the escrow contract lands this becomes keccak256, so
 * that `cellCommit` computed off-chain matches what Solidity verifies on-chain.
 * Nothing outside this module should care which one it is.
 */
export function hash(...parts: Array<string | number | Buffer>): Buffer {
  const h = createHash('sha256');
  for (const p of parts) {
    if (Buffer.isBuffer(p)) h.update(p);
    else h.update(String(p), 'utf8');
    h.update('\x1f'); // separator — keeps ('a','bc') distinct from ('ab','c')
  }
  return h.digest();
}

/** Unsigned integer from the first 6 bytes (stays inside Number's safe range). */
export function hashInt(...parts: Array<string | number | Buffer>): number {
  return hash(...parts).readUIntBE(0, 6);
}

/** Deterministic 0..1 stream from a seed. Same seed, same sequence, always. */
export function seededStream(seed: Buffer | string): () => number {
  let counter = 0;
  const base = Buffer.isBuffer(seed) ? seed : Buffer.from(seed, 'utf8');
  return () => hash(base, counter++).readUIntBE(0, 6) / 0xffffffffffff;
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
