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

/** The reflex modules. Every one of these guards money and assumes a human. */
const HUMAN_ONLY: GameType[] = ['tap', 'math', 'sequence'];

describe('human zones', () => {
  it('draw cash games only from the reflex pool', () => {
    for (let i = 0; i < 200; i++) {
      const type = gameTypeForBlock(`salt-${i}`, `hunt-${i}`, 'cash', 'human');
      expect(HUMAN_ONLY).toContain(type);
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
    expect([...seen].sort()).toEqual([...HUMAN_ONLY].sort());
  });
});

describe('agent zones', () => {
  // Until phase 6 registers deduction/negotiation/search there is no legal
  // module, and refusing loudly beats silently falling back to a reflex game.
  it('cannot host a cash hunt yet', () => {
    expect(canHostCashHunt('agent')).toBe(false);
  });

  it('throw rather than fall back to a human module', () => {
    expect(() => gameTypeForBlock('salt', 'hunt-1', 'cash', 'agent')).toThrow(/agent zones/);
  });

  it('never yield a reflex module for a cash hunt', () => {
    // The load-bearing assertion. If this ever passes a value, an agent is
    // playing a game whose integrity depends on it not being one.
    for (let i = 0; i < 100; i++) {
      let type: GameType | null = null;
      try {
        type = gameTypeForBlock(`s${i}`, `h${i}`, 'cash', 'agent');
      } catch {
        // expected while the agent pool is empty
      }
      if (type !== null) expect(HUMAN_ONLY).not.toContain(type);
    }
  });

  it('still share the puzzle module, which guards XP and never money', () => {
    expect(gameTypeForBlock('s', 'h', 'puzzle', 'agent')).toBe('memory');
    expect(gameTypeForBlock('s', 'h', 'puzzle', 'human')).toBe('memory');
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

  it('keeps human zones hosting cash hunts under every kind value', () => {
    const kinds: ZoneKind[] = ['human', 'agent'];
    expect(kinds.filter(canHostCashHunt)).toEqual(['human']);
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
