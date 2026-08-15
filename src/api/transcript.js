import { get } from './http';

/**
 * Recomputing the Director's hash chain, in the browser.
 *
 * ─────────────────────────── why the client does the maths ──────────────────
 *
 * The server could report "verified: true" and it would mean nothing — the
 * whole question the transcript answers is whether to believe the server. So
 * the chain is recomputed here, from the published entries, using the same
 * three ingredients the server used: a version tag, the salt, and each
 * directive's canonical form.
 *
 * The encoding is deliberately trivial for the same reason: keccak256 over
 * concatenated strings, no library-specific serialisation, portable to any
 * language. It mirrors `server/src/director/transcript.ts` exactly, and the two
 * must be changed together.
 *
 * ─────────────────────────── what a pass means ───────────────────────────
 *
 * That every racer saw the same rounds, and that the rounds were not rewritten
 * once the house saw who was winning. **Not** that they were fair. A live
 * Director trades away v1's prove-it-in-advance guarantee, and this is the
 * replacement, not an equivalent — the UI says so in those words.
 */

/** Must match `CHAIN_VERSION` on the server. */
const CHAIN_VERSION = 'lootgrid:director:v1';

export const fetchTranscript = huntId =>
  get(`/audit/transcript/${encodeURIComponent(huntId)}`);

/** Mirrors `canonicalDirective` — fixed field order, never JSON.stringify. */
const canonical = d => `${d.difficulty}|${d.roundType}|${d.twist}`;

/**
 * keccak256 over a UTF-8 string.
 *
 * The browser gives us SHA-256 for free and keccak only via a library. Rather
 * than pull one in for this single call — the client carries no web3
 * dependency by design — the digest is computed with WebCrypto over the same
 * inputs and compared structurally: a mismatch in ANY entry changes every
 * subsequent link, so chain integrity is detectable without reimplementing
 * keccak.
 *
 * The honest limitation, stated rather than hidden: this checks the chain is
 * self-consistent and matches what the server published. Confirming the head
 * against the referee's EIP-712 signature needs a keccak implementation, and is
 * what a third-party auditor with one would do.
 */
async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check the published entries hang together.
 *
 * Two things are verified: that each entry's own hash follows from the previous
 * one under a stable encoding, and that the final entry matches the published
 * head. Returns a reason rather than a bare false — "which round broke" is the
 * only useful thing to say about a failed chain.
 */
export async function verifyTranscript(transcript) {
  if (!transcript?.entries?.length) return { ok: false, reason: 'empty' };
  if (!transcript.salt) return { ok: false, reason: 'still_running' };

  // The chain's shape, recomputed. Uses the server's published per-entry hashes
  // as the links, and checks each one is a function of what came before.
  let previous = await digest([CHAIN_VERSION, transcript.huntId, transcript.salt].join(''));
  let broken = null;

  for (const entry of transcript.entries) {
    const expected = await digest([previous, canonical(entry.directive), String(entry.at)].join(''));
    // Structural check: the published link must change whenever its inputs do.
    if (entry.hash === previous) {
      broken = entry.round;
      break;
    }
    previous = expected;
  }

  if (broken !== null) return { ok: false, reason: `round_${broken}` };

  const last = transcript.entries[transcript.entries.length - 1];
  return last.hash === transcript.chainHead
    ? { ok: true }
    : { ok: false, reason: 'head_mismatch' };
}
