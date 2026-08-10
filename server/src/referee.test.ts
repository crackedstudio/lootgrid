import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENERGY, RACE, TAP } from './config';
import * as energy from './energy';
import * as referee from './referee';
import * as store from './store';
import { freshWorld, huntOfType, makePlayer, teardownWorld } from './testing/harness';

const T0 = 1_700_000_000_000;

/** Human-ish tap stream: jittered intervals summing to roughly `totalMs`. */
function tapEvents(count: number, totalMs: number, jitter = 0.3): Array<{ seq: number; kind: string; t: number }> {
  const base = totalMs / (count - 1);
  const events = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      // Deterministic pseudo-jitter, so a flaky σ never makes a flaky test.
      const wobble = ((i * 37) % 11) / 11 - 0.5;
      t += Math.max(TAP.minIntervalMs + 5, base * (1 + wobble * jitter * 2));
    }
    events.push({ seq: i + 1, kind: 'tap', t: Math.round(t) });
  }
  // Normalise the final timestamp to the requested total.
  const scale = totalMs / (events[events.length - 1]!.t || 1);
  return events.map(e => ({ ...e, t: Math.round(e.t * scale) }));
}

/** Fixed-interval bot: no jitter at all. */
function botEvents(count: number, intervalMs: number) {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    kind: 'tap',
    t: i * intervalMs,
  }));
}

