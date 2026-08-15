import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vaultChain from '../chain/agentVault';
import * as attestor from '../chain/attestor';
import * as escrowRead from '../chain/hintEscrow';
import { OnChainStatus } from '../chain/hintEscrow';
import * as agentRepo from '../db/repos/agents';
import * as hintRepo from '../db/repos/hints';
import { env } from '../env';
import * as hints from '../hints';
import * as market from '../market';
import * as store from '../store';
import { freshWorld, huntOfType, makePlayer, teardownWorld } from '../testing/harness';
import type { Hunt, Player } from '../types';
import * as driver from './driver';
import * as identity from './identity';
import * as inference from './inference';
import * as mailbox from './mailbox';
import * as negotiate from './negotiate';
import { render } from './protocol';
import * as runtime from './runtime';

/**
 * Two agents haggling, through the real driver.
 *
 * `mailbox.test` proves the transport is safe and `negotiate.test` proves the
 * policy terminates, and both of those would pass on a system where no agent
 * ever spoke to another one. This file is the wire: a listing one agent cannot
 * afford at the asking price, and a conversation that ends in a trade at a price
 * neither side named first.
 *
 * It is written after having shipped two phases whose libraries had no callers.
 */

const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b0';
const MASTER = 'test-master-secret-that-is-long-enough-32';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ESCROW_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

const mut = env as Record<string, unknown>;
const original = { ...mut };

let seller: Player;
let buyer: Player;
let hunt: Hunt;
let hintId: string;
let sellerAgent: string;
let buyerAgent: string;

/** Each player's vault, as far as the driver is concerned. */
function vaultsOnChain(): void {
  vaultChain.setTransportForTests(
    async (owner: string) => ({
      address: `0x${'f'.repeat(40)}` as `0x${string}`,
      remainingToday: 10n ** 21n,
      perTxCap: 10n ** 20n,
      spender: (owner.toLowerCase() === SELLER ? sellerAgent : buyerAgent) as `0x${string}`,
    }),
    async () => '0xhash',
  );
}

beforeEach(() => {
  freshWorld();
  runtime.reset();
  mailbox.reset();
  negotiate.reset();

  Object.assign(mut, {
    AGENTS_ENABLED: true,
    AGENT_MASTER_KEY: MASTER,
    AGENT_VAULT_FACTORY_ADDRESS: '0x00000000000000000000000000000000000000fa',
    AGENT_TOKEN_ADDRESS: '0x00000000000000000000000000000000000000d0',
    PLAYER_REGISTRY_ADDRESS: '0x00000000000000000000000000000000000000e1',
    ATTESTOR_PRIVATE_KEY: KEY,
    LOOTGRID_ACTIONS_ADDRESS: '0x00000000000000000000000000000000000000ac',
    ESCROW_PRIVATE_KEY: ESCROW_KEY,
    LOOTGRID_ESCROW_ADDRESS: '0x00000000000000000000000000000000000000e5',
    HINT_ESCROW_ADDRESS: '0x00000000000000000000000000000000000000e7',
    HINT_TOKEN_ADDRESS: '0x00000000000000000000000000000000000000d0',
    HINT_MARKET_ENABLED: true,
    DEEPSEEK_API_KEY: 'test-key',
    RPC_URL: 'http://localhost:0',
    CHAIN: 'celoSepolia',
  });
  attestor.reset();

  escrowRead.setReaderForTests(async () => ({
    buyer: '0x0000000000000000000000000000000000000000',
    seller: '0x0000000000000000000000000000000000000000',
    amount: 0n,
    expiresAt: 0,
    status: OnChainStatus.None,
    hintHash: `0x${'00'.repeat(32)}`,
  }));

  // Pin the block's game before anybody exists: `huntOfType` reseeds the world
  // until it finds one, which would wipe players created first.
  //
  // Pinned rather than taken at random because the buyer agent also *plays* the
  // hunt it negotiates on, and a block whose game the agent happens to finish
  // resolves the hunt out from under the trade — correct behaviour, since there
  // is nothing to sell a hint about any more, but it made this file fail on
  // roughly one seed in six. Deduction is the agent game the fixed stub probe
  // cannot solve: repeating one probe yields no new information, so the attempt
  // runs out of budget instead of winning.
  hunt = huntOfType('deduction');

  // Leave exactly one hunt live in the agent zone.
  //
  // `enterSomething` takes the first hunt it finds and `considerHints` only
  // looks at listings for *that* hunt, so with several live the agent kept
  // entering a different one and never saw the listing under test — which is
  // what the diagnostics showed when this file was intermittently finding no
  // trade. One hunt makes the fixture deterministic instead of a race with the
  // zone's hunt ordering.
  for (const other of store.liveHuntsIn(store.getZone(hunt.zoneId)!)) {
    if (other.id !== hunt.id) store.setHuntStatus(store.getHunt(other.id)!, 'expired');
  }

  seller = makePlayer(SELLER, '@seller');
  buyer = makePlayer(BUYER, '@buyer');

  for (const [player, holder] of [
    [seller, 'seller'],
    [buyer, 'buyer'],
  ] as const) {
    const id = identity.addressFor(player.id);
    agentRepo.create(id, player.id);
    agentRepo.setVault(id, `0x${'f'.repeat(40)}`);
    if (holder === 'seller') sellerAgent = id;
    else buyerAgent = id;
  }

  // Deduction only ever runs on an agent zone, which is also the only place
  // `considerHints` looks — a listing on a human-zone hunt is one no agent will
  // ever see, which is how the first run of this file failed.
  expect(store.getZone(hunt.zoneId)!.kind).toBe('agent');
  hintId = hints.forHunt(hunt)[0]!.id;
  hintRepo.grant(seller.id, hintId, 'reveal');

  vaultsOnChain();
  inference.setProviderForTests(async () => ({
    ok: true,
    text: '{"kind":"probe","value":{"kind":"parity","parity":"even"}}',
  }));
});

