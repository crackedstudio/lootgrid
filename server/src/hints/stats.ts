import * as hintRepo from '../db/repos/hints';
import * as huntRepo from '../db/repos/hunts';
import { accuracyByTier, commitmentFor, withinAdvertised, type TierAccuracy } from './commit';
import type { HintRecord } from './types';

/**
 * Public audit of a zone's hint honesty.
 *
 * Assembled entirely from data a player could gather themselves — the point is
 * to hand them the arithmetic, not to ask them to trust our version of it.
 * `verify-cli.ts` recomputes all of this from the same endpoint.
 */

export interface RevealedHunt {
  huntId: string;
  epoch: number;
  commitment: string;
  version: string;
  committedAt: number;
  revealedAt: number;
  /** Disclosed only once the hunt is over — it is what makes the set checkable. */
  salt: string;
  cell: { r: number; c: number };
  hints: Array<{
    idx: number;
    tier: number;
    reliabilityBps: number;
    payload: HintRecord['payload'];
    isTrue: boolean;
  }>;
  /** Whether the revealed set still hashes to what was published up front. */
  commitmentHolds: boolean;
}

export interface ZoneHintAudit {
  zoneId: string;
  /** Live hunts: commitment only. Publishing more would give the game away. */
  open: Array<{ huntId: string; epoch: number; commitment: string; committedAt: number }>;
  revealed: RevealedHunt[];
  accuracy: TierAccuracy[];
  /**
   * The verdict, kept honest about its own limits:
   *
   *   'ok'           every commitment held and every judged tier met its promise
   *   'insufficient' commitments hold, but no tier has enough data yet
   *   'breach'       a commitment failed, or a judged tier came in below advertised
   *
   * Deliberately three states rather than a boolean. A zone with four revealed
   * hints is not honest and not dishonest — it is unmeasured, and saying so
   * beats a verdict that means nothing.
   */
  verdict: 'ok' | 'insufficient' | 'breach';
}

/**
 * Everything needed to audit one zone.
 *
 * Live hunts contribute their commitment and nothing else. Finished hunts
 * contribute the whole set, including the truth flags, plus the salt that lets
 * anyone regenerate it from scratch and confirm the two agree.
 */
export function auditZone(zoneId: string, limit = 50): ZoneHintAudit {
  const open = hintRepo.liveCommitments(zoneId, limit).map(c => ({
    huntId: c.huntId,
    epoch: c.epoch,
    commitment: c.commitment,
    committedAt: c.committedAt,
  }));

  const revealed: RevealedHunt[] = [];
  const allHints: HintRecord[] = [];

  for (const c of hintRepo.revealedCommitments(zoneId, limit)) {
    const hunt = huntRepo.get(c.huntId);
    if (!hunt) continue;
    const set = hintRepo.forHunt(c.huntId);
    if (set.length === 0) continue;

    allHints.push(...set);
    revealed.push({
      huntId: c.huntId,
      epoch: c.epoch,
      commitment: c.commitment,
      version: c.version,
      committedAt: c.committedAt,
      revealedAt: c.revealedAt!,
      salt: hunt.salt,
      cell: { r: hunt.r, c: hunt.c },
      hints: set.map(h => ({
        idx: h.idx,
        tier: h.tier,
        reliabilityBps: h.reliabilityBps,
        payload: h.payload,
        isTrue: h.isTrue,
      })),
      // Checked server-side too, so a mismatch shows up in our own monitoring
      // rather than waiting for a player to notice.
      commitmentHolds: commitmentFor(c.huntId, hunt.salt, set) === c.commitment,
    });
  }

  const accuracy = accuracyByTier(allHints);

  // A broken commitment is a breach regardless of sample size — it is proof of
  // tampering, not a statistical claim, so one is enough.
  const commitmentsHold = revealed.every(r => r.commitmentHolds);
  const judged = accuracy.filter(a => a.judged);

  const verdict: ZoneHintAudit['verdict'] = !commitmentsHold
    ? 'breach'
    : judged.some(a => !withinAdvertised(a))
      ? 'breach'
      : judged.length === 0
        ? 'insufficient'
        : 'ok';

  return { zoneId, open, revealed, accuracy, verdict };
}
