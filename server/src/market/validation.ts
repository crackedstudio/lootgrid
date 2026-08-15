import { getDb } from '../db';

/**
 * Deciding whether a seller cheated.
 *
 * ─────────────────────────── a false hint is not misconduct ─────────────────
 *
 * The tempting version of slashing punishes a seller whose hint turned out
 * false, and it is wrong. Hints are advertised as probabilistic: tier 1 is 90%,
 * tier 3 is a published coin flip, and `hints/types.ts` calls that inverse
 * correlation the reason aggregating weak hints beats trusting one strong one.
 * A tier-3 hint being false is the product working exactly as sold. Slashing for
 * it would be fining a seller for randomness the house generated and the buyer
 * was told the odds of.
 *
 * Nor can a seller lie about the odds. `reliabilityBps` comes from the tier
 * table, is fixed in the phase 2 commitment before anyone plays, and is signed
 * into the vouch by the server's own attestor. There is no field for a seller to
 * misrepresent.
 *
 * ─────────────────────────── what they CAN do is choose ─────────────────────
 *
 * A seller picks *which* of the hints they hold to sell. Someone who can tell
 * their false hints from their true ones — because they hold several for one
 * hunt and can see that two contradict, or because they are playing that hunt
 * and have narrowed the cell — sells the false ones and keeps the rest. The
 * vouch still says 70%. What that seller actually delivers is far worse, and
 * every buyer paid the 70% price.
 *
 * That is adverse selection, it is the real fraud in this market, and it is
 * exactly what a bond should be at risk for. It is also *provable*: the
 * commitment fixed every hint's truth before anyone played, so after the reveal
 * we know both what was promised and what was delivered.
 *
 * ─────────────────────────── two traps in the statistics ────────────────────
 *
 * **Trades are not independent observations.** The same hint can be sold to
 * many buyers, and those sales share one outcome. Counting them as separate
 * trials turns a single unlucky hint into twenty pieces of evidence and will
 * convict an honest seller who happened to list something popular. The test
 * therefore runs over DISTINCT HINTS. The harm — what to actually slash — is
 * counted over trades, because that is where the money was.
 *
 * **Each hint has its own probability.** A seller's sales mix tiers, so this is
 * a Poisson binomial rather than a binomial, and using an average `p` would be a
 * different distribution with different tails. {@link lowerTail} computes it
 * exactly; the sample sizes here are tens, so there is no reason to approximate.
 *
 * ─────────────────────────── what it catches, measured ──────────────────────
 *
 * Simulated against honest sellers and cheats at the shipped thresholds
 * (20k trials per cell, tier mix 90/70/50):
 *
 *     false accusations, honest sellers ......... 0.03%–0.06%  (~1 in 2,500)
 *
 *     caught, by share of sales the seller rigged
 *       hints sold      25%      50%      75%     100%
 *                8     1.8%    14.2%    50.0%    99.5%
 *               20     8.1%    58.2%    97.9%   100.0%
 *               40    17.8%    92.0%   100.0%   100.0%
 *
 * The blatant cheat — sell only what you know is false — is caught essentially
 * always. **A seller who rigs a quarter of their sales is not caught, and no
 * amount of extra data will catch them**, because {@link MIN_SHORTFALL} is a
 * relative effect size: at a 25% cheat rate the realised shortfall settles near
 * 0.25 and never crosses the 0.35 floor, so more evidence lowers the p-value
 * while the effect size stays under the bar. That is the mechanism's honest
 * operating range — it detects rigging above roughly a third of sales, and is
 * deliberately blind below it. The price of catching the subtle cheat is
 * confiscating from honest sellers, and that is not a trade worth making.
 */

/** Distinct hints a seller must have sold before any verdict is possible. */
export const MIN_DISTINCT_HINTS = 8;

/**
 * How unlikely the evidence must be before it is called fraud.
 *
 * One in a thousand, and the reason it is that strict rather than the customary
 * one in twenty is **multiple comparisons**: every seller is tested, so the
 * question is not "could this seller be unlucky" but "could ANY seller be this
 * unlucky". At 0.05 a market with two hundred honest sellers produces ten
 * confiscations a round. At 0.001 it produces one every five rounds, and the
 * effect-size floor below has to be cleared as well.
 *
 * This is the number to raise if a real seller is ever wrongly slashed. It
 * should never be lowered to catch more people.
 */
export const ALPHA = 0.001;

/**
 * The shortfall an accusation must also clear, as a fraction of expectation.
 *
 * A p-value alone will eventually flag someone whose realised rate is a hair
 * under their expected one, given enough sales. That is a seller with bad luck
 * and a large sample, not a fraud, and taking their bond would be a bug that
 * looks like rigour.
 */
export const MIN_SHORTFALL = 0.35;

export interface SoldHint {
  hintId: string;
  huntId: string;
  /** What the vouch promised, in basis points. */
  reliabilityBps: number;
  /** What the commitment revealed. */
  isTrue: boolean;
  /** How many buyers this one hint was sold to. */
  sales: number;
  /** What those buyers paid in total, in cents. */
  paidCents: number;
}

export interface Verdict {
  sellerId: string;
  /** Independent observations: distinct hints, never trades. */
  distinctHints: number;
  /** Sales across those hints. The money, not the evidence. */
  sales: number;
  /** How many true hints the vouched reliabilities predicted. */
  expectedTrue: number;
  observedTrue: number;
  /** P(this few or fewer true hints | the seller was picking at random). */
  pValue: number;
  /** What buyers paid for hints that came out false, in cents. */
  harmCents: number;
  slashable: boolean;
  /** Why not, when not. Present so a near miss is legible rather than silent. */
  reason: 'too_few_hints' | 'within_expectation' | 'shortfall_too_small' | 'slashable';
}

