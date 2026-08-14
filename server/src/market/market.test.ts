import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as attestor from '../chain/attestor';
import * as escrowRead from '../chain/hintEscrow';
import { OnChainStatus } from '../chain/hintEscrow';
import * as hintRepo from '../db/repos/hints';
import * as marketRepo from '../db/repos/market';
import { env } from '../env';
import * as hints from '../hints';
import * as store from '../store';
import { anyHunt, freshWorld, makePlayer, teardownWorld } from '../testing/harness';
import type { Hunt, Player } from '../types';
import * as market from './index';

/**
 * The market's state machine.
 *
 * Everything here is about one question: **can anyone end up with a hint they
 * did not pay for, or money they did not earn?** The order of operations is the
 * only thing standing between the two, so most of these tests are about the
 * order rather than about features.
 */

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b0';
const THIRD = '0x00000000000000000000000000000000000000c0';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ESCROW_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const HINT_ESCROW = '0x00000000000000000000000000000000000000e7';
const TOKEN = '0x00000000000000000000000000000000000000d0';

const mut = env as {
  ATTESTOR_PRIVATE_KEY?: string;
  LOOTGRID_ACTIONS_ADDRESS?: string;
  ESCROW_PRIVATE_KEY?: string;
  LOOTGRID_ESCROW_ADDRESS?: string;
  HINT_ESCROW_ADDRESS?: string;
  HINT_TOKEN_ADDRESS?: string;
  HINT_MARKET_ENABLED: boolean;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = { ...mut };

/** The chain, as far as these tests are concerned. */
const onChain = new Map<string, escrowRead.OnChainTrade>();

let seller: Player;
let buyer: Player;
let hunt: Hunt;
let hintId: string;

beforeEach(() => {
  freshWorld();
  onChain.clear();

  mut.ATTESTOR_PRIVATE_KEY = KEY;
  mut.LOOTGRID_ACTIONS_ADDRESS = '0x00000000000000000000000000000000000000ac';
  mut.ESCROW_PRIVATE_KEY = ESCROW_KEY;
  mut.LOOTGRID_ESCROW_ADDRESS = '0x00000000000000000000000000000000000000e5';
  mut.HINT_ESCROW_ADDRESS = HINT_ESCROW;
  mut.HINT_TOKEN_ADDRESS = TOKEN;
  mut.HINT_MARKET_ENABLED = true;
  mut.CHAIN = 'celoSepolia';
  attestor.reset();

  escrowRead.setReaderForTests(async tradeId => {
    const t = onChain.get(tradeId.toLowerCase());
    if (t) return t;
    return {
      buyer: '0x0000000000000000000000000000000000000000',
      seller: '0x0000000000000000000000000000000000000000',
      amount: 0n,
      expiresAt: 0,
      status: OnChainStatus.None,
      hintHash: `0x${'00'.repeat(32)}`,
    };
  });

  seller = makePlayer(SELLER, '@seller');
  buyer = makePlayer(BUYER, '@buyer');

  hunt = anyHunt();
  const set = hints.forHunt(hunt);
  hintId = set[0]!.id;
  hintRepo.grant(seller.id, hintId, 'reveal');
});

afterEach(() => {
  Object.assign(mut, original);
  attestor.reset();
  escrowRead.setReaderForTests(null);
  teardownWorld();
});

/** Pretend the buyer sent the funding transaction the quote handed them. */
function fundOnChain(quote: market.Quote, over: Partial<escrowRead.OnChainTrade> = {}): void {
  onChain.set(quote.onChainId.toLowerCase(), {
    buyer: buyer.id as Hex,
    seller: quote.sellerId as Hex,
    amount: BigInt(quote.amount),
    expiresAt: Math.floor(quote.expiresAt / 1000),
    status: OnChainStatus.Funded,
    hintHash: quote.vouch.hintHash,
    ...over,
  } as escrowRead.OnChainTrade);
}

function settleOnChain(quote: market.Quote): void {
  const t = onChain.get(quote.onChainId.toLowerCase())!;
  onChain.set(quote.onChainId.toLowerCase(), { ...t, status: OnChainStatus.Settled });
}

async function sell(askCents = 10): Promise<market.Quote> {
  market.list(seller, hintId, askCents);
  const listing = market.browse(hunt.zoneId)[0]!;
  return market.buy(buyer, listing.id);
}

// ── listing ──────────────────────────────────────────────────────────────────

describe('listing a hint', () => {
  it('publishes the claim without publishing the hint', () => {
    market.list(seller, hintId, 10);
    const [listing] = market.browse(hunt.zoneId);

    expect(listing).toBeDefined();
    expect(listing!.tier).toBeGreaterThan(0);
    expect(listing!.reliabilityBps).toBeGreaterThan(0);
    // The buyer learns the odds and the zone. The payload is the thing being
    // sold, and no browse response may ever carry it.
    expect(JSON.stringify(listing)).not.toContain('quadrant');
    expect(listing).not.toHaveProperty('payload');
  });

  it('refuses a hint the seller does not hold', () => {
    const other = hints.forHunt(hunt)[1]!.id;
    expect(() => market.list(seller, other, 10)).toThrow(/not_your_hint/);
  });

  it('refuses dust', () => {
    expect(() => market.list(seller, hintId, 0)).toThrow();
  });

  it('refuses to sell hints about a hunt that is over', () => {
    // A hint about a settled hunt is worth nothing, and selling one is the
    // clearest possible way to poison a market this young.
    store.setHuntStatus(store.getHunt(hunt.id)!, 'resolved', seller.id);
    expect(() => market.list(seller, hintId, 10)).toThrow(/hunt_not_live/);
  });

  it('refuses to quote against a hunt that ends mid-trade', async () => {
    market.list(seller, hintId, 10);
    const listing = market.browse(hunt.zoneId)[0]!;
    store.setHuntStatus(store.getHunt(hunt.id)!, 'expired');

    // The buyer would otherwise escrow money for directions to a hunt that no
    // longer exists, and have nothing but the refund path for recourse.
    await expect(market.buy(buyer, listing.id)).rejects.toThrow(/hunt_not_live/);
  });

  it('relists rather than duplicating', () => {
    market.list(seller, hintId, 10);
    market.list(seller, hintId, 20);
    const listings = market.browse(hunt.zoneId);
    expect(listings).toHaveLength(1);
    expect(listings[0]!.askCents).toBe(20);
  });

  it('is off when the market is not configured', () => {
    mut.HINT_MARKET_ENABLED = false;
    expect(market.enabled()).toBe(false);
    expect(() => market.list(seller, hintId, 10)).toThrow(/market_disabled/);
  });
});

// ── bids ─────────────────────────────────────────────────────────────────────

describe('bidding', () => {
  it('takes an offer below the ask and lets the seller accept it', async () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;

    const bid = market.bid(buyer, listing.id, 12);
    expect(market.bidsFor(seller, listing.id)).toHaveLength(1);

    const quote = await market.acceptBid(seller, bid.id);
    // Accepting quotes the bidder at their price — it does not move money.
    expect(quote.priceCents).toBe(12);
    expect(marketRepo.getTrade(quote.tradeId)!.buyerId).toBe(buyer.id);
  });

  it('refuses a bid at or above the ask', () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;
    // There is nothing to negotiate at the ask — take it instead.
    expect(() => market.bid(buyer, listing.id, 20)).toThrow(/bid_at_or_above_ask/);
  });

  it('refuses a bid on your own listing', () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;
    expect(() => market.bid(seller, listing.id, 5)).toThrow(/own_listing/);
  });

  it('keeps the book private to the seller', () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;
    market.bid(buyer, listing.id, 12);

    // A rival reading the book learns what another agent thinks a hint is
    // worth — information they did not pay for.
    const rival = makePlayer(THIRD, '@rival');
    expect(() => market.bidsFor(rival, listing.id)).toThrow(/not_your_listing/);
  });

  it('moves an existing bid rather than stacking them', () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;
    market.bid(buyer, listing.id, 5);
    market.bid(buyer, listing.id, 9);

    const book = market.bidsFor(seller, listing.id);
    expect(book).toHaveLength(1);
    expect(book[0]!.priceCents).toBe(9);
  });
});

