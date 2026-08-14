import { keccak256, toHex, type Hex } from 'viem';
import { canonicalDirective, type Directive } from './types';

/**
 * The hash chain that replaces commit-reveal.
 *
 * ─────────────────────────── what a live Director costs ─────────────────────
 *
 * v1 proved fairness up front: the salt fixed the game before anyone entered,
 * so the house could not have rigged it. A Director choosing rounds while the
 * hunt runs destroys that guarantee outright — the game is no longer decided in
 * advance, so no commitment made in advance can cover it.
 *
 * Architecture §4 says to replace it rather than quietly drop it. Every
 * directive is chained:
 *
 *     h₀ = keccak(huntId ‖ salt)
 *     hₙ = keccak(hₙ₋₁ ‖ directiveₙ ‖ timestampₙ)
 *
 * The head is signed and published with the resolution; the transcript is
 * published alongside it. Anyone can recompute the chain and check the head.
 *
 * ─────────────────────────── a weaker guarantee, stated ─────────────────────
 *
 * This is worth being precise about, because it is easy to imply more than it
 * delivers:
 *
 *   | commit-reveal | proves the game was not rigged IN ADVANCE            |
 *   | hash chain    | proves it was not rigged DIFFERENTLY PER PLAYER,     |
 *   |               | and not rewritten after seeing who was winning       |
 *
 * The house still chooses each round as the hunt runs. What it cannot do is
 * choose differently for you than for the player beside you, or go back and
 * change what it chose once it saw the result. That makes an unfair hunt
 * detectable and refundable afterwards rather than impossible up front — a real
 * downgrade, honestly labelled.
 *
 * ─────────────────────────── it must cover the fallbacks too ────────────────
 *
 * Every issued directive is appended, whether it came from the model or from
 * `fallback.ts`. A chain that recorded only the model's rounds would be a
 * transcript with holes exactly where the interesting question is — which
 * rounds did the Director actually decide?
 */

/** Bumped if the encoding changes, so old transcripts stay checkable. */
export const CHAIN_VERSION = 'lootgrid:director:v1';

export interface Entry {
  round: number;
  directive: Directive;
  /** Server clock, milliseconds. Inside the hash, so it cannot be backdated. */
  at: number;
  /** The chain head after this entry. */
  hash: Hex;
}

/**
 * The chain's starting point, from the same two values the hunt already commits
 * to. Anyone holding a revealed salt can compute it without our help.
 */
export function genesis(huntId: string, salt: string): Hex {
  return keccak256(toHex([CHAIN_VERSION, huntId, salt].join('')));
}

/**
 * Extend the chain by one directive.
 *
 * Pure, and deliberately takes the previous hash rather than reading state: the
 * verifier reimplements exactly this, and a function that reached for a database
 * could not be reimplemented at all.
 */
export function extend(previous: Hex, directive: Directive, at: number): Hex {
  return keccak256(
    toHex([previous, canonicalDirective(directive), String(at)].join('')),
  );
}

/**
 * A hunt's transcript, in memory while it runs.
 *
 * Append-only by construction — there is no method that edits an entry, and the
 * hash of every later entry depends on every earlier one, so editing one would
 * be visible even if there were.
 */
export class Transcript {
  readonly huntId: string;
  private entries: Entry[] = [];
  private head: Hex;

  constructor(huntId: string, salt: string) {
    this.huntId = huntId;
    this.head = genesis(huntId, salt);
  }

  /** The current chain head. Published with the resolution. */
  get chainHead(): Hex {
    return this.head;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Every entry, oldest first. Copied, so a caller cannot mutate the chain. */
  list(): Entry[] {
    return this.entries.map(e => ({ ...e }));
  }

  /**
   * Record an issued directive.
   *
   * Called for fallback rounds as well as model rounds — see the header. Returns
   * the new head so the caller can publish it without reaching back in.
   */
  append(round: number, directive: Directive, at: number): Hex {
    this.head = extend(this.head, directive, at);
    this.entries.push({ round, directive, at, hash: this.head });
    return this.head;
  }
}

/**
 * Recompute a transcript from scratch and compare it to a published head.
 *
 * Deliberately simple enough to port: `keccak256`, a separator and string
 * concatenation. A verification only this server can perform would not be a
 * verification, and the whole reason the chain exists is that players can check
 * it themselves.
 */
export function verify(
  huntId: string,
  salt: string,
  entries: Array<{ directive: Directive; at: number }>,
  publishedHead: string,
): boolean {
  let head = genesis(huntId, salt);
  for (const entry of entries) head = extend(head, entry.directive, entry.at);
  return head.toLowerCase() === publishedHead.toLowerCase();
}
