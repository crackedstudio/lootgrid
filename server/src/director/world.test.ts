import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as inference from '../agents/inference';
import {
  BUDGET_MS,
  CONDITIONS,
  EPOCH_MS,
  conditionFor,
  epochOf,
  fallbackCondition,
  moodFor,
  parseCondition,
  prefetch,
  promptFor,
  reset,
} from './world';

/**
 * The weather over a zone.
 *
 * This module exists to make the world feel alive without paying per agent for
 * it, so the tests come in three groups:
 *
 *   * **Broadcast** — everyone in a zone sees the same weather, or it is not
 *     weather, it is a private hallucination.
 *   * **Nothing waits** — the read path is synchronous and a slow, broken or
 *     hijacked model changes nothing about what a player sees.
 *   * **Blast radius** — the worst a fully hijacked world model can do is set a
 *     mood, and a mood cannot move money.
 */

const pulse = { population: 4, openHunts: 2, activeChasers: 3 };

beforeEach(() => reset());
afterEach(() => {
  inference.setProviderForTests(null);
  reset();
});

describe('the fallback is the default path, not the error path', () => {
  it('gives the same zone and epoch the same weather every time', () => {
    for (let e = 0; e < 50; e++) {
      expect(fallbackCondition('zone-a', e)).toEqual(fallbackCondition('zone-a', e));
    }
  });

  it('gives different zones different weather', () => {
    const a = Array.from({ length: 40 }, (_, e) => fallbackCondition('zone-a', e).kind);
    const b = Array.from({ length: 40 }, (_, e) => fallbackCondition('zone-b', e).kind);
    expect(a).not.toEqual(b);
  });

  it('keeps calm the commonest weather', () => {
    // A zone where something dramatic is always happening has a baseline, not
    // an event, and players stop reading it within one session.
    const kinds = Array.from({ length: 400 }, (_, e) => fallbackCondition('zone-a', e).kind);
    const calm = kinds.filter(k => k === 'calm').length;
    expect(calm).toBeGreaterThan(kinds.length * 0.4);
    expect(calm).toBeLessThan(kinds.length * 0.75);
  });

  it('only ever emits a legal condition', () => {
    for (let e = 0; e < 200; e++) {
      const c = fallbackCondition('zone-a', e);
      expect(CONDITIONS).toContain(c.kind);
      expect(c.intensity).toBeGreaterThanOrEqual(1);
      expect(c.intensity).toBeLessThanOrEqual(3);
    }
  });
});

describe('broadcast: one weather per zone per epoch', () => {
  it('hands two callers in the same epoch the identical object', () => {
    const now = 5 * EPOCH_MS;
    const a = conditionFor('zone-a', pulse, now);
    const b = conditionFor('zone-a', pulse, now + 1_000);
    expect(b).toBe(a); // identity, not just equality — it is write-once
  });

  it('cannot be overwritten by a prefetch that lands late', async () => {
    const now = 5 * EPOCH_MS;
    const issued = conditionFor('zone-a', pulse, now);

    inference.setProviderForTests(async () => ({
      ok: true,
      text: JSON.stringify({ kind: 'goldrush', intensity: 3 }),
    }));
    await prefetch('zone-a', epochOf(now), pulse);

    // A round already issued can never be rewritten under the players in it.
    expect(conditionFor('zone-a', pulse, now)).toBe(issued);
  });

  it('moves on to new weather in the next epoch', () => {
    const first = conditionFor('zone-a', pulse, 5 * EPOCH_MS);
    const later = conditionFor('zone-a', pulse, 9 * EPOCH_MS);
    // Not asserting they differ — they may legitimately both be calm — only
    // that a new epoch is genuinely re-decided rather than pinned forever.
    expect(later).toEqual(fallbackCondition('zone-a', 9));
    expect(first).toEqual(fallbackCondition('zone-a', 5));
  });
});