// ── the order of operations ──────────────────────────────────────────────────

describe('buying', () => {
  it('quotes without delivering anything', async () => {
    const quote = await sell();

    expect(quote.vouch.tier).toBeGreaterThan(0);
    expect(quote.call.to).toBe(HINT_ESCROW);
    // The allowance is for exactly this trade — an infinite approval to a young
    // escrow is a standing invitation for any future bug in it.
    expect(quote.approval.to).toBe(TOKEN);
    expect(quote.approval.data).toContain(HINT_ESCROW.slice(2));
    expect(marketRepo.getTrade(quote.tradeId)!.status).toBe('quoted');
    // Nothing has been paid, so nothing has been handed over.
    expect(hintRepo.holds(buyer.id, hintId)).toBe(false);
  });

  it('refuses to sell you your own listing', async () => {
    market.list(seller, hintId, 10);
    const listing = market.browse(hunt.zoneId)[0]!;
    await expect(market.buy(seller, listing.id)).rejects.toThrow(/own_listing/);
  });

  it('refuses to sell a hint the buyer already holds', async () => {
    hintRepo.grant(buyer.id, hintId, 'reveal');
    market.list(seller, hintId, 10);
    const listing = market.browse(hunt.zoneId)[0]!;
    await expect(market.buy(buyer, listing.id)).rejects.toThrow(/already_held/);
  });

  it('reuses an unfunded quote instead of issuing a second trade id', async () => {
    market.list(seller, hintId, 10);
    const listing = market.browse(hunt.zoneId)[0]!;

    const first = await market.buy(buyer, listing.id);
    const second = await market.buy(buyer, listing.id);
    // Two trade ids would be two chances to fund the same purchase twice.
    expect(second.tradeId).toBe(first.tradeId);
    expect(second.onChainId).toBe(first.onChainId);
  });

  /**
   * The load-bearing test of the whole phase.
   *
   * Money escrowed is not money paid. If the hint were delivered here, a buyer
   * could take it, never release, wait for expiry, refund, and keep it — the
   * market would be free.
   */
  it('issues a fresh trade when the price changes', async () => {
    market.list(seller, hintId, 20);
    const listing = market.browse(hunt.zoneId)[0]!;
    const atAsk = await market.buy(buyer, listing.id);

    const offer = market.bid(buyer, listing.id, 12);
    const accepted = await market.acceptBid(seller, offer.id);

    // Reusing the 20c trade id would quote one number while the escrow expects
    // another, and the buyer would fund a purchase they did not agree to.
    expect(accepted.tradeId).not.toBe(atAsk.tradeId);
    expect(accepted.priceCents).toBe(12);
  });

  it('does NOT deliver the hint when the money is merely escrowed', async () => {
    const quote = await sell();
    fundOnChain(quote);

    const trade = await market.sync(buyer, quote.tradeId);
    expect(trade.status).toBe('funded');
    expect(trade.delivered).toBeUndefined();
    expect(hintRepo.holds(buyer.id, hintId)).toBe(false);
    // What the buyer gets instead is the authority to make the payment final.
    expect(trade.release?.signature).toMatch(/^0x/);
  });

  it('delivers only once the chain says the trade settled', async () => {
    const quote = await sell();
    fundOnChain(quote);
    await market.sync(buyer, quote.tradeId);
    settleOnChain(quote);

    const trade = await market.sync(buyer, quote.tradeId);
    expect(trade.status).toBe('delivered');
    expect(hintRepo.holds(buyer.id, hintId)).toBe(true);

    // And what arrives is verifiably the hint that was vouched for.
    expect(trade.delivered!.hintHash).toBe(quote.vouch.hintHash);
    expect(trade.delivered!.hint.payload).toEqual(hintRepo.get(hintId)!.payload);
  });

  it('leaves the seller holding the hint too', async () => {
    const quote = await sell();
    fundOnChain(quote);
    settleOnChain(quote);
    await market.sync(buyer, quote.tradeId);

    // Information copies rather than moves. This is the whole shape of the
    // market — and the reason a listing is never marked sold.
    expect(hintRepo.holds(seller.id, hintId)).toBe(true);
    expect(market.browse(hunt.zoneId)).toHaveLength(1);
  });

  it('never gives the seller the payload back on the trade', async () => {
    const quote = await sell();
    fundOnChain(quote);
    settleOnChain(quote);

    const asSeller = await market.sync(seller, quote.tradeId);
    expect(asSeller.status).toBe('delivered');
    expect(asSeller.delivered).toBeUndefined();
  });

  it('delivers exactly once however often it is polled', async () => {
    const quote = await sell(100);
    fundOnChain(quote);
    settleOnChain(quote);

    await Promise.all([
      market.sync(buyer, quote.tradeId),
      market.sync(seller, quote.tradeId),
      market.sync(buyer, quote.tradeId),
    ]);
    await market.sync(buyer, quote.tradeId);

    const rake = marketRepo.rakeFor(hunt.zoneId)!;
    // One trade, charged once. Two pollers arriving together must not each book
    // the rake, and the buyer must not be granted twice.
    expect(rake.trades).toBe(1);
    expect(rake.tradedCents).toBe(100);
  });
});