afterEach(() => {
  Object.assign(mut, original);
  inference.setProviderForTests(null);
  vaultChain.setTransportForTests(null, null);
  escrowRead.setReaderForTests(null);
  attestor.reset();
  runtime.reset();
  mailbox.reset();
  negotiate.reset();
  teardownWorld();
});

/**
 * Set up a listing and two agents around whatever hint this world drew.
 *
 * The numbers are derived, not hardcoded. `freshWorld` randomises hunts and
 * hints, so the market's valuation of the hint differs every run — a fixture
 * with literal prices in it passes or fails on the seed, which is how the first
 * version of these tests came to pass for the wrong reason.
 *
 * `overlap` decides whether a deal is available at all: with it, the seller's
 * floor sits below the buyer's ceiling; without it, above.
 */
async function configure(overlap: boolean): Promise<{ askCents: number; ceilingCents: number; floorCents: number }> {
  // List once to read the market's own valuation, then relist at a price chosen
  // against it.
  const provisional = await market.list(seller, hintId, market.MAX_ASK_CENTS);
  const valuation = Math.max(2, provisional.suggestedCents);
  market.cancel(seller, provisional.id);

  // Above the buyer's limit either way, so the agent refuses at the ask and has
  // to negotiate — that refusal is what opens the thread.
  const ceilingCents = valuation;
  const askCents = Math.min(
    market.MAX_ASK_CENTS,
    overlap
      ? Math.max(ceilingCents + 2, Math.floor(valuation * 1.6))
      : Math.max(ceilingCents + 2, valuation * 6),
  );

  agentRepo.putConfig(buyerAgent, {
    ...agentRepo.getConfig(buyerAgent),
    zones: [hunt.zoneId],
    maxHintPriceCents: ceilingCents + 1,
    minReliabilityBps: 0,
    aggression: 50,
  });
  agentRepo.putConfig(sellerAgent, {
    ...agentRepo.getConfig(sellerAgent),
    zones: [hunt.zoneId],
    // Least stubborn: floor at half the ask, so `overlap` genuinely controls
    // whether a deal exists rather than the seller's temperament doing it.
    aggression: 0,
    minReliabilityBps: 0,
  });

  await market.list(seller, hintId, askCents);
  return {
    askCents,
    ceilingCents,
    floorCents: negotiate.sellerFloor(agentRepo.getConfig(sellerAgent), askCents, market.MIN_TRADE_CENTS),
  };
}

/**
 * Ticks to let a negotiation run to completion.
 *
 * A thread may use all `MAX_ROUNDS` exchanges and each tick advances it by one
 * per agent, then settlement costs another one or two. Sized from that rather
 * than from a run that happened to pass: `freshWorld` reseeds every test, so a
 * loop tuned to one seed is a test that fails on a Tuesday.
 */
const TICKS = negotiate.MAX_ROUNDS + 6;