describe('nothing waits on a model', () => {
  it('reads synchronously even when the provider hangs', () => {
    inference.setProviderForTests(
      () => new Promise(() => {}) as Promise<never>, // never resolves
    );
    // The proof is that this line can be written at all: `conditionFor` returns
    // a value, not a promise, so no timeout can ever be widened into the path.
    const c = conditionFor('zone-a', pulse, 3 * EPOCH_MS);
    expect(CONDITIONS).toContain(c.kind);
  });

  it('uses the model’s answer when it arrives in budget', async () => {
    inference.setProviderForTests(async () => ({
      ok: true,
      text: JSON.stringify({ kind: 'goldrush', intensity: 2 }),
    }));
    await prefetch('zone-a', 7, pulse);
    expect(conditionFor('zone-a', pulse, 7 * EPOCH_MS)).toEqual({
      kind: 'goldrush',
      intensity: 2,
    });
  });

  it('discards an answer that took too long', async () => {
    inference.setProviderForTests(async () => {
      await new Promise(r => setTimeout(r, BUDGET_MS + 60));
      return { ok: true, text: JSON.stringify({ kind: 'goldrush', intensity: 3 }) };
    });
    await prefetch('zone-a', 7, pulse);
    // Late is not early. The zone gets its deterministic weather instead.
    expect(conditionFor('zone-a', pulse, 7 * EPOCH_MS)).toEqual(fallbackCondition('zone-a', 7));
  });

  it('falls back when the provider fails', async () => {
    inference.setProviderForTests(async () => ({ ok: false, reason: 'timeout' }));
    await prefetch('zone-a', 7, pulse);
    expect(conditionFor('zone-a', pulse, 7 * EPOCH_MS)).toEqual(fallbackCondition('zone-a', 7));
  });

  it('falls back when the provider throws', async () => {
    inference.setProviderForTests(async () => {
      throw new Error('socket closed');
    });
    await expect(prefetch('zone-a', 7, pulse)).resolves.toBeUndefined();
    expect(conditionFor('zone-a', pulse, 7 * EPOCH_MS)).toEqual(fallbackCondition('zone-a', 7));
  });
});

describe('a hijacked world model picks a word from a list', () => {
  it('rejects prose', () => {
    expect(parseCondition('the zone feels tense today')).toBeNull();
  });

  it('rejects a condition that is not in the set', () => {
    expect(parseCondition(JSON.stringify({ kind: 'apocalypse', intensity: 3 }))).toBeNull();
  });

  it('rejects an out-of-range intensity', () => {
    expect(parseCondition(JSON.stringify({ kind: 'calm', intensity: 99 }))).toBeNull();
  });

  it('rejects a legal condition carrying a smuggled extra field', () => {
    // Strict, not lenient — accepting-minus-the-extra-key is a model learning
    // it can get a field past the schema and into whatever reads the object.
    expect(
      parseCondition(JSON.stringify({ kind: 'calm', intensity: 1, payTo: '0xdead' })),
    ).toBeNull();
  });

  it('tolerates markdown fencing, because models add it', () => {
    expect(parseCondition('```json\n{"kind":"hush","intensity":2}\n```')).toEqual({
      kind: 'hush',
      intensity: 2,
    });
  });

  it('is told nothing that could identify a player', () => {
    // Blind by construction, the same rule the Director follows: there is no
    // field in ZonePulse to put a handle or an address in, and the prompt is
    // built from nothing else.
    const prompt = promptFor(pulse, fallbackCondition('zone-a', 1));
    expect(prompt).not.toMatch(/0x[0-9a-f]{6}/i);
    expect(prompt).not.toContain('@');
    expect(prompt).toContain('4 players present');
  });
});

describe('a mood cannot move money', () => {
  it('bends behaviour by a bounded amount, in both directions', () => {
    for (const kind of CONDITIONS) {
      for (const intensity of [1, 2, 3]) {
        const mood = moodFor({ kind, intensity });
        // Bounded on both sides: no weather can zero an agent out, and none can
        // double it. The ceiling that matters is still the owner's config.
        for (const m of [mood.boldness, mood.chattiness]) {
          expect(m).toBeGreaterThanOrEqual(0.3);
          expect(m).toBeLessThanOrEqual(1.5);
        }
      }
    }
  });

  it('leaves everything alone when the zone is calm', () => {
    expect(moodFor({ kind: 'calm', intensity: 3 })).toEqual({ boldness: 1, chattiness: 1 });
  });

  it('never reaches for a wallet, a repository or the chain', () => {
    // Same assertion `director.test` makes about itself, for the same reason:
    // "we did not give it a wallet" is a property that stops being true quietly.
    const src = readFileSync(join(__dirname, 'world.ts'), 'utf8');
    for (const forbidden of ['viem', 'chain/', 'db/repos', 'escrow', 'privateKey', 'signer']) {
      expect(src).not.toContain(forbidden);
    }
  });
});
