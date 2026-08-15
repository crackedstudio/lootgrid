import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as erc8004 from '../chain/erc8004';
import * as marketRepo from '../db/repos/market';
import { env } from '../env';
import * as hints from '../hints';
import { anyHunt, freshWorld, teardownWorld } from '../testing/harness';
import * as reputation from './reputation';

/**
 * Reputation.
 *
 * ERC-8004 blocks self-feedback and does nothing about two wallets rating each
 * other, which costs an attacker one extra keypair. So the test that matters is
 * not "does the number come back" — it is **how much does a fake reputation
 * cost compared with a real one**, and the answer has to be "a lot more".
 *
 * The plan is explicit that this cannot be prevented, only priced: detect and
 * slash, not prevent. These tests measure the price.
 */

const HONEST = '0x00000000000000000000000000000000000000a1';
const WASH_A = '0x00000000000000000000000000000000000000b1';
const WASH_B = '0x00000000000000000000000000000000000000b2';

const mut = env as { AGENTS_ENABLED: boolean; RPC_URL?: string; CHAIN: 'celo' | 'celoSepolia' };
const original = { ...mut };

let seq = 0;
let hintIds: string[] = [];

/**
 * A settled trade — the only kind that counts.
 *
 * Built on a real listing and a real hint rather than invented ids: the
 * foreign keys in `007_market.sql` exist precisely so a trade cannot reference
 * something that never happened, and a test that bypassed them would be
 * measuring a shape the ledger cannot hold.
 */
function trade(buyer: string, seller: string, priceCents: number, status = 'delivered') {
  seq += 1;
  const id = `trd_${seq}`;
  const hintId = hintIds[seq % hintIds.length]!;
  const listingId = `lst_${seq}`;

  // One live listing per (hint, seller): the repo reuses the row rather than
  // creating a second, so the id it returns is the one the trade must point at.
  const listing = marketRepo.putListing({
    id: listingId,
    hintId,
    sellerId: seller,
    zoneId: 'ridge',
    huntId: hintId.split(':')[0]!,
    tier: 2,
    reliabilityBps: 7_000,
    askCents: priceCents,
    expiresAt: null,
  });

  marketRepo.insertTrade({
    id,
    tradeId: `0x${seq.toString(16).padStart(64, '0')}`,
    listingId: listing.id,
    hintId,
    zoneId: 'ridge',
    hintHash: `0x${'ab'.repeat(32)}`,
    buyerId: buyer,
    sellerId: seller,
    priceCents,
    amount: String(priceCents * 10 ** 16),
    rakeMills: 0,
    rakeWaived: true,
    expiresAt: Date.now() + 600_000,
  });
  if (status === 'delivered') {
    marketRepo.advanceTrade(id, 'quoted', 'delivered');
  }
  return id;
}

beforeEach(() => {
  freshWorld();
  reputation.reset();
  seq = 0;
  hintIds = hints.forHunt(anyHunt()).map(h => h.id);
  mut.AGENTS_ENABLED = true;
  mut.RPC_URL = 'http://localhost:0';
  mut.CHAIN = 'celoSepolia';

  // A perfect registry score for everybody, so the weighting is what varies.
  erc8004.setTransportForTests(
    async () => ({ count: 10, value: 100, clients: [] }),
    async () => '0xhash',
  );
  for (const a of [HONEST, WASH_A, WASH_B]) reputation.recordRegistration(a, 1n);
});

afterEach(() => {
  Object.assign(mut, original);
  erc8004.setTransportForTests(null, null);
  reputation.reset();
  teardownWorld();
});

describe('a perfect score means nothing on its own', () => {
  it('is worth zero with no trades behind it', async () => {
    // The registry says 100. Nobody has ever traded with them. An agent acting
    // on the raw number would be acting on somebody's say-so.
    const report = await reputation.trustFor(HONEST);
    expect(report.rawValue).toBe(100);
    expect(report.trust).toBe(0);
  });

  it('is worth little from one cheap counterparty', async () => {
    trade(HONEST, WASH_A, 2);
    const report = await reputation.trustFor(HONEST);

    expect(report.verifiedTrades).toBe(1);
    // "Somebody said they were good once" is worth about what it sounds like.
    expect(report.trust).toBeLessThan(10);
  });

  it('does not count intentions', async () => {
    // Quoted and abandoned trades are free to create. Only what the referee
    // watched settle counts.
    trade(HONEST, WASH_A, 200, 'quoted');
    expect((await reputation.trustFor(HONEST)).verifiedTrades).toBe(0);
  });
});

