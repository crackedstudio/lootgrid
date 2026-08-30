import { describe, expect, it } from 'vitest';
import { PUZZLE_HUNT_XP, RANK, TILES, TUTORIAL } from './config';
import { standingOf, XP_STANDING } from './rank';

/**
 * XP standing.
 *
 * XP has no sink and never will — `players.addXp` is the only statement that
 * touches the column. That was read as an unfinished currency; it is a decision,
 * and standing is what makes the number legible without making it spendable.
 *
 * The load-bearing test here is the last one. Standing gates nothing, and must
 * never be confused with the Prospector rank a cash hunt checks: rank is
 * deliberately not earned by winning, and folding XP into it would turn time
 * spent playing into permission to play for money.
 */

describe('the ladder', () => {
  it('starts everyone somewhere', () => {
    expect(standingOf(0).title).toBe('DRIFTER');
  });

  it('never goes backwards as XP rises', () => {
    let seen = 0;
    for (let xp = 0; xp <= 20_000; xp += 7) {
      const index = XP_STANDING.findIndex(t => t.title === standingOf(xp).title);
      expect(index).toBeGreaterThanOrEqual(seen);
      seen = index;
    }
  });

  it('lands each title exactly on its threshold', () => {
    for (const tier of XP_STANDING) {
      expect(standingOf(tier.at).title).toBe(tier.title);
      if (tier.at > 0) expect(standingOf(tier.at - 1).title).not.toBe(tier.title);
    }
  });

  it('reports the distance to the next title', () => {
    const s = standingOf(0);
    expect(s.nextAt).toBe(100);
    expect(s.toNext).toBe(100);

    const mid = standingOf(600);
    expect(mid.title).toBe('DELVER');
    expect(mid.toNext).toBe(1_500 - 600);
  });

  it('tops out without a null the UI has to special-case', () => {
    const top = standingOf(999_999);
    expect(top.title).toBe('LODEMASTER');
    expect(top.nextAt).toBeNull();
    // Zero rather than null, so a progress bar can always subtract.
    expect(top.toNext).toBe(0);
  });

  it('survives nonsense without throwing', () => {
    expect(standingOf(-50).title).toBe('DRIFTER');
    expect(standingOf(-50).xp).toBe(0);
    expect(standingOf(12.7).xp).toBe(12);
  });
});

describe('the thresholds mean something against what XP actually pays', () => {
  it('gives the walkthrough alone a title', () => {
    // 100 XP for finishing the tutorial — a new player should not still be
    // rank zero after the game has spent five minutes teaching them.
    expect(standingOf(TUTORIAL.reward.xp).title).toBe('DIGGER');
  });

  it('puts DELVER at roughly ten treasures', () => {
    expect(standingOf(10 * PUZZLE_HUNT_XP).title).toBe('DELVER');
  });

  it('keeps the top out of reach of a single session', () => {
    // A hundred puzzle tiles in one sitting must not be LODEMASTER.
    expect(standingOf(100 * TILES.puzzle.xp).title).not.toBe('LODEMASTER');
  });
});

describe('standing is not rank', () => {
  it('shares no tier name with the Prospector ladder', () => {
    // Two different measurements. Rank gates cash hunts on resolved hints,
    // active days and accuracy; standing gates nothing and counts activity. A
    // shared name is how they get conflated in a UI and then in someone's head.
    const rankTiers = ['prospector', 'surveyor', 'cartographer'];
    for (const tier of XP_STANDING) {
      expect(rankTiers).not.toContain(tier.title.toLowerCase());
    }
  });

  it('is not what a cash hunt checks', () => {
    // The door this keeps shut: XP is earned by playing, and if it ever became
    // the cash gate then time spent would buy permission to play for money —
    // which is exactly what the anti-sybil gate exists to prevent.
    expect(RANK.minTierForCash).toBe('prospector');
    expect(XP_STANDING.map(t => t.title)).not.toContain('prospector');
  });
});
