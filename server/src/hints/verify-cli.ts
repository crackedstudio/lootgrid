/**
 * Independent verifier for a zone's hint honesty.
 *
 *   npx tsx src/hints/verify-cli.ts http://localhost:8787 ridge
 *
 * Fetches the public audit endpoint and rechecks everything from scratch:
 *
 *   1. Every revealed hint set still hashes to the commitment published before
 *      the hunt opened — so the house did not revise a truth flag after seeing
 *      who played.
 *   2. Regenerating from the disclosed salt reproduces exactly the set that was
 *      served — so nobody was quietly handed different hints.
 *   3. Observed accuracy per tier is at or above what was advertised.
 *
 * ─────────────────────────── why this file exists ───────────────────────────
 *
 * A guarantee only the server can check is not a guarantee. This deliberately
 * reads nothing but the HTTP response — no database, no server internals — so
 * that anyone can reimplement it. It shares `commit.ts` and `generate.ts` with
 * the server, which is a convenience for us and not a requirement for them:
 * both files are pure and small enough to port.
 *
 * Exits non-zero if anything fails, so it can sit in CI or a cron.
 */
import { commitmentFor, accuracyByTier, withinAdvertised } from './commit';
import { hintsForHunt } from './generate';
import type { HintRecord } from './types';

interface AuditResponse {
  zoneId: string;
  open: Array<{ huntId: string; commitment: string; committedAt: number }>;
  revealed: Array<{
    huntId: string;
    epoch: number;
    commitment: string;
    committedAt: number;
    revealedAt: number;
    salt: string;
    cell: { r: number; c: number };
    hints: Array<{
      idx: number;
      tier: number;
      reliabilityBps: number;
      payload: HintRecord['payload'];
      isTrue: boolean;
    }>;
  }>;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const [base, zoneId] = process.argv.slice(2);
  if (!base || !zoneId) {
    console.error('usage: verify-cli.ts <server-url> <zone-id>');
    process.exit(2);
  }

  const res = await fetch(`${base}/audit/hints/${encodeURIComponent(zoneId)}`);
  if (!res.ok) fail(`audit endpoint returned ${res.status}`);
  const audit = (await res.json()) as AuditResponse;

  console.log(`zone ${audit.zoneId}: ${audit.open.length} open, ${audit.revealed.length} revealed`);

  if (audit.revealed.length === 0) {
    console.log('nothing revealed yet — nothing to check. Come back after a hunt ends.');
    return;
  }

  // Live hunts must disclose a commitment and nothing else. A payload leaking
  // here would hand away the map.
  for (const o of audit.open) {
    if (!o.commitment) fail(`open hunt ${o.huntId} has no commitment`);
    if ('hints' in o || 'salt' in o) fail(`open hunt ${o.huntId} leaked its contents`);
  }

  const all: HintRecord[] = [];
  let commitmentFailures = 0;
  let regenFailures = 0;

  for (const r of audit.revealed) {
    if (r.revealedAt < r.committedAt) {
      fail(`hunt ${r.huntId} claims to have been revealed before it was committed`);
    }

    const set = r.hints.map(h => ({
      ...h,
      id: `${r.huntId}:${h.idx}`,
      huntId: r.huntId,
      zoneId: audit.zoneId,
      epoch: r.epoch,
      expiresAt: null,
    })) as HintRecord[];

    // (1) Does the revealed set still hash to what was published up front?
    if (commitmentFor(r.huntId, r.salt, set) !== r.commitment) {
      console.error(`  ✗ ${r.huntId}: commitment does not match the revealed set`);
      commitmentFailures++;
    }

    // (2) Does the algorithm, run over the disclosed salt, reproduce it?
    const regenerated = hintsForHunt({
      id: r.huntId,
      zoneId: audit.zoneId,
      epoch: r.epoch,
      r: r.cell.r,
      c: r.cell.c,
      salt: r.salt,
      expiresAt: null,
    } as never);

    const served = set.map(h => `${h.idx}|${h.tier}|${h.isTrue}`).join(',');
    const derived = regenerated.map(h => `${h.idx}|${h.tier}|${h.isTrue}`).join(',');
    if (served !== derived) {
      console.error(`  ✗ ${r.huntId}: served hints differ from what the salt generates`);
      regenFailures++;
    }

    all.push(...set);
  }

  // (3) Did the house lie more often than it said it would?
  console.log('\naccuracy by tier:');
  let dishonest = 0;
  let judgedTiers = 0;
  for (const acc of accuracyByTier(all)) {
    const ok = withinAdvertised(acc);
    if (acc.judged) judgedTiers++;
    if (acc.judged && !ok) dishonest++;
    // An unjudged tier is not a pass. Saying so plainly stops a thin sample
    // reading as a clean bill of health.
    const mark = !acc.judged ? '— too few to judge' : ok ? '✓' : '✗ BELOW ADVERTISED';
    console.log(
      `  tier ${acc.tier}: advertised ${(acc.advertisedBps / 100).toFixed(0)}%, ` +
        `observed ${(acc.observedBps / 100).toFixed(1)}% over ${acc.total} hints  ${mark}`,
    );
  }

  console.log('');
  if (commitmentFailures || regenFailures || dishonest) {
    fail(
      `${commitmentFailures} broken commitment(s), ${regenFailures} regeneration mismatch(es), ` +
        `${dishonest} tier(s) below advertised`,
    );
  }

  if (judgedTiers === 0) {
    console.log(
      `✓ commitments all hold over ${all.length} hints, but no tier has enough data to judge ` +
        `accuracy yet. That is not a clean bill of health — come back once hunts have accumulated.`,
    );
  } else {
    console.log(`✓ all checks pass — ${judgedTiers} tier(s) judged over ${all.length} hints`);
  }
}

main().catch(err => fail(String(err)));
