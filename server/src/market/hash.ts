import { keccak256, toHex, type Hex } from 'viem';
import { canonicalPayload } from '../hints/commit';
import type { Hint } from '../hints/types';

/**
 * The hash a hint is sold under.
 *
 * ─────────────────────────── why it must be salted ───────────────────────────
 *
 * The obvious hash — over the hint's public fields — is broken, and quietly. The
 * payload space is tiny: four quadrants, a couple of hundred bands, about a
 * thousand distance rings. A buyer holding the hash could enumerate every
 * possible payload, hash each one, and find the match in milliseconds. They
 * would have the hint for free, before paying, and the market would collapse
 * before anyone noticed why.
 *
 * So the hash is salted with a per-hint nonce derived from the hunt's secret
 * salt. Unguessable while the hunt is live, disclosed to the buyer on delivery,
 * and recomputable by anyone once the hunt reveals its salt — so a listing can
 * still be audited after the fact.
 *
 * ─────────────────────────── what it must NOT cover ─────────────────────────
 *
 * `isTrue`, ever. Include it and the same enumeration attack runs in reverse:
 * after delivery a buyer holds the payload and the nonce, hashes both truth
 * values, and learns which one the house committed to. Certifying accuracy is
 * exactly what the vouch refuses to do (architecture §5), and this is the
 * quietest way to do it by accident.
 */

/** Bumped if the encoding below changes, so old vouches stay checkable. */
export const HASH_VERSION = 'lootgrid:hint-hash:v1';
const NONCE_VERSION = 'lootgrid:hint-nonce:v1';

/**
 * Per-hint blinding factor.
 *
 * Derived rather than stored: the hunt salt is already secret until settlement
 * and already the input to everything else about a hunt, so a random nonce in a
 * new column would add a thing to lose without adding a property.
 */
export function hintNonce(huntSalt: string, hintId: string): Hex {
  return keccak256(toHex([NONCE_VERSION, huntSalt, hintId].join('')));
}

/**
 * What the referee vouches for, and what a buyer checks after delivery.
 *
 * Covers the public claim in full — zone, hunt, tier, advertised reliability and
 * the payload itself — so a seller cannot deliver a different hint from the one
 * that was vouched for, or the same hint under an inflated tier.
 */
export function hintHashOf(hint: Hint, nonce: Hex): Hex {
  const canonical = [
    HASH_VERSION,
    hint.id,
    hint.zoneId,
    hint.huntId,
    hint.tier,
    hint.reliabilityBps,
    canonicalPayload(hint.payload),
    nonce,
  ].join('');
  return keccak256(toHex(canonical));
}

/**
 * Recompute and compare — the check a buyer runs on what they received.
 *
 * Exists here so the server's own delivery path runs the same code the buyer
 * would. A promise only the promiser can check is not a promise.
 */
export function hintHashMatches(hint: Hint, nonce: Hex, expected: Hex): boolean {
  return hintHashOf(hint, nonce).toLowerCase() === expected.toLowerCase();
}
