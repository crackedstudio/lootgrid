import { hash } from '../hash';
import type { HintPayload, HintRecord } from './types';

/**
 * Commit-reveal over a hunt's hint set.
 *
 * ─────────────────────────── what this is for ───────────────────────────
 *
 * The house issues the hints, funds the prize, and (from phase 4) charges to
 * enter. Some hints deliberately lie. Without a commitment, "the house fed me a
 * false hint to protect its prize" is unfalsifiable — and an unfalsifiable
 * accusation is corrosive whether or not it is true.
 *
 * So the deception is committed to before the hunt opens and revealed after it
 * closes. Bluffing becomes a mechanic with published parameters, like a dealt
 * card, rather than a stacked deck. See docs/AGENTIC_ARCHITECTURE.md §5.0.
 *
 * ─────────────────────────── what it adds ───────────────────────────
 *
 * A hunt already commits to its cell (`cellCommit`) and reveals `salt` at
 * settlement, and hints are a pure function of those — so a player could
 * already recompute the set. Two things that does *not* cover, which this does:
 *
 *   1. That the hints actually **served** match what the algorithm produces. A
 *      server free to serve something else could tailor hints per player, and
 *      the cell commitment would not notice.
 *   2. What the advertised reliability **was at the time**. Tiers are a promise
 *      to the player; pinning them here stops the promise being quietly revised
 *      after the fact.
 *
 * ─────────────────────────── verifying ───────────────────────────
 *
 * Everything below is deliberately simple enough to reimplement in any language
 * from this file alone — a verification only the server can perform is not a
 * verification. `verify-cli.ts` does exactly that against the public audit
 * endpoint.
 */

/** Bumped if the encoding below ever changes, so old commitments stay checkable. */
export const COMMIT_VERSION = 'lootgrid:hints:v1';

/**
 * Canonical form of one payload: `kind|field|field…`, fields in the fixed order
 * documented per kind. Deliberately not `JSON.stringify` — key order there is an
 * implementation detail of whichever runtime the verifier happens to use, and a
 * commitment that depends on that is not portable.
 */
export function canonicalPayload(p: HintPayload): string {
  switch (p.kind) {
    case 'region':
    case 'exclusion':
      return `${p.kind}|${p.quadrant}`;
    case 'rowBand':
      return `rowBand|${p.from}|${p.to}`;
    case 'colBand':
      return `colBand|${p.from}|${p.to}`;
    case 'parity':
      return `parity|${p.parity}`;
    case 'distance':
      return `distance|${p.r}|${p.c}|${p.within}`;
  }
}

/**
 * Canonical form of one hint, including its truth flag.
 *
 * `isTrue` is inside the commitment and that is the entire point: it is the bit
 * the house could otherwise revise after seeing who played.
 */
export function canonicalHint(h: HintRecord): string {
  return [h.idx, h.tier, h.reliabilityBps, canonicalPayload(h.payload), h.isTrue ? 1 : 0].join('|');
}

/**
 * The commitment published when a hunt is created.
 *
 * Binds the hunt id, its salt, and every hint with its tier, advertised
 * reliability and truth flag. Hints are sorted by index so the digest cannot
 * depend on the order rows came back from storage.
 */
export function commitmentFor(huntId: string, salt: string, hints: HintRecord[]): string {
  const body = [...hints].sort((a, b) => a.idx - b.idx).map(canonicalHint).join('\n');
  return hash(COMMIT_VERSION, huntId, salt, body).toString('hex');
}

/**
 * Recompute and compare. Returns true when the revealed set is exactly what was
 * committed to before the hunt opened.
 */
export function verifyCommitment(
  commitment: string,
  huntId: string,
  salt: string,
  hints: HintRecord[],
): boolean {
  return commitmentFor(huntId, salt, hints) === commitment;
}

// ─────────────────────────── accuracy ───────────────────────────

export interface TierAccuracy {
  tier: number;
  /** What players were told, in basis points. */
  advertisedBps: number;
  /** What actually happened, in basis points. */
  observedBps: number;
  total: number;
  trueCount: number;
  /**
   * Whether there is enough data to say anything at all. Below
   * {@link MIN_SAMPLE} this is false and the tier is excluded from any honesty
   * verdict — see {@link withinAdvertised}.
   */
  judged: boolean;
}

/**
 * Hints per tier before an accuracy figure means anything.
 *
 * A tier-2 hint is advertised at 70%; over two hints, one lie puts the observed
 * rate at 50% and a naive check screams fraud. That is noise, not evidence — and
 * an audit that reports dishonesty on noise teaches everyone to ignore it, which
 * is worse than having no audit. Below this threshold the honest answer is "not
 * enough data yet", and that is what gets reported.
 */
export const MIN_SAMPLE = 50;

/**
 * Observed accuracy per tier over a set of revealed hints.
 *
 * Expect observed to sit at or a little **above** advertised: a decoy sometimes
 * describes a region that happens to contain the real cell, and an accidental
 * truth still counts as one. Materially *below* advertised is the failure this
 * whole scheme exists to make visible.
 */
export function accuracyByTier(hints: HintRecord[]): TierAccuracy[] {
  const buckets = new Map<number, { total: number; trueCount: number; advertisedBps: number }>();

  for (const h of hints) {
    const b = buckets.get(h.tier) ?? { total: 0, trueCount: 0, advertisedBps: h.reliabilityBps };
    b.total += 1;
    if (h.isTrue) b.trueCount += 1;
    buckets.set(h.tier, b);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, b]) => ({
      tier,
      advertisedBps: b.advertisedBps,
      observedBps: b.total === 0 ? 0 : Math.round((b.trueCount / b.total) * 10_000),
      total: b.total,
      trueCount: b.trueCount,
      judged: b.total >= MIN_SAMPLE,
    }));
}

/**
 * Whether observed accuracy is acceptable against what was advertised.
 *
 * One-sided on purpose. Running above the advertised rate is a gift to the
 * player and needs no defence; running below it is the house lying more than it
 * said it would, which is the thing being policed.
 *
 * Returns true for an unjudged tier. That is not a pass — it means "no verdict
 * yet", and callers should surface the distinction rather than let thin data
 * read as a clean bill of health. `judged` on the accuracy row is what says
 * whether the number can be leaned on.
 */
export function withinAdvertised(acc: TierAccuracy, toleranceBps = 500): boolean {
  if (!acc.judged) return true;
  return acc.observedBps >= acc.advertisedBps - toleranceBps;
}
