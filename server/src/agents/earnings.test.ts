import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agentRepo from '../db/repos/agents';
import { MILLS_PER_CENT } from '../market/fees';
import { prizeCentsFor } from '../prizes';
import * as store from '../store';
import { freshWorld, makeAgedPlayer, teardownWorld } from '../testing/harness';
import type { Attempt, Hunt } from '../types';
import * as budget from './budget';
import { defaultConfig } from './config';
import { onHuntResolved, positionOf } from './earnings';

/**
 * The other half of the ledger.
 *
 * `agentRepo` could answer "what did this agent cost" four ways and could not
 * answer "did it win anything" at all, so `viableFor`'s EV model — prize over
 * entrants, minus thinking — had never once been checked against an outcome.
 *
 * Two groups of tests. The first says wins are recorded, and only the right
 * ones. The second is the one that matters: a win must never widen a ceiling.
 * Putting prizes in `agent_spend` as a credit would have netted them off the
 * SUM that `budget.ts` enforces limits with, so winning would have bought more
 * budget to spend — a spending exploit that reads like an accounting nicety.
 */

const PLAYER = '0x00000000000000000000000000000000000000b1';
const AGENT = '0x00000000000000000000000000000000000000b2';

const agentZone = () => store.listZones().find(z => z.kind === 'agent')!;
const humanZone = () => store.listZones().find(z => z.kind !== 'agent')!;

function huntIn(zoneId: string, over: Partial<Hunt> = {}): Hunt {
  const zone = store.getZone(zoneId)!;
  const base = store.liveHuntsIn(zone)[0];
  if (!base) throw new Error(`no live hunt in ${zoneId}`);
  return { ...store.getHunt(base.id)!, ...over };
}

const winnerOf = (playerId: string): Attempt =>
  ({ playerId, elapsedMs: 1200 }) as Attempt;

beforeEach(() => {
  freshWorld();
  makeAgedPlayer(PLAYER, '@owner');
  agentRepo.create(AGENT, PLAYER);
});
afterEach(() => teardownWorld());

describe('a win is recorded, and only the right ones', () => {
  it('records a cash win in an agent zone', () => {
    const hunt = huntIn(agentZone().id, { kind: 'cash', difficulty: 'med' });
    onHuntResolved(hunt, winnerOf(PLAYER), 3);

    const rows = agentRepo.recentEarnings(AGENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      huntId: hunt.id,
      amountMills: prizeCentsFor('med') * MILLS_PER_CENT,
      racers: 3,
      difficulty: 'med',
      // Awarded, not collected: the server pays nobody, and a prize nobody
      // bothers to claim is an ordinary case at these amounts.
      claimedAt: null,
    });
  });

  it('ignores a human zone', () => {
    // An agent plays AS its owner, so player id alone cannot tell an agent's win
    // from the same human winning by hand. Zone kind is the exact discriminator.
    const hunt = huntIn(humanZone().id, { kind: 'cash', difficulty: 'med' });
    onHuntResolved(hunt, winnerOf(PLAYER), 2);
    expect(agentRepo.recentEarnings(AGENT)).toHaveLength(0);
  });

  it('ignores a puzzle hunt, which pays XP rather than money', () => {
    const hunt = huntIn(agentZone().id, { kind: 'puzzle', difficulty: 'med' });
    onHuntResolved(hunt, winnerOf(PLAYER), 2);
    expect(agentRepo.recentEarnings(AGENT)).toHaveLength(0);
  });

  it('ignores a player with no agent', () => {
    const stranger = '0x00000000000000000000000000000000000000c9';
    makeAgedPlayer(stranger, '@stranger');
    const hunt = huntIn(agentZone().id, { kind: 'cash', difficulty: 'med' });
    onHuntResolved(hunt, winnerOf(stranger), 2);
    expect(agentRepo.recentEarnings(AGENT)).toHaveLength(0);
  });

  it('records one prize per hunt however often the resolve fires', () => {
    const hunt = huntIn(agentZone().id, { kind: 'cash', difficulty: 'hard' });
    onHuntResolved(hunt, winnerOf(PLAYER), 2);
    onHuntResolved(hunt, winnerOf(PLAYER), 2);
    onHuntResolved(hunt, winnerOf(PLAYER), 9);
    expect(agentRepo.recentEarnings(AGENT)).toHaveLength(1);
  });

  it('never throws on the resolve path', () => {
    // It runs inline on the race's critical path. A bookkeeping failure must not
    // cost somebody the hunt they just won.
    const broken = { ...huntIn(agentZone().id), zoneId: 'no-such-zone' };
    expect(() => onHuntResolved(broken, winnerOf(PLAYER), 2)).not.toThrow();
    expect(() => onHuntResolved(huntIn(agentZone().id), null as never, 2)).not.toThrow();
  });
});