describe('two agents reach a price', () => {
  it('opens a negotiation instead of walking past a listing it cannot afford', async () => {
    // Before this existed the agent skipped every listing above its limit
    // without ever finding out whether the price had to be that high.
    await configure(true);

    await driver.tick();

    // Somebody is now holding a message about it.
    const threads = negotiate.agreedFor(buyerAgent).length + mailbox.pending(sellerAgent);
    expect(threads).toBeGreaterThan(0);
  });

  it('converges on a price neither side opened with, and trades at it', async () => {
    // The listing asks 16c and the buyer's limit is 10c, so before this the
    // agent walked past it. The market values the hint at 9c and the seller's
    // floor is 8c, so a deal exists in [8, 9] — and has to actually be found.
    const { askCents, ceilingCents, floorCents } = await configure(true);
    expect(floorCents, 'fixture has no overlap to find').toBeLessThanOrEqual(ceilingCents);

    for (let i = 0; i < TICKS; i++) await driver.tick();

    // Not a conditional assertion: a trade must exist, at a price inside the
    // overlap and strictly below the ask the buyer refused.
    const trades = market.myTrades(buyer);
    expect(trades, 'no trade was ever struck').toHaveLength(1);
    expect(trades[0]!.priceCents).toBeLessThan(askCents);
    expect(trades[0]!.priceCents).toBeGreaterThanOrEqual(floorCents);
    expect(trades[0]!.priceCents).toBeLessThanOrEqual(ceilingCents);

    // And nobody is still waiting on a reply.
    expect(mailbox.pending(buyerAgent) + mailbox.pending(sellerAgent)).toBe(0);
  });

  it('is bounded by what the market says a hint is worth, not just the owner limit', async () => {
    // The owner allows 10c; the market's own valuation of this hint is lower,
    // and that is the number that binds. A ceiling computed in the agent layer
    // would be a second opinion about what a hint is worth.
    const { ceilingCents } = await configure(true);
    for (let i = 0; i < TICKS; i++) await driver.tick();

    const trades = market.myTrades(buyer);
    expect(trades).toHaveLength(1);
    // The owner allowed one cent more than this; the market's number is what
    // actually bound.
    expect(trades[0]!.priceCents).toBeLessThanOrEqual(ceilingCents);
  });

  it('walks away when no price satisfies both sides', async () => {
    // Ask 40c: the seller's floor lands above what the market says the hint is
    // worth, so there is nothing to find. Walking is the correct outcome, and a
    // negotiation that produced a trade here would be the buyer overpaying.
    const { ceilingCents, floorCents } = await configure(false);
    expect(floorCents, 'fixture accidentally left an overlap').toBeGreaterThan(ceilingCents);

    for (let i = 0; i < TICKS; i++) await driver.tick();

    expect(market.myTrades(buyer)).toHaveLength(0);
    expect(mailbox.pending(buyerAgent) + mailbox.pending(sellerAgent)).toBe(0);
  });

  it('never agrees above the owner’s configured limit', async () => {
    // The limit is the owner's, and no sequence of messages from a stranger may
    // argue an agent past it.
    const { ceilingCents } = await configure(true);

    for (let i = 0; i < TICKS; i++) await driver.tick();

    for (const agent of [buyerAgent, sellerAgent]) {
      for (const thread of negotiate.agreedFor(agent)) {
        expect(thread.agreedCents).toBeLessThanOrEqual(ceilingCents);
      }
    }
    for (const trade of market.myTrades(buyer)) {
      expect(trade.priceCents).toBeLessThanOrEqual(ceilingCents);
    }
  });

  it('does not open a second thread about the same listing every tick', async () => {
    // Five seconds apart forever would be this agent shouting over its own
    // earlier message, and the mailbox would refuse it — correctly, and
    // uselessly.
    // Deliberately the no-deal fixture: a thread that settles is closed and
    // gone, which would make this pass for the wrong reason. A walked thread
    // stays until it expires, so it is the one that proves a second was never
    // opened on top of it.
    await configure(false);
    const listingId = market.browse(hunt.zoneId)[0]!.id;

    for (let i = 0; i < 5; i++) await driver.tick();

    expect(negotiate.hasThreadFor(buyerAgent, listingId)).toBe(true);
    // One conversation, not five.
    expect(mailbox.pending(sellerAgent)).toBeLessThanOrEqual(1);
    expect(mailbox.pending(buyerAgent)).toBeLessThanOrEqual(1);
  });

  it('leaves a human seller alone', async () => {
    // A person has no inbox. A thread nobody can answer would sit open until it
    // expired while the buyer believed it had a negotiation running.
    agentRepo.setStatus(sellerAgent, 'killed');
    await configure(true);

    await driver.tick();

    expect(mailbox.pending(sellerAgent)).toBe(0);
    expect(negotiate.hasThreadFor(buyerAgent, market.browse(hunt.zoneId)[0]!.id)).toBe(false);
  });
});

describe('what a rival can reach', () => {
  it('puts nothing but rendered protocol text in front of a model', async () => {
    // The security claim, tested rather than asserted. A rival's message is
    // attacker-controlled input arriving at a model that can spend money; the
    // containment is that only `render`'s fixed templates ever reach a prompt.
    const prompts: string[] = [];
    inference.setProviderForTests(async (req: { user: string }) => {
      prompts.push(req.user);
      return { ok: true, text: '{"kind":"probe","value":{"kind":"parity","parity":"even"}}' };
    });

    await configure(true);
    for (let i = 0; i < 4; i++) await driver.tick();

    for (const prompt of prompts) {
      // No raw message object ever reaches it.
      expect(prompt).not.toContain('"intent"');
      expect(prompt).not.toContain('"thread"');
      // And nothing about another tenant's configuration or wallet.
      expect(prompt).not.toContain('dailyBudgetCents');
      expect(prompt).not.toContain('vault');
    }
  });

  it('renders a rival message through the fixed template when one is delivered', () => {
    const text = render({
      v: 1,
      from: SELLER,
      thread: 'th_1',
      intent: 'counter',
      listingId: 'lst_1',
      priceCents: 12,
    });

    expect(text).toContain('12 cents');
    expect(text).not.toContain('{');
  });

  it('survives a rival flooding it', async () => {
    // The tick must keep working while somebody is abusing the mailbox.
    await configure(true);
    for (let i = 0; i < 50; i++) {
      mailbox.send(sellerAgent, buyerAgent, { garbage: true });
    }

    await expect(driver.tick()).resolves.toBeUndefined();
    expect(store.getPlayer(BUYER)).toBeDefined();
  });
});