// ── things that must not settle ──────────────────────────────────────────────

describe('a trade the chain does not agree with', () => {
  it('refuses to release money escrowed for a different hint', async () => {
    const quote = await sell();
    fundOnChain(quote, { hintHash: `0x${'ff'.repeat(32)}` as Hex });

    const trade = await market.sync(buyer, quote.tradeId);
    // The attack this stops: fund a trade id against a vouch for some sharper
    // hint and have the referee release it.
    expect(trade.mismatch).toBe('hint');
    expect(trade.release).toBeUndefined();
    expect(trade.status).toBe('quoted');
  });

  it('refuses to release the wrong amount', async () => {
    const quote = await sell();
    fundOnChain(quote, { amount: 1n });

    const trade = await market.sync(buyer, quote.tradeId);
    expect(trade.mismatch).toBe('amount');
    expect(trade.release).toBeUndefined();
  });

  it('refuses to release to a seller nobody agreed to', async () => {
    const quote = await sell();
    fundOnChain(quote, { seller: THIRD as Hex });

    const trade = await market.sync(buyer, quote.tradeId);
    expect(trade.mismatch).toBe('seller');
    expect(trade.release).toBeUndefined();
  });

  it('will not release a trade past its expiry', async () => {
    const quote = await sell();
    fundOnChain(quote);

    // The contract would refuse this anyway; signing it would only invite a
    // transaction that reverts while the refund is already due.
    const trade = await market.sync(buyer, quote.tradeId, quote.expiresAt + 1);
    expect(trade.release).toBeUndefined();
  });

  it('abandons a quote that was never funded', async () => {
    const quote = await sell();
    const trade = await market.sync(buyer, quote.tradeId, quote.expiresAt + 1);
    expect(trade.status).toBe('abandoned');
    expect(hintRepo.holds(buyer.id, hintId)).toBe(false);
  });

  it('still honours money that lands after the quote was given up on', async () => {
    const quote = await sell();
    const late = quote.expiresAt + 1;

    // The server abandons the quote at its deadline; the buyer's wallet does
    // not. A transaction sent just before it can land just after, and that money
    // is still theirs to have delivered against.
    expect((await market.sync(buyer, quote.tradeId, late)).status).toBe('abandoned');

    fundOnChain(quote, { expiresAt: Math.floor(late / 1000) + 600 });
    settleOnChain(quote);

    const trade = await market.sync(buyer, quote.tradeId, late);
    expect(trade.status).toBe('delivered');
    expect(hintRepo.holds(buyer.id, hintId)).toBe(true);
  });

  it('records a refund without delivering', async () => {
    const quote = await sell();
    fundOnChain(quote, { status: OnChainStatus.Refunded });

    const trade = await market.sync(buyer, quote.tradeId);
    expect(trade.status).toBe('refunded');
    expect(hintRepo.holds(buyer.id, hintId)).toBe(false);
  });

  it('is not visible to a stranger', async () => {
    const quote = await sell();
    const rival = makePlayer(THIRD, '@rival');
    await expect(market.sync(rival, quote.tradeId)).rejects.toThrow(/not_your_trade/);
  });
});