describe('what a real reputation looks like', () => {
  it('rises with genuine breadth and stake', async () => {
    // Five different counterparties, real money, one direction each.
    for (let i = 0; i < 5; i++) {
      trade(HONEST, `0x${'c'.repeat(39)}${i}`, 200);
    }

    const report = await reputation.trustFor(HONEST);
    expect(report.distinctCounterparties).toBe(5);
    expect(report.washRiskBps).toBeLessThan(2_000);
    expect(report.trust).toBeGreaterThan(80);
  });

  it('treats a busy honest trader as honest', async () => {
    // Two-way volume spread across many partners. What makes them a market
    // rather than a ring is that they trade with the world, not only with each
    // other — six wallets that deal solely with you are indistinguishable from
    // a ring, and should be.
    for (let i = 0; i < 6; i++) {
      const other = `0x${'d'.repeat(39)}${i}`;
      trade(HONEST, other, 150);
      trade(other, HONEST, 150);
      trade(other, `0x${'8'.repeat(39)}${i}`, 150);
      trade(`0x${'9'.repeat(39)}${i}`, other, 150);
    }

    const report = await reputation.trustFor(HONEST);
    expect(report.washRiskBps).toBeLessThan(6_000);
    expect(report.trust).toBeGreaterThan(40);
  });

  it('flags a ring that a pair check would miss', async () => {
    // The weakness measurement found: five wallets trading in a circle spread
    // their volume, so concentration reads low and the pair check clears them.
    // Closure is what sees it — a ring has nobody else to trade with.
    const ring = Array.from({ length: 5 }, (_, i) => `0x${'a'.repeat(39)}${i}`);
    for (const a of ring) {
      for (const b of ring) {
        if (a === b) continue;
        trade(a, b, 200);
      }
    }

    const report = await reputation.trustFor(ring[0]!);
    expect(report.distinctCounterparties).toBe(4);
    expect(report.washRiskBps).toBeGreaterThan(8_000);
    expect(report.trust).toBeLessThan(25);
  });
});

describe('what a wash pair costs', () => {
  it('barely moves however many times the same two trade', async () => {
    // The attack: two wallets, one owner, trading back and forth.
    for (let i = 0; i < 20; i++) {
      trade(WASH_A, WASH_B, 200);
      trade(WASH_B, WASH_A, 200);
    }

    const report = await reputation.trustFor(WASH_A);
    expect(report.verifiedTrades).toBe(40);
    // Round-tripping with one partner is the signature.
    expect(report.washRiskBps).toBeGreaterThan(9_000);
    expect(report.trust).toBeLessThan(10);
  });

  it('is not helped by trading larger', async () => {
    // Per-counterparty capping is what makes more volume with the same partner
    // buy nothing at all.
    for (let i = 0; i < 5; i++) {
      trade(WASH_A, WASH_B, 500);
      trade(WASH_B, WASH_A, 500);
    }
    const rich = await reputation.trustFor(WASH_A);

    reputation.reset();
    freshWorld();
    hintIds = hints.forHunt(anyHunt()).map(h => h.id);
    for (const a of [WASH_A, WASH_B]) reputation.recordRegistration(a, 1n);
    for (let i = 0; i < 5; i++) {
      trade(WASH_A, WASH_B, 50);
      trade(WASH_B, WASH_A, 50);
    }
    const poor = await reputation.trustFor(WASH_A);

    expect(rich.trust).toBe(poor.trust);
  });

  it('is beaten by an honest trader with a fraction of the volume', async () => {
    // The comparison that decides whether any of this is worth doing.
    for (let i = 0; i < 20; i++) {
      trade(WASH_A, WASH_B, 200);
      trade(WASH_B, WASH_A, 200);
    }
    for (let i = 0; i < 5; i++) {
      trade(HONEST, `0x${'e'.repeat(39)}${i}`, 200);
    }

    const wash = await reputation.trustFor(WASH_A);
    const honest = await reputation.trustFor(HONEST);

    // 8000c of washing loses to 1000c of trading with five real people.
    expect(honest.trust).toBeGreaterThan(wash.trust * 5);
  });

  it('needs many wallets, not many trades', async () => {
    // Stated as a test because it is the actual cost model: reputation is
    // priced in *counterparties*, and each one is a fresh wallet with a real
    // balance that pays rake on every pass.
    for (let i = 0; i < 5; i++) {
      trade(WASH_A, `0x${'f'.repeat(39)}${i}`, 200);
    }
    const spread = await reputation.trustFor(WASH_A);

    expect(spread.trust).toBeGreaterThan(80);
    expect(spread.distinctCounterparties).toBe(5);
  });
});