/**
 * The exact lower tail of a Poisson binomial.
 *
 * P(X <= observed) where trial i succeeds with its own probability p_i. Built by
 * convolution, which is O(n²) and exact — with n in the tens there is no case
 * for an approximation whose error nobody has bounded, on a number that decides
 * whether somebody loses money.
 */
export function lowerTail(probabilities: number[], observed: number): number {
  // dist[k] = P(exactly k successes so far).
  let dist = [1];

  for (const p of probabilities) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k]! += dist[k]! * (1 - p);
      next[k + 1]! += dist[k]! * p;
    }
    dist = next;
  }

  let tail = 0;
  for (let k = 0; k <= Math.min(observed, dist.length - 1); k++) tail += dist[k]!;
  return Math.min(1, tail);
}

/**
 * Judge one seller's delivered hints.
 *
 * Pure, so a verdict can be recomputed by anybody holding the same evidence —
 * which is the whole point of pinning `evidenceHash` on chain. A slash nobody
 * else can check is an accusation, not a proof.
 */
export function judge(sellerId: string, sold: SoldHint[]): Verdict {
  const sales = sold.reduce((n, h) => n + h.sales, 0);
  const harmCents = sold.filter(h => !h.isTrue).reduce((n, h) => n + h.paidCents, 0);

  // One trial per distinct hint. Twenty sales of one hint is one observation.
  const probabilities = sold.map(h => h.reliabilityBps / 10_000);
  const expectedTrue = probabilities.reduce((n, p) => n + p, 0);
  const observedTrue = sold.filter(h => h.isTrue).length;

  const base = {
    sellerId,
    distinctHints: sold.length,
    sales,
    expectedTrue,
    observedTrue,
    harmCents,
  };

  if (sold.length < MIN_DISTINCT_HINTS) {
    // A short run of false hints is what an honest seller looks like sometimes.
    return { ...base, pValue: 1, slashable: false, reason: 'too_few_hints' };
  }

  const pValue = lowerTail(probabilities, observedTrue);
  if (pValue > ALPHA) {
    return { ...base, pValue, slashable: false, reason: 'within_expectation' };
  }

  const shortfall = expectedTrue > 0 ? (expectedTrue - observedTrue) / expectedTrue : 0;
  if (shortfall < MIN_SHORTFALL) {
    return { ...base, pValue, slashable: false, reason: 'shortfall_too_small' };
  }

  return { ...base, pValue, slashable: true, reason: 'slashable' };
}

/**
 * What a seller actually delivered, for hunts whose hints are now revealed.
 *
 * Only `delivered` trades count. A quoted trade is a conversation and a refunded
 * one is money returned — neither is a hint anybody acted on, and counting them
 * would let a seller be judged for sales that never happened.
 *
 * Only revealed hunts count, because until the reveal there is no ground truth
 * to compare against, only the house's private copy of it.
 */
export function soldBy(sellerId: string, since = 0): SoldHint[] {
  const rows = getDb()
    .prepare(
      `SELECT t.hint_id           AS hintId,
              h.hunt_id           AS huntId,
              h.reliability_bps   AS reliabilityBps,
              h.is_true           AS isTrue,
              COUNT(*)            AS sales,
              SUM(t.price_cents)  AS paidCents
         FROM hint_trades t
         JOIN hints h  ON h.id = t.hint_id
         JOIN hint_commitments c ON c.hunt_id = h.hunt_id
        WHERE t.seller_id = ?
          AND t.status = 'delivered'
          AND t.delivered_at >= ?
          AND c.revealed_at IS NOT NULL
        GROUP BY t.hint_id`,
    )
    .all(sellerId, since) as Array<{
    hintId: string;
    huntId: string;
    reliabilityBps: number;
    isTrue: number;
    sales: number;
    paidCents: number;
  }>;

  return rows.map(r => ({
    hintId: r.hintId,
    huntId: r.huntId,
    reliabilityBps: r.reliabilityBps,
    isTrue: r.isTrue === 1,
    sales: r.sales,
    paidCents: r.paidCents,
  }));
}

/** Every seller with delivered trades on revealed hunts. */
export function sellersToJudge(since = 0): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.seller_id AS sellerId
         FROM hint_trades t
         JOIN hints h ON h.id = t.hint_id
         JOIN hint_commitments c ON c.hunt_id = h.hunt_id
        WHERE t.status = 'delivered'
          AND t.delivered_at >= ?
          AND c.revealed_at IS NOT NULL`,
    )
    .all(since) as Array<{ sellerId: string }>;

  return rows.map(r => r.sellerId);
}

/**
 * Canonical evidence bytes for a verdict.
 *
 * Fixed field order and sorted hints, not `JSON.stringify` of an object — key
 * and row order are implementation details of whichever runtime produced it, and
 * the point of hashing this is that a seller disputing a slash can rebuild the
 * identical bytes somewhere else. Same rule as `hints/commit.ts` and the
 * Director's transcript.
 */
export function canonicalEvidence(verdict: Verdict, sold: SoldHint[]): string {
  const hints = [...sold]
    .sort((a, b) => (a.hintId < b.hintId ? -1 : a.hintId > b.hintId ? 1 : 0))
    .map(h => `${h.hintId}|${h.reliabilityBps}|${h.isTrue ? 1 : 0}|${h.sales}|${h.paidCents}`)
    .join(',');

  return [
    'lootgrid:validation:v1',
    verdict.sellerId,
    verdict.distinctHints,
    verdict.observedTrue,
    verdict.expectedTrue.toFixed(6),
    verdict.pValue.toExponential(6),
    verdict.harmCents,
    hints,
  ].join('|');
}