// ── the rake ─────────────────────────────────────────────────────────────────

describe('the rake ledger', () => {
  async function tradeAt(cents: number, hint: string, buyerPlayer: Player): Promise<void> {
    market.list(seller, hint, cents);
    const listing = market.browse(hunt.zoneId).find(l => l.hintId === hint)!;
    const quote = await market.buy(buyerPlayer, listing.id);
    fundOnChain(quote);
    settleOnChain(quote);
    await market.sync(buyerPlayer, quote.tradeId);
  }

  it('collects nothing on a dust market, and says so', async () => {
    await tradeAt(1, hintId, buyer);

    const [zone] = market.rakeStats().filter(z => z.zoneId === hunt.zoneId);
    // Under the waiver the seller keeps everything. A realised rate of zero is
    // the honest report of a market that is all dust, not a bug.
    expect(zone!.collectedCents).toBe(0);
    expect(zone!.realisedBps).toBe(0);
    expect(zone!.waivedMills).toBeGreaterThan(0);
  });

  it('converges on the advertised rate once trades are worth taxing', async () => {
    const set = hints.forHunt(hunt);
    const buyers = [buyer, makePlayer(THIRD, '@rival')];

    for (const [i, hintRecord] of set.slice(0, 4).entries()) {
      hintRepo.grant(seller.id, hintRecord.id, 'reveal');
      await tradeAt(200, hintRecord.id, buyers[i % buyers.length]!);
    }

    const [zone] = market.rakeStats().filter(z => z.zoneId === hunt.zoneId);
    expect(zone!.tradedCents).toBe(800);
    // 2.5% of 800c is 20c, exactly — and the carried fraction is zero here.
    expect(zone!.collectedCents).toBe(20);
    expect(zone!.realisedBps).toBe(250);
  });

  it('carries fractions rather than discarding them', async () => {
    const set = hints.forHunt(hunt);
    const buyers = [buyer, makePlayer(THIRD, '@rival')];

    // 7c at 2.5% is 175 mills — under a cent each time, so nothing settles until
    // six of them have accumulated. Discarding the remainder would tax every one
    // of these at 100%.
    for (const [i, hintRecord] of set.slice(0, 6).entries()) {
      hintRepo.grant(seller.id, hintRecord.id, 'reveal');
      await tradeAt(7, hintRecord.id, buyers[i % buyers.length]!);
    }

    const [zone] = market.rakeStats().filter(z => z.zoneId === hunt.zoneId);
    const totalMills = zone!.collectedCents * 1_000 + zone!.accruedMills;
    expect(totalMills).toBe(6 * 175);
    expect(zone!.collectedCents).toBe(1);
  });
});
