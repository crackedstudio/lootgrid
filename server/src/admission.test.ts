import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as admission from './admission';
import { KEYS, RANK, WALLET } from './config';
import { getDb } from './db/index';
import * as hintRepo from './db/repos/hints';
import * as hints from './hints';
import * as keys from './keys';
import * as rank from './rank';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, huntOfType, makeAgedPlayer, makePlayer, makeVeteran, teardownWorld } from './testing/harness';
import type { Hunt } from './types';

/**
 * The money gate.
 *
 * One person with fifty wallets is the biggest threat to a pot with real money
 * in it, and anti-bot detection does not touch it — those are not scripts, they
 * are a human clicking. The review's instruction is a hard sequencing rule: no
 * real money in a zone until private maps, the rank gate and the wallet check
 * are all live and tested. This file is the "and tested" half.
 */

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => freshWorld());
afterEach(() => teardownWorld());

const cashHunt = (): Hunt => huntOfType('crack');
const puzzleHunt = (): Hunt => {
  const zone = store.listZones()[0]!;
  const h = store.liveHuntsIn(zone).find(x => x.kind === 'puzzle');
  if (!h) throw new Error('no puzzle hunt seeded');
  return store.getHunt(h.id)!;
};

describe('a brand new account cannot take money out', () => {
  it('refuses a wallet created moments ago', () => {
    const player = makePlayer('0xnew');
    const verdict = admission.mayEnter(player, cashHunt());

    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('wallet_too_new');
  });

  it('says when it will be ready, rather than just no', () => {
    // A refusal with no number reads as rigged. This one is actionable and
    // gives away nothing an attacker could not read in the config.
    const player = makePlayer('0xnew');
    const verdict = admission.mayEnter(player, cashHunt());
    expect(verdict.detail?.readyAt).toBe(player.createdAt + WALLET.minAgeMs);
  });

  it('refuses an aged wallet that has never played', () => {
    // Age alone is cheap: register fifty wallets and wait. Rank is what makes
    // the wait expensive, because it has to be spent playing.
    const player = makePlayer('0xaged');
    player.createdAt = Date.now() - 30 * DAY;

    const verdict = admission.mayEnter(player, cashHunt());
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('rank_too_low');
    expect(verdict.detail?.tier).toBe('unranked');
  });

  it('admits a player who has actually prospected', () => {
    expect(admission.mayEnter(makeVeteran('0xok'), cashHunt()).ok).toBe(true);
  });
});

describe('none of it applies to XP', () => {
  /**
   * A new player can play essentially the whole game on their first day —
   * twenty-three of every twenty-four treasures pay XP. What they cannot do on
   * day one is take cash out. That split is also what keeps the free path to
   * every prize real: rank is earned by playing, and playing is free.
   */
  it('lets a brand new account enter a puzzle hunt', () => {
    expect(admission.mayEnter(makePlayer('0xnew'), puzzleHunt()).ok).toBe(true);
  });

  it('does not spend a key on a puzzle hunt', () => {
    const player = makeVeteran('0xp');
    const before = keys.balance(player.id).remaining;
    referee.openAttempt(player, puzzleHunt());
    expect(keys.balance(player.id).remaining).toBe(before);
  });
});

describe('keys cap what one identity can extract', () => {
  it('starts everyone with the same allowance', () => {
    expect(keys.balance('0xanyone').remaining).toBe(KEYS.perDay);
    expect(keys.balance('0xanyone').perDay).toBe(KEYS.perDay);
  });

  it('spends one per cash entry', () => {
    const player = makeVeteran('0xk');
    referee.openAttempt(player, cashHunt());
    expect(keys.balance(player.id).remaining).toBe(KEYS.perDay - 1);
  });

  it('refuses the entry after the last key', () => {
    const player = makeVeteran('0xspent');
    // Record the allowance as already spent today.
    exhaustKeys(player.id);

    const verdict = admission.mayEnter(player, cashHunt());
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('no_keys_left');
    expect(verdict.detail?.resetsAt).toBeGreaterThan(Date.now());
  });

  it('resets on the UTC day boundary', () => {
    const player = makeVeteran('0xtomorrow');
    exhaustKeys(player.id);

    expect(keys.hasKey(player.id)).toBe(false);
    expect(keys.hasKey(player.id, Date.now() + DAY)).toBe(true);
  });

  /**
   * The property the whole two-currency split exists for.
   *
   * There is no balance to credit — a key is a count of cash attempts
   * subtracted from a constant — so no function anywhere can grant one. That is
   * what makes "money never buys a chance at the prize" a fact about the code
   * rather than a policy someone has to remember.
   */
  it('exposes no way to grant a key', () => {
    const surface = Object.keys(keys as Record<string, unknown>);
    expect(surface.sort()).toEqual(['balance', 'dayStart', 'hasKey']);
  });
});