describe('a win never widens a spending ceiling', () => {
  const config = { ...defaultConfig(), zones: [] as string[], dailyBudgetCents: 30 };

  it('leaves the owner’s remaining budget untouched', () => {
    // THE test. If prizes had gone into `agent_spend` as a credit, this number
    // would rise with every win and a winning agent would have no ceiling.
    budget.record(AGENT, 'hint', 10 * MILLS_PER_CENT, { huntId: 'h0' });
    const before = budget.remainingToday(AGENT, config);

    const hunt = huntIn(agentZone().id, { kind: 'cash', difficulty: 'hard' });
    onHuntResolved(hunt, winnerOf(PLAYER), 2);

    expect(budget.remainingToday(AGENT, config)).toBe(before);
  });

  it('leaves the house’s remaining inference untouched', () => {
    budget.record(AGENT, 'inference', 500, { huntId: 'h0' });
    const before = budget.houseRemainingToday(AGENT);

    onHuntResolved(huntIn(agentZone().id, { kind: 'cash', difficulty: 'hard' }), winnerOf(PLAYER), 2);

    expect(budget.houseRemainingToday(AGENT)).toBe(before);
  });

  it('does not let a win buy a hint the owner’s budget forbids', () => {
    const hint = { priceCents: 25, reliabilityBps: 10_000, zoneId: 'ridge' };
    const tight = { ...defaultConfig(), zones: ['ridge'], dailyBudgetCents: 30 };
    budget.record(AGENT, 'hint', 20 * MILLS_PER_CENT, { huntId: 'h0' });
    expect(budget.canBuyHint(AGENT, tight, hint).ok).toBe(false);

    // Win a prize many times the size of the budget…
    for (const d of ['hard', 'hard', 'hard'] as const) {
      onHuntResolved(huntIn(agentZone().id, { kind: 'cash', difficulty: d, id: `h-${d}-${Math.random()}` }), winnerOf(PLAYER), 1);
    }

    // …and it still cannot afford the hint.
    expect(budget.canBuyHint(AGENT, tight, hint).ok).toBe(false);
  });
});

describe('net position', () => {
  it('is earnings minus every cost', () => {
    budget.record(AGENT, 'hint', 4_000, { huntId: 'h1' });
    budget.record(AGENT, 'inference', 350, { huntId: 'h1' });
    const hunt = huntIn(agentZone().id, { kind: 'cash', difficulty: 'med' });
    onHuntResolved(hunt, winnerOf(PLAYER), 2);

    const prize = prizeCentsFor('med') * MILLS_PER_CENT;
    const p = positionOf(AGENT);
    expect(p.earnedMills).toBe(prize);
    expect(p.spentMills).toBe(4_350);
    expect(p.netMills).toBe(prize - 4_350);
    expect(p.wins).toBe(1);
  });

  it('reports a losing agent honestly', () => {
    // An agent that loses more than it wins is the normal case, not a bug. A
    // position that could not go negative would be a scoreboard, not a ledger.
    budget.record(AGENT, 'hint', 50_000, { huntId: 'h1' });
    const p = positionOf(AGENT);
    expect(p.netMills).toBeLessThan(0);
    expect(p.wins).toBe(0);
  });

  it('forgets yesterday', () => {
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    budget.record(AGENT, 'hint', 9_000, { huntId: 'h0' }, yesterday);
    expect(positionOf(AGENT).spentMills).toBe(0);
  });
});