describe('referee', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    freshWorld();
  });

  afterEach(() => {
    referee.stop();
    vi.useRealTimers();
    teardownWorld();
  });

  describe('opening an attempt', () => {
    it('charges energy and returns the block spec', () => {
      const hunt = huntOfType('tap');
      const player = makePlayer('0xaaa');
      const before = energy.currentEnergy(player, T0);

      const res = referee.openAttempt(player, hunt, T0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.gameType).toBe('tap');
      expect(energy.currentEnergy(player, T0)).toBe(before - ENERGY.costCashHunt);
      expect(res.attempt.startedAt).toBe(T0);
    });

    it('refuses a second attempt on the same block', () => {
      const hunt = huntOfType('tap');
      const player = makePlayer('0xaaa');
      referee.openAttempt(player, hunt, T0);

      const second = referee.openAttempt(player, hunt, T0);
      expect(second).toMatchObject({ ok: false, error: 'already_attempted' });
    });

    it('refuses when energy is short, without charging', () => {
      const hunt = huntOfType('tap');
      const player = makePlayer('0xbbb');
      player.energyValue = 1;
      player.energyAt = T0;

      expect(referee.openAttempt(player, hunt, T0)).toMatchObject({
        ok: false,
        error: 'insufficient_energy',
      });
      expect(energy.currentEnergy(player, T0)).toBe(1);
    });

    it('serves every racer the identical block game', () => {
      const hunt = huntOfType('tap');
      const a = referee.openAttempt(makePlayer('0xa'), hunt, T0);
      const b = referee.openAttempt(makePlayer('0xb'), hunt, T0);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.spec).toEqual(b.spec);
    });

    it('keeps shadow-banned players out of cash blocks', () => {
      const hunt = huntOfType('tap');
      const player = makePlayer('0xbad');
      player.shadowBanned = true;
      // Indistinguishable from the block having just closed — on purpose.
      expect(referee.openAttempt(player, hunt, T0)).toMatchObject({
        ok: false,
        error: 'hunt_not_live',
      });
    });
  });

  describe('input validation', () => {
    it('fails an attempt on a sequence gap', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      referee.submitInputs(res.attempt.id, [{ seq: 3, kind: 'tap', t: 100 }], T0 + 100);
      expect(store.getAttempt(res.attempt.id)!.failReason).toBe('seq_gap');
    });

    it('ignores duplicate sequence numbers', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      referee.submitInputs(res.attempt.id, [{ seq: 1, kind: 'tap', t: 50 }], T0 + 50);
      referee.submitInputs(res.attempt.id, [{ seq: 1, kind: 'tap', t: 50 }], T0 + 60);

      const attempt = store.getAttempt(res.attempt.id)!;
      expect(attempt.status).toBe('active');
      expect(attempt.lastSeq).toBe(1);
    });

    it('rejects a client claiming to be ahead of the server', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      // You cannot finish faster than your packets arrived.
      referee.submitInputs(res.attempt.id, [{ seq: 1, kind: 'tap', t: 5_000 }], T0 + 100);
      expect(store.getAttempt(res.attempt.id)!.failReason).toBe('client_ahead_of_server');
    });

    it('rejects client time running backwards', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      referee.submitInputs(
        res.attempt.id,
        [
          { seq: 1, kind: 'tap', t: 300 },
          { seq: 2, kind: 'tap', t: 200 },
        ],
        T0 + 400,
      );
      expect(store.getAttempt(res.attempt.id)!.failReason).toBe('client_time_went_backwards');
    });
  });

  describe('racing', () => {
    it('awards the block to the lowest elapsed time inside the window', () => {
      const hunt = huntOfType('tap');
      const slow = makePlayer('0xslow', '@slow');
      const fast = makePlayer('0xfast', '@fast');

      const a = referee.openAttempt(slow, hunt, T0);
      const b = referee.openAttempt(fast, hunt, T0);
      if (!a.ok || !b.ok) throw new Error('setup');

      const target = (a.spec as { target: number }).target;

      // Slow finishes first in wall-clock terms, but with a worse elapsed time.
      referee.submitInputs(a.attempt.id, tapEvents(target, 2_100), T0 + 2_100);
      referee.submitInputs(b.attempt.id, tapEvents(target, 1_900), T0 + 1_900);

      vi.advanceTimersByTime(RACE.settlementWindowMs + 50);

      const resolved = store.getHunt(hunt.id)!;
      expect(resolved.status).toBe('resolved');
      expect(resolved.winnerId).toBe(fast.id);

      const winner = store.attemptHistory(fast.id, 5)[0]!;
      expect(winner.status).toBe('won');
      expect(winner.elapsedMs).toBe(1_900);
      // Finished first in wall-clock order, but with the worse elapsed time.
      expect(store.attemptHistory(slow.id, 5)[0]!.status).toBe('lost');
    });

    it('does not resolve before the window closes', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      referee.submitInputs(
        res.attempt.id,
        tapEvents((res.spec as { target: number }).target, 1_500),
        T0 + 1_500,
      );

      vi.advanceTimersByTime(RACE.settlementWindowMs - 100);
      expect(store.getHunt(hunt.id)!.status).toBe('resolving');

      vi.advanceTimersByTime(200);
      expect(store.attemptHistory('0xaaa', 5)[0]!.status).toBe('won');
    });

    it('restocks the zone after a block is cracked', () => {
      const hunt = huntOfType('tap');
      const zone = store.getZone(hunt.zoneId)!;
      const before = store.liveHuntsIn(zone).length;

      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');
      referee.submitInputs(
        res.attempt.id,
        tapEvents((res.spec as { target: number }).target, 1_500),
        T0 + 1_500,
      );
      vi.advanceTimersByTime(RACE.settlementWindowMs + 50);

      expect(store.liveHuntsIn(zone).length).toBe(before);
    });

    it('rejects a fixed-interval bot even when it is fastest', () => {
      const hunt = huntOfType('tap');
      const human = makePlayer('0xhuman', '@human');
      const bot = makePlayer('0xbot', '@bot');

      const h = referee.openAttempt(human, hunt, T0);
      const b = referee.openAttempt(bot, hunt, T0);
      if (!h.ok || !b.ok) throw new Error('setup');
      const target = (h.spec as { target: number }).target;

      // The bot is comfortably faster in raw time.
      referee.submitInputs(b.attempt.id, botEvents(target, 60), T0 + 60 * target);
      expect(store.getAttempt(b.attempt.id)!.failReason).toBe('timing_too_regular');

      referee.submitInputs(h.attempt.id, tapEvents(target, 2_500), T0 + 2_500);
      vi.advanceTimersByTime(RACE.settlementWindowMs + 50);

      expect(store.attemptHistory(human.id, 5)[0]!.status).toBe('won');
      expect(store.attemptHistory(bot.id, 5)[0]!.status).toBe('failed');
    });

    it('persists the input log for a finished attempt', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');
      const target = (res.spec as { target: number }).target;

      referee.submitInputs(res.attempt.id, tapEvents(target, 1_800), T0 + 1_800);
      vi.advanceTimersByTime(RACE.settlementWindowMs + 50);

      // The audit trail is what makes a disputed result checkable after the fact.
      expect(store.attemptEvents(res.attempt.id)).toHaveLength(target);
    });
  });

  describe('deadlines', () => {
    it('fails an attempt that runs past its deadline', () => {
      const hunt = huntOfType('tap');
      const res = referee.openAttempt(makePlayer('0xaaa'), hunt, T0);
      if (!res.ok) throw new Error('setup');

      referee.start();
      vi.advanceTimersByTime(res.limitMs + RACE.latencyGraceMs + 500);

      expect(store.getAttempt(res.attempt.id)!.failReason).toBe('timeout');
    });
  });
});