describe('rank is earned over days, not bought', () => {
  it('starts unranked', () => {
    expect(rank.rankOf('0xnobody').tier).toBe('unranked');
  });

  it('needs hints that have actually resolved', () => {
    const player = makePlayer('0xlive');
    // Hints held on a hunt that is still LIVE do not count. Counting them would
    // let an account rank up on hints it has not had to be right about, and
    // would leak the answer to a game in progress into a public number.
    const hunt = cashHunt();
    for (const h of hints.forHunt(hunt)) hintRepo.grant(player.id, h.id, 'reveal', Date.now());

    expect(rank.rankOf(player.id).resolved).toBe(0);
    expect(rank.rankOf(player.id).tier).toBe('unranked');
  });

  it('needs them spread across distinct days', () => {
    const player = makePlayer('0xoneday');
    const hunt = puzzleHunt();
    const pool = hints.forHunt(hunt);
    store.setHuntStatus(hunt, 'expired', null, Date.now());
    // Enough hints, all acquired within one day. This is precisely the shape of
    // a burner farmed hard for an hour, and it must not rank.
    const sameDay = Date.now();
    for (const h of pool) hintRepo.grant(player.id, h.id, 'reveal', sameDay);

    const report = rank.rankOf(player.id);
    expect(report.resolved).toBeGreaterThanOrEqual(RANK.minResolvedHints);
    expect(report.activeDays).toBe(1);
    expect(report.tier).toBe('unranked');
  });

  it('ranks a player with resolved hints across days', () => {
    const player = makeVeteran('0xreal');
    const report = rank.rankOf(player.id);
    expect(report.resolved).toBeGreaterThanOrEqual(RANK.minResolvedHints);
    expect(report.activeDays).toBeGreaterThanOrEqual(RANK.minActiveDays);
    expect(rank.ordinalOf(report.tier)).toBeGreaterThanOrEqual(
      rank.ordinalOf(RANK.minTierForCash),
    );
  });

  it('reports what is still missing', () => {
    const report = rank.rankOf('0xnobody');
    expect(report.nextTier).toBe('prospector');
    expect(report.shortfall.resolved).toBe(RANK.minResolvedHints);
    expect(report.shortfall.activeDays).toBe(RANK.minActiveDays);
  });
});

describe('the ban keeps its disguise', () => {
  it('is indistinguishable from the hunt having closed', () => {
    // Every other refusal explains itself. This one must not: telling a
    // suspected botter exactly when they were caught only helps them iterate.
    const player = makeVeteran('0xbanned');
    player.shadowBanned = true;

    expect(referee.openAttempt(player, cashHunt())).toMatchObject({
      ok: false,
      error: 'hunt_not_live',
    });
  });
});

describe('agent zones exempt rank, and nothing else', () => {
  const agentCashHunt = () => {
    const zone = store.listZones().find(z => z.kind === 'agent')!;
    return store.getHunt(store.liveHuntsIn(zone).find(h => h.kind === 'cash')!.id)!;
  };

  /**
   * Rank is genuinely unsatisfiable for an agent.
   *
   * It is computed from hints held on closed hunts, and hints come from digging
   * fog. Agents do not dig — they enter, reason and trade — so they would sit at
   * `unranked` forever however well they played, and the agent zone would close
   * silently. The symptom would read as "nobody enters" rather than as a bug.
   */
  it('admits an unranked player to an agent cash hunt', () => {
    const player = makeAgedPlayer('0xagent');
    expect(rank.rankOf(player.id).tier).toBe('unranked');
    expect(admission.mayEnter(player, agentCashHunt(), 'agent').ok).toBe(true);
  });

  it('still refuses that same player on a human zone', () => {
    const player = makeAgedPlayer('0xagent2');
    expect(admission.mayEnter(player, cashHunt(), 'human')).toMatchObject({
      ok: false,
      code: 'rank_too_low',
    });
  });

  /**
   * The hole this closes.
   *
   * The exemption used to be a blanket `return ALLOWED`, which skipped the key
   * cap too — so cash entries on an agent zone were unlimited. Once a seat is
   * sold, that makes the product "pay us and, unlike everyone else, get
   * unbounded chances at cash", which is precisely the sentence the
   * two-currency split exists to make untrue.
   */
  it('applies the key cap on an agent zone', () => {
    const player = makeAgedPlayer('0xagent3');
    exhaustKeys(player.id);

    expect(admission.mayEnter(player, agentCashHunt(), 'agent')).toMatchObject({
      ok: false,
      code: 'no_keys_left',
    });
  });

  it('applies the wallet-age check on an agent zone', () => {
    // A burner agent wallet is exactly as cheap as a burner human one.
    const fresh = makePlayer('0xagent4');
    expect(admission.mayEnter(fresh, agentCashHunt(), 'agent')).toMatchObject({
      ok: false,
      code: 'wallet_too_new',
    });
  });

  it('still lets anyone into an agent PUZZLE hunt', () => {
    // None of the above is about XP.
    const zone = store.listZones().find(z => z.kind === 'agent')!;
    const puzzle = store.getHunt(store.liveHuntsIn(zone).find(h => h.kind === 'puzzle')!.id)!;
    expect(admission.mayEnter(makePlayer('0xagent5'), puzzle, 'agent').ok).toBe(true);
  });
});

// ---- helpers ----

/**
 * Record a full day's worth of cash entries, without playing them.
 *
 * One attempt per hunt, because UNIQUE (hunt_id, player_id) is the one-shot
 * rule and it is not being tested here. The world seeds exactly one cash hunt
 * per zone, which is where the five come from — a pleasing coincidence with
 * KEYS.perDay, and one the assertion below does not rely on.
 */
function exhaustKeys(playerId: string): void {
  const cashHunts = store
    .listZones()
    .flatMap(z => store.liveHuntsIn(z))
    .filter(h => h.kind === 'cash');

  expect(cashHunts.length).toBeGreaterThanOrEqual(KEYS.perDay);

  const stmt = getDb().prepare(`
    INSERT INTO attempts (id, hunt_id, player_id, handle, game_type, started_at,
                          deadline_at, status, last_seq, progress, intervals, max_clock_skew_ms)
    VALUES (?, ?, ?, '@x', 'crack', ?, ?, 'lost', 0, 0, '[]', 0)
  `);
  for (let i = 0; i < KEYS.perDay; i++) {
    stmt.run(`spent_${playerId}_${i}`, cashHunts[i]!.id, playerId, Date.now(), Date.now());
  }
}
