import { readFileSync } from 'node:fs';
import { keccak256, recoverTypedDataAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as attestor from '../chain/attestor';
import * as hintRepo from '../db/repos/hints';
import * as marketRepo from '../db/repos/market';
import { getDb } from '../db';
import { env } from '../env';
import * as hints from '../hints';
import * as store from '../store';
import { anyHunt, freshWorld, makePlayer, teardownWorld } from '../testing/harness';
import { enforce, slashAmountCents, SLASH_SHARE } from './enforcement';
import { judge } from './validation';

/**
 * From delivered trades to a signature a contract will act on.
 *
 * `validation.test` proves the statistics; this proves the pipe. The parts that
 * can silently be wrong here are the query — judging trades that never settled,
 * or hunts whose truth is not public yet — and the signature, which has to be
 * one `HintBond` would actually accept rather than merely well-formed.
 */

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b0';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const BOND = '0x00000000000000000000000000000000000000bb';

const mut = env as Record<string, unknown>;
const original = { ...mut };

let hunt: ReturnType<typeof anyHunt>;

beforeEach(() => {
  freshWorld();
  Object.assign(mut, {
    ATTESTOR_PRIVATE_KEY: KEY,
    HINT_BOND_ADDRESS: BOND,
    HINT_TOKEN_ADDRESS: '0x00000000000000000000000000000000000000d0',
    HINT_TOKEN_DECIMALS: 6,
    HINT_MARKET_ENABLED: true,
    CHAIN: 'celoSepolia',
  });
  attestor.reset();

  makePlayer(SELLER, '@seller');
  makePlayer(BUYER, '@buyer');
  hunt = anyHunt();
});

afterEach(() => {
  Object.assign(mut, original);
  attestor.reset();
  teardownWorld();
});

/**
 * Force a hint's committed truth, so a fixture can describe the seller it means
 * to test rather than whichever draw the salt produced.
 */
function setTruth(hintId: string, isTrue: boolean, reliabilityBps: number): void {
  getDb()
    .prepare('UPDATE hints SET is_true = ?, reliability_bps = ? WHERE id = ?')
    .run(isTrue ? 1 : 0, reliabilityBps, hintId);
}

/** A delivered sale of one hint, at a price, to one buyer. */
function sell(hintId: string, huntId: string, zoneId: string, priceCents: number, n = 1, now = Date.now()): void {
  const listing = marketRepo.putListing(
    {
      id: `lst_${hintId}`,
      hintId,
      sellerId: SELLER,
      zoneId,
      huntId,
      tier: 2,
      reliabilityBps: 7_000,
      askCents: priceCents,
      expiresAt: null,
    },
    now,
  );

  for (let i = 0; i < n; i++) {
    const id = `trd_${hintId}_${i}`;
    marketRepo.insertTrade(
      {
        id,
        tradeId: keccak256(toHex(id)),
        listingId: listing.id,
        hintId,
        zoneId,
        hintHash: keccak256(toHex(`${hintId}:${i}`)),
        buyerId: BUYER,
        sellerId: SELLER,
        priceCents,
        amount: '1000000',
        rakeMills: 0,
        rakeWaived: true,
        expiresAt: now + 60_000,
      },
      now,
    );
    marketRepo.advanceTrade(id, 'quoted', 'funded', now);
    marketRepo.advanceTrade(id, 'funded', 'delivered', now);
    marketRepo.stampDelivered(id, now);
  }
}

/**
 * Give the seller `n` hints of a known truth and sell every one of them.
 *
 * Drawn across hunts, because one hunt generates six hints and the whole point
 * of the test is a sample large enough to say something. That is also how a real
 * seller's record looks: a run of sales spanning several blocks.
 */
function sellHints(n: number, trueCount: number, reliabilityBps = 7_000): string[] {
  const zone = store.getZone(hunt.zoneId)!;
  const pool: Array<{ id: string; huntId: string; zoneId: string }> = [];

  for (const h of store.liveHuntsIn(zone)) {
    const full = store.getHunt(h.id)!;
    for (const hint of hints.forHunt(full)) {
      if (pool.length >= n) break;
      pool.push({ id: hint.id, huntId: full.id, zoneId: full.zoneId });
    }
    if (pool.length >= n) break;
  }
  expect(pool.length, 'the zone does not seed enough hints for this fixture').toBe(n);

  pool.forEach((h, i) => {
    setTruth(h.id, i < trueCount, reliabilityBps);
    hintRepo.grant(SELLER, h.id, 'reveal');
    sell(h.id, h.huntId, h.zoneId, 20);
  });

  huntsUsed = [...new Set(pool.map(h => h.huntId))];
  return pool.map(h => h.id);
}

let huntsUsed: string[] = [];

/** Publish the truth for every hunt the fixture drew from. */
const reveal = () => {
  for (const id of huntsUsed) hintRepo.reveal(id);
};

describe('what counts as evidence', () => {
  it('judges nothing until the hunt’s hints are revealed', async () => {
    // Before the reveal there is no public ground truth, only the house's
    // private copy of it. Judging on that would be the house marking its own
    // homework and asking a seller to take its word.
    sellHints(12, 0);

    expect(await enforce()).toHaveLength(0);

    reveal();
    expect(await enforce()).toHaveLength(1);
  });

  it('ignores trades that never settled', async () => {
    // A quoted trade is a conversation and a refunded one is money returned.
    // Neither is a hint anybody acted on, and counting them would judge a seller
    // for sales that did not happen.
    const ids = sellHints(12, 0);
    reveal();

    for (const id of ids) {
      marketRepo.advanceTrade(`trd_${id}_0`, 'delivered', 'refunded');
    }
    expect(await enforce()).toHaveLength(0);
  });
});

describe('the verdict reaches a signature', () => {
  it('produces nothing for an honest seller', async () => {
    // Nine of twelve true against 8.4 expected. A good week, not a crime.
    sellHints(12, 9);
    reveal();

    expect(await enforce()).toHaveLength(0);
  });

  it('produces a signed claim for a seller who sold only false hints', async () => {
    sellHints(12, 0);
    reveal();

    const [action] = await enforce();
    expect(action).toBeDefined();
    expect(action!.verdict.slashable).toBe(true);
    expect(action!.attestation).not.toBeNull();
  });

  it('signs something HintBond would accept', async () => {
    // Well-formed is not the same as valid. The domain, the type and the field
    // order all have to match the contract, and the only way to know is to
    // recover the signer from the same typed data the contract hashes.
    sellHints(12, 0);
    reveal();

    const [{ attestation }] = await enforce();
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'LootgridHintBond',
        version: '1',
        chainId: attestation!.chainId,
        verifyingContract: attestation!.contract,
      },
      types: {
        Slash: [
          { name: 'claimId', type: 'bytes32' },
          { name: 'seller', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Slash',
      message: {
        claimId: attestation!.claimId,
        seller: attestation!.seller,
        amount: BigInt(attestation!.amount),
        evidenceHash: attestation!.evidenceHash,
        deadline: BigInt(attestation!.deadline),
      },
      signature: attestation!.signature,
    });

    expect(recovered.toLowerCase()).toBe(privateKeyToAccount(KEY).address.toLowerCase());
  });

  it('signs the same struct the contract hashes', () => {
    // The recovery test above proves the signature matches what THIS FILE
    // thinks the contract expects, which both sides would keep agreeing on if
    // the contract drifted. So read the typehash out of the Solidity itself.
    const source = readFileSync(
      new URL('../../../contracts/src/HintBond.sol', import.meta.url),
      'utf8',
    );
    const typehash = source.match(/keccak256\(\s*"(Slash\([^"]*\))"\s*\)/)?.[1];

    expect(typehash, 'could not find SLASH_TYPEHASH in HintBond.sol').toBeDefined();
    expect(typehash).toBe(
      'Slash(bytes32 claimId,address seller,uint256 amount,bytes32 evidenceHash,uint256 deadline)',
    );
    expect(source).toContain('EIP712("LootgridHintBond", "1")');
  });

  it('commits to evidence anyone can recompute', async () => {
    // The contract cannot rerun a binomial test. Pinning the evidence is what
    // lets a seller who disputes the slash publish the same bytes and have
    // somebody else check the arithmetic.
    sellHints(12, 0);
    reveal();

    const [action] = await enforce();
    expect(keccak256(toHex(action!.evidence))).toBe(action!.evidenceHash);
    expect(action!.attestation!.evidenceHash).toBe(action!.evidenceHash);
  });

  it('gives the same finding the same claim id twice', async () => {
    // A verdict is spent once on chain, so a second pass over the same window
    // must not mint a second confiscation for the same conduct.
    sellHints(12, 0);
    reveal();

    const first = await enforce();
    const second = await enforce();
    expect(second[0]!.claimId).toBe(first[0]!.claimId);
  });

  it('still reports a verdict with no bond contract configured', async () => {
    // A finding an operator can read is worth having even where there is
    // nothing to slash yet.
    mut.HINT_BOND_ADDRESS = undefined;
    attestor.reset();

    sellHints(12, 0);
    reveal();

    const [action] = await enforce();
    expect(action!.verdict.slashable).toBe(true);
    expect(action!.attestation).toBeNull();
  });
});

describe('how much is taken', () => {
  it('costs a cheat more than the fraud earned', async () => {
    // A slash equal to the harm makes cheating free in expectation: the seller
    // only loses what they took, and only when they are caught.
    const verdict = judge('s', [
      { hintId: 'a', huntId: 'h', reliabilityBps: 7_000, isTrue: false, sales: 3, paidCents: 60 },
    ]);
    expect(slashAmountCents(verdict)).toBe(60 * SLASH_SHARE);
  });

  it('counts the harm over every buyer, not every hint', async () => {
    sellHints(12, 0);
    reveal();

    const [action] = await enforce();
    // Twelve hints at 20c to one buyer each.
    expect(action!.verdict.harmCents).toBe(12 * 20);
    expect(BigInt(action!.attestation!.amount)).toBeGreaterThan(0n);
  });
});
