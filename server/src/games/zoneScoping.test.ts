import { describe, expect, it } from 'vitest';
import { canHostCashHunt, gameTypeForBlock, moduleFor } from './index';
import type { GameType, ZoneKind } from '../types';

/**
 * Zone-scoped module selection (implementation plan, phase 0).
 *
 * v2 runs human and agent zones side by side. Which modules a zone may draw from
 * is what keeps that safe, because the reflex modules carry the anti-automation
 * checks that make a cash game honest — `tap` rejects any player whose intervals
 * are too regular to be human.
 *
 * The property under test is therefore **structural**: bot detection is
 * unreachable from an agent zone because the modules containing it are never
 * selected there, not because a flag turned it off. A flag can be wrong for a
 * human zone; an empty pool cannot be.
 */

/**
 * What a human zone may draw for money.
 *
 * One entry, and that is the phase 4 change: this was the three reflex modules,
 * so a cash prize went to whoever tapped or calculated fastest. The reflex
 * modules still exist and still assume a human — they guard XP now.
 */
const HUMAN_CASH: GameType[] = ['crack'];

describe('human zones', () => {
  it('draw cash games only from the human cash pool', () => {
    for (let i = 0; i < 200; i++) {
      const type = gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'cash', 'human');
      expect(HUMAN_CASH).toContain(type);
    }
  });

  it('never decide money on a reflex game', () => {
    // The feeling matters more than the fairness here: "I lost because my phone
    // is slow" is a belief no server-side settlement window can argue with.
    for (let i = 0; i < 200; i++) {
      const type = gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'cash', 'human');
      expect(['tap', 'math', 'sequence', 'memory']).not.toContain(type);
    }
  });

  it('never draw memory for cash, which is the easiest to automate', () => {
    for (let i = 0; i < 200; i++) {
      expect(gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'human')).not.toBe('memory');
    }
  });

  it('can host cash hunts', () => {
    expect(canHostCashHunt('human')).toBe(true);
  });

  it('use every module in the pool, so none is dead code', () => {
    const seen = new Set<GameType>();
    for (let i = 0; i < 400; i++) {
      seen.add(gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'human'));
    }
    expect([...seen].sort()).toEqual([...HUMAN_CASH].sort());
  });

  it('keep the reflex modules alive on puzzle hunts', () => {
    // They did not get deleted, they got demoted. Puzzle hunts are the
    // overwhelming majority of the map, so this is where the variety lives.
    const seen = new Set<GameType>();
    for (let i = 0; i < 400; i++) {
      seen.add(gameTypeForBlock(`s${i}`, `h${i}`, 'puzzle', 'human'));
    }
    expect([...seen].sort()).toEqual(['math', 'memory', 'sequence', 'tap']);
  });
});

describe('agent zones', () => {
  const AGENT_ONLY: GameType[] = ['deduction', 'negotiation', 'search'];

  it('host cash hunts now that the phase 6 modules are registered', () => {
    expect(canHostCashHunt('agent')).toBe(true);
  });

  it('never yield a reflex module for a cash hunt', () => {
    // The load-bearing assertion, and the reason the pools are separate at all.
    // If this ever passes a human module, an agent is playing a game whose
    // integrity depends on the player not being one — tap rejects anybody whose
    // intervals are too regular, which is every agent that ever plays it.
    for (let i = 0; i < 200; i++) {
      const type = gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'agent');
      expect(HUMAN_CASH).not.toContain(type);
      expect(AGENT_ONLY).toContain(type);
    }
  });

  it('never yield an agent module on a human zone', () => {
    // The mirror, and it matters just as much: each agent game runs for ten
    // minutes and expects thinking between inputs. Handing one to somebody on a
    // phone waiting for a bus is not a hard hunt, it is a broken one.
    for (let i = 0; i < 200; i++) {
      expect(AGENT_ONLY).not.toContain(gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'human'));
    }
  });

  it('use every module in the agent pool, so none is dead code', () => {
    const seen = new Set<GameType>();
    for (let i = 0; i < 400; i++) seen.add(gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'agent'));
    expect([...seen].sort()).toEqual([...AGENT_ONLY].sort());
  });

  /**
   * This test used to assert the opposite, and was right about the reason while
   * wrong about the conclusion.
   *
   * Puzzle hunts guard XP rather than money, so automation threatens nobody —
   * true, and why a HUMAN zone happily draws reflex games for them. But that is
   * an argument about cheating, not about playability, and on an agent zone the
   * two come apart: the audience is machines, and a machine cannot play a tap
   * race at all.
   *
   * With `CASH_PER_ZONE` cash hunts drawing agent games and the other
   * twenty-three drawing reflex ones, an agent zone offered its entire audience
   * ONE playable hunt. When that hunt was taken the tier stopped dead — the zone
   * was full so it could not restock — and the driver swept 1,087 consecutive
   * idle ticks while looking perfectly healthy.
   */
  it('draw agent games for PUZZLE hunts too, so the whole zone is playable', () => {
    for (let i = 0; i < 200; i++) {
      expect(AGENT_ONLY).toContain(gameTypeForBlock(`s${i}`, `h${i}`, 'puzzle', 'agent'));
    }
  });

  it('leaves human puzzle hunts on the reflex pool', () => {
    for (let i = 0; i < 200; i++) {
      expect(AGENT_ONLY).not.toContain(gameTypeForBlock(`s${i}`, `h${i}`, 'puzzle', 'human'));
    }
  });

  it('does not mirror the cash draw, so a zone is not all one game', () => {
    // Same salt and id, different kind: a shared tag would make every puzzle
    // hunt play whatever its cash counterpart drew.
    const differs = Array.from({ length: 60 }, (_, i) =>
      gameTypeForBlock(`s${i}`, `h${i}`, 'puzzle', 'agent') !==
      gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'agent'),
    ).filter(Boolean).length;
    expect(differs).toBeGreaterThan(0);
  });

  it('spreads puzzle hunts across every agent module', () => {
    const seen = new Set<GameType>();
    for (let i = 0; i < 400; i++) seen.add(gameTypeForBlock(`s${i}`, `h${i}`, 'puzzle', 'agent'));
    expect([...seen].sort()).toEqual([...AGENT_ONLY].sort());
  });
});

describe('the default is the strict branch', () => {
  // A forgotten argument must fail towards anti-automation being ON. Getting
  // this backwards would admit agents to human cash games silently.
  it('treats an omitted zone kind as human', () => {
    for (let i = 0; i < 50; i++) {
      expect(gameTypeForBlock(`s${i}`, `h${i}`, 'cash')).toBe(
        gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'human'),
      );
    }
  });

  it('lets both kinds host cash hunts, from their own pools', () => {
    const kinds: ZoneKind[] = ['human', 'agent'];
    expect(kinds.filter(canHostCashHunt)).toEqual(['human', 'agent']);
    // Same question, different answer per kind — which is the whole point of
    // scoping rather than sharing one pool.
    expect(gameTypeForBlock('s', 'h', 'cash', 'human')).not.toBe(
      gameTypeForBlock('s', 'h', 'cash', 'agent'),
    );
  });
});

describe('determinism is unchanged by zone scoping', () => {
  it('is stable for the same salt, hunt and zone kind', () => {
    expect(gameTypeForBlock('s', 'h', 'cash', 'human')).toBe(
      gameTypeForBlock('s', 'h', 'cash', 'human'),
    );
  });

  it('resolves every drawn type to a registered module', () => {
    for (let i = 0; i < 100; i++) {
      const type = gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'human');
      expect(moduleFor(type).type).toBe(type);
    }
  });
});