describe('the wash signal itself', () => {
  it('is high only when volume is both two-way and concentrated', () => {
    const oneWayOnePartner = new Map([['b', { cents: 100, asBuyer: 100, asSeller: 0 }]]);
    const twoWayManyPartners = new Map([
      ['b', { cents: 100, asBuyer: 50, asSeller: 50 }],
      ['c', { cents: 100, asBuyer: 50, asSeller: 50 }],
      ['d', { cents: 100, asBuyer: 50, asSeller: 50 }],
      ['e', { cents: 100, asBuyer: 50, asSeller: 50 }],
    ]);
    const twoWayOnePartner = new Map([['b', { cents: 100, asBuyer: 50, asSeller: 50 }]]);

    // A new trader who only bought, from one seller. Ordinary.
    expect(reputation.washRisk(oneWayOnePartner)).toBe(0);
    // A market maker. Two-way, but spread — damped, not flagged.
    expect(reputation.washRisk(twoWayManyPartners)).toBeLessThan(3_000);
    // Both at once. The signature.
    expect(reputation.washRisk(twoWayOnePartner)).toBeGreaterThan(9_000);
  });

  it('is zero with nothing to measure', () => {
    expect(reputation.washRisk(new Map())).toBe(0);
  });
});

describe('feedback needs a trade behind it', () => {
  it('refuses when the two have never settled anything', () => {
    // Reputation that can be minted by talking is not reputation.
    expect(reputation.feedbackOffer(HONEST, WASH_A, 90)).toBeNull();
  });

  it('refuses on an unsettled trade', () => {
    trade(HONEST, WASH_A, 100, 'quoted');
    expect(reputation.feedbackOffer(HONEST, WASH_A, 90)).toBeNull();
  });

  it('prepares a transaction the PLAYER sends, bound to the trade', () => {
    trade(HONEST, WASH_A, 100);
    const offer = reputation.feedbackOffer(HONEST, WASH_A, 90)!;

    expect(offer).toBeTruthy();
    expect(offer.tradeRef).toMatch(/^0x/);
    expect(offer.call.to).toBe(erc8004.reputationAddress());
    // Feedback signed by a house key would be the house rating agents, which is
    // a much weaker signal than a counterparty rating who they paid.
    expect(offer.value).toBe(90);
  });

  it('refuses for an agent that was never registered', () => {
    reputation.reset();
    trade(HONEST, WASH_A, 100);
    expect(reputation.feedbackOffer(HONEST, WASH_A, 90)).toBeNull();
  });
});

describe('the gate before money moves', () => {
  it('lets a genuine newcomer in', async () => {
    // Never rated, never traded. A market that refuses everyone unrated can
    // never admit anybody — unrated is unknown, not bad, and the weighting
    // already makes unknown cheap to a cautious agent.
    const newcomer = `0x${'7'.repeat(40)}`;
    expect(await reputation.acceptable(newcomer, 50)).toBe(true);
  });

  it('turns away someone rated but never traded', async () => {
    // The other half, and the reason the first is safe: praise with no settled
    // trade behind it is exactly what a wash farm produces first.
    expect(await reputation.acceptable(HONEST, 50)).toBe(false);
  });

  it('turns away a counterparty that has been weighed and found wanting', async () => {
    for (let i = 0; i < 10; i++) {
      trade(WASH_A, WASH_B, 200);
      trade(WASH_B, WASH_A, 200);
    }
    expect(await reputation.acceptable(WASH_A, 50)).toBe(false);
  });

  it('is off when the threshold is zero', async () => {
    expect(await reputation.acceptable(WASH_A, 0)).toBe(true);
  });

  it('treats a registry outage as unrated, never as untrusted', async () => {
    erc8004.setTransportForTests(
      async () => {
        throw new Error('rpc down');
      },
      async () => '0xhash',
    );
    trade(HONEST, WASH_A, 200);

    // An outage that blacklisted every agent would take the market down with it.
    const report = await reputation.trustFor(HONEST);
    expect(report.rawValue).toBe(0);
    await expect(reputation.acceptable('0x' + '9'.repeat(40), 50)).resolves.toBe(true);
  });
});
