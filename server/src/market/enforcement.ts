import { keccak256, toHex, type Address, type Hex } from 'viem';
import * as attestor from '../chain/attestor';
import { env } from '../env';
import { logger } from '../logger';
import * as metrics from '../metrics';
import { toTokenUnits } from '../prizes';
import { canonicalEvidence, judge, sellersToJudge, soldBy, type Verdict } from './validation';

/**
 * Acting on a verdict.
 *
 * ─────────────────────────── the consequence is the bond ────────────────────
 *
 * A slashable seller gets a signed claim against their bond, and the loop closes
 * on chain without anything else being needed: the slash lowers `bonded`, and a
 * seller below `minBond` fails `HintBond.canList`. Cheating costs money and then
 * costs the ability to keep trading.
 *
 * Note what this deliberately does NOT do: write negative feedback to the
 * ERC-8004 reputation registry. That registry only accepts ratings from a
 * counterparty with a verified settled trade — `reputation.feedbackOffer`
 * enforces exactly that, because reputation which can be minted by anyone with
 * an opinion is not reputation. The house writing entries about sellers would
 * break the invariant phase 9 was built on, in order to duplicate a consequence
 * the bond already delivers. Buyers still rate their own counterparties; that
 * path is untouched.
 *
 * ─────────────────────────── signing is not submitting ──────────────────────
 *
 * {@link enforce} produces a bearer authorisation and stops. Anyone may relay it
 * to `HintBond.slash`, the same shape as the release attestation, so enforcement
 * does not depend on this process being awake at the right moment. It also means
 * a verdict can be reviewed by a human before it is spent, which for the one
 * mechanism here that takes money from people seems worth the extra step.
 *
 * ─────────────────────────── the Validation Registry ────────────────────────
 *
 * ERC-8004's third registry is where a crypto-economic verdict like this belongs
 * — it is exactly the "stake and slashing" validation model. It is not wired,
 * and the reason is boring rather than principled: **there is no published
 * Validation Registry address for Celo.** The skill's contract tables list
 * Identity and Reputation only, on both mainnet and Sepolia.
 *
 * So the verdict lands in the one place that exists today: our own bond
 * contract. `evidenceHash` is computed the way a registry submission would need
 * it, so wiring one later is a call site rather than a redesign — but claiming
 * that half is done would be claiming an address I do not have.
 */

/** How much of the harm a slash takes. The rest is the cost of being defrauded. */
export const SLASH_SHARE = 2;

export interface Enforcement {
  verdict: Verdict;
  evidence: string;
  evidenceHash: Hex;
  claimId: Hex;
  /** Null when no bond contract is configured — see the header. */
  attestation: attestor.SlashAttestation | null;
}

/**
 * Judge every seller with settled trades on revealed hunts.
 *
 * Runs over a window rather than per hunt, because the finding is statistical: a
 * single hunt can never carry enough distinct hints to say anything, and judging
 * per hunt would be judging the smallest sample available every time.
 */
export async function enforce(since = 0, now = Date.now()): Promise<Enforcement[]> {
  const out: Enforcement[] = [];

  for (const sellerId of sellersToJudge(since)) {
    try {
      const sold = soldBy(sellerId, since);
      const verdict = judge(sellerId, sold);

      metrics.sellerVerdicts.inc({ reason: verdict.reason });
      if (!verdict.slashable) continue;

      const evidence = canonicalEvidence(verdict, sold);
      const evidenceHash = keccak256(toHex(evidence));
      // Derived from the evidence, so the same finding cannot be spent twice and
      // a second run over the same window is idempotent on chain.
      const claimId = keccak256(toHex(`lootgrid:claim:v1|${sellerId}|${evidenceHash}`));

      logger.warn(
        {
          sellerId,
          distinctHints: verdict.distinctHints,
          expectedTrue: verdict.expectedTrue.toFixed(2),
          observedTrue: verdict.observedTrue,
          pValue: verdict.pValue,
          harmCents: verdict.harmCents,
        },
        'seller found to be selecting false hints',
      );

      out.push({
        verdict,
        evidence,
        evidenceHash,
        claimId,
        attestation: await signClaim(claimId, sellerId, verdict, evidenceHash, now),
      });
      metrics.sellerSlashClaims.inc();
    } catch (err) {
      // One seller's verdict failing must not stop the others being judged.
      logger.warn({ err, sellerId }, 'enforcement failed for a seller');
    }
  }

  return out;
}

/**
 * How much to take.
 *
 * A multiple of the harm, so that defrauding buyers is worse than not — a slash
 * equal to the harm would make cheating free in expectation, since a seller only
 * loses what they took and only when they are caught. Capped by the bond in the
 * contract rather than here: this function does not know what is posted, and
 * `HintBond.slash` takes what exists rather than reverting.
 */
export function slashAmountCents(verdict: Verdict): number {
  return verdict.harmCents * SLASH_SHARE;
}

async function signClaim(
  claimId: Hex,
  sellerId: string,
  verdict: Verdict,
  evidenceHash: Hex,
  now: number,
): Promise<attestor.SlashAttestation | null> {
  // No bond contract configured means nothing to slash, and a verdict with no
  // signature is still worth returning — an operator can read it.
  if (!attestor.bondEnabled()) return null;

  return attestor.signSlash(
    claimId,
    sellerId as Address,
    toTokenUnits(slashAmountCents(verdict), env.HINT_TOKEN_DECIMALS),
    evidenceHash,
    now,
  );
}
