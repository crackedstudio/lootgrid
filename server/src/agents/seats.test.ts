import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as inference from './inference';
import * as runtime from './runtime';
import * as seats from './seats';

/**
 * Funded seats.
 *
 * The property this file exists to defend is not an accounting one:
 *
 *   **A seat buys compute. It never buys entry.**
 *
 * AGENT_TIER.md §2 and payments/x402.ts both say why — charging for something a
 * player needs in order to compete for a cash prize is an entry fee with extra
 * steps, and that is the gambling definition in many jurisdictions. So the
 * important tests below are the ones asserting what a MISSING seat still
 * permits, not what a bought one unlocks.
 */

const mut = env as {
  AGENTS_ENABLED: boolean;
  DEEPSEEK_API_KEY?: string;
  AGENT_SEAT_CAP: number;
};
const original = { ...mut };

const AGENT = '0x00000000000000000000000000000000000000a1';
const PLAYER = '0x00000000000000000000000000000000000000b0';

beforeEach(() => {
  freshWorld();
  runtime.reset();
  mut.AGENTS_ENABLED = true;
  mut.DEEPSEEK_API_KEY = 'test-key-not-a-real-one';
  agentRepo.create(AGENT, PLAYER);
});

afterEach(() => {
  Object.assign(mut, original);
  inference.setProviderForTests(null);
  runtime.reset();
  teardownWorld();
});

describe('a seat buys compute, never entry', () => {
  /**
   * The one that matters. If this ever fails, the product has changed legal
   * category and no amount of wording on the purchase screen fixes it.
   */
  it('no entry path anywhere consults a seat', () => {
    // Read as source rather than exercised as behaviour, because the risk is
    // someone ADDING a check later. A behavioural test passes right up until
    // the day the check appears; this fails the moment it does.
    //
    // `openAttempt` is the single door into a hunt — referee.ts owns it and
    // driver.ts is the only agent-side caller. If either learns the word
    // "seat", a seat has started buying entry.
    const root = dirname(fileURLToPath(import.meta.url));
    for (const file of ['driver.ts', '../referee.ts', '../admission.ts']) {
      const src = readFileSync(join(root, file), 'utf8');
      // Comments legitimately discuss seats; code must not branch on one.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, `${file} must not gate on a seat`).not.toMatch(/seats?\./i);
    }
  });

  it('never gates a turn — an unseated agent moves anyway', async () => {
    inference.setProviderForTests(async () => ({
      ok: true,
      text: JSON.stringify({ kind: 'probe', value: { r: 1, c: 2 } }),
    }));

    const out = await runtime.schedule({
      agentId: AGENT,
      playerId: PLAYER,
      huntId: 'h1',
      difficulty: 'med',
      gameType: 'search',
      config: agentRepo.getConfig(AGENT),
      spec: { rows: 60, cols: 60 },
      state: {},
      inbox: [],
    } as never);

    // A legal move, produced without a seat and without billing anyone.
    expect(out.move).toBeTruthy();
    expect(out.source).toBe('fallback');
    expect(out.refused).toBe('no_seat');
    expect(out.billedMills).toBe(0);
  });

  it('spends the provider only once a seat is funded', async () => {
    const provider = vi.fn(async () => ({
      ok: true as const,
      text: JSON.stringify({ kind: 'probe', value: { r: 1, c: 2 } }),
    }));
    inference.setProviderForTests(provider);

    const ctx = {
      agentId: AGENT, playerId: PLAYER, huntId: 'h1', difficulty: 'med',
      gameType: 'search', config: agentRepo.getConfig(AGENT),
      spec: { rows: 60, cols: 60 }, state: {}, inbox: [],
    } as never;

    await runtime.schedule(ctx);
    expect(provider).not.toHaveBeenCalled(); // unseated: nobody was billed

    seats.grant(AGENT, PLAYER, { mills: 100_000 });
    const out = await runtime.schedule(ctx);

    expect(provider).toHaveBeenCalled();
    expect(out.source).toBe('model');
    expect(seats.creditOf(AGENT)).toBeLessThan(100_000);
  });
});

describe('credit', () => {
  it('starts empty and is granted whole', () => {
    expect(seats.creditOf(AGENT)).toBe(0);
    seats.grant(AGENT, PLAYER, { mills: 5_000, paidCents: 100 });
    expect(seats.creditOf(AGENT)).toBe(5_000);
  });

  it('tops up rather than resetting, so a second purchase is not a loss', () => {
    seats.grant(AGENT, PLAYER, { mills: 5_000, paidCents: 100 });
    seats.consume(AGENT, 1_000);
    seats.grant(AGENT, PLAYER, { mills: 5_000, paidCents: 100 });

    expect(seats.creditOf(AGENT)).toBe(9_000);
    expect(seats.get(AGENT)!.paidCents).toBe(200);
  });

  it('refuses to overdraw', () => {
    seats.grant(AGENT, PLAYER, { mills: 100 });
    expect(seats.consume(AGENT, 150)).toBe(false);
    expect(seats.creditOf(AGENT)).toBe(100);
    expect(seats.consume(AGENT, 100)).toBe(true);
    expect(seats.creditOf(AGENT)).toBe(0);
  });

  it('will not credit the same settlement twice', () => {
    seats.grant(AGENT, PLAYER, { mills: 5_000, txRef: 'settlement-1' });
    const other = '0x00000000000000000000000000000000000000c2';
    agentRepo.create(other, '0x00000000000000000000000000000000000000d3');
    // tx_ref is UNIQUE: the envelope comes back from the client, so it is
    // attacker-controlled by the time it is settled.
    expect(() =>
      seats.grant(other, '0x00000000000000000000000000000000000000d3', {
        mills: 5_000,
        txRef: 'settlement-1',
      }),
    ).toThrow();
  });
});

describe('the cap is a budget, not a queue', () => {
  it('counts seats with credit left, not seats ever sold', () => {
    seats.grant(AGENT, PLAYER, { mills: 100 });
    expect(seats.occupied()).toBe(1);

    seats.consume(AGENT, 100);
    // Spent out, so it no longer occupies budget the house has to honour.
    expect(seats.occupied()).toBe(0);
  });

  it('reports how many are left', () => {
    mut.AGENT_SEAT_CAP = 2;
    expect(seats.seatsLeft()).toBeGreaterThanOrEqual(0);
  });
});

describe('the offer states what it is', () => {
  it('says plainly that it does not buy entry, and names the free path', () => {
    const offer = seats.offer(AGENT);
    expect(offer.doesNotBuy).toContain('entry');
    expect(offer.freeAlternative).toBeTruthy();
    expect(offer.buys).toContain('inference');
  });
});
