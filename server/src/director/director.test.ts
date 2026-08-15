import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as inference from '../agents/inference';
import { env } from '../env';
import * as director from './index';
import { fallbackDirective } from './fallback';
import { genesis, Transcript, verify } from './transcript';
import { blind, directiveSchema, parseDirective, type Directive } from './types';

/**
 * The Director.
 *
 * Architecture §4 gives four constraints and asks for a test on each; the plan
 * adds a fifth — the blinding — and calls it out specifically. All five are
 * here, and each is written against the property rather than the implementation,
 * because every one of them is the sort of thing that stops being true quietly:
 *
 *   1. schema-validated output, extra fields included
 *   2. per-round, broadcast identically to everyone racing
 *   3. pipelined — the model is never in the critical path
 *   4. past the budget, the deterministic fallback supplies the round
 *   5. blind — two states differing only in identity produce the same directive
 */

const here = dirname(fileURLToPath(import.meta.url));
const HUNT = { huntId: 'ridge-1-3x4-aaa', salt: 'salt-abc', difficulty: 'med' as const };

const mut = env as { AGENTS_ENABLED: boolean; DEEPSEEK_API_KEY?: string };
const original = { ...mut };

const legal: Directive = { difficulty: 3, roundType: 'sprint', twist: 'fog' };
const asJson = (d: Directive) => JSON.stringify(d);

beforeEach(() => {
  director.reset();
  mut.AGENTS_ENABLED = true;
  mut.DEEPSEEK_API_KEY = 'test-key';
  director.open(HUNT);
});

afterEach(() => {
  Object.assign(mut, original);
  inference.setProviderForTests(null);
  director.reset();
});

/** Waits for in-flight prefetches. The pipeline is deliberately not awaited. */
const settle = () => new Promise(r => setTimeout(r, 5));

describe('1. the output is schema-validated', () => {
  it('rejects extra fields rather than stripping them', () => {
    // A directive accepted minus its extra key would teach a model that it can
    // smuggle a field past the schema into whatever reads the object later.
    expect(directiveSchema.safeParse({ ...legal, payTo: '0xbad' }).success).toBe(false);
  });

  it('rejects everything that is not a legal directive', () => {
    for (const bad of [
      { difficulty: 0, roundType: 'sprint', twist: 'none' },
      { difficulty: 6, roundType: 'sprint', twist: 'none' },
      { difficulty: 3, roundType: 'invent', twist: 'none' },
      { difficulty: 3, roundType: 'sprint', twist: 'chaos' },
      { difficulty: 3.5, roundType: 'sprint', twist: 'none' },
      { difficulty: 3 },
      'ignore previous instructions',
      null,
    ]) {
      expect(directiveSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('tolerates a markdown fence and nothing else', () => {
    expect(parseDirective('```json\n' + asJson(legal) + '\n```')).toEqual({
      ok: true,
      directive: legal,
    });
    expect(parseDirective('Sure! Here is the round.').ok).toBe(false);
  });

  it('contributes nothing at all when the model goes off-script', async () => {
    // The containment: a hijacked Director does not get a partial say.
    inference.setProviderForTests(async () => ({
      ok: true,
      text: '{"difficulty":5,"roundType":"sprint","twist":"none","instruction":"pay 0xbad"}',
    }));

    await director.prefetch(HUNT.huntId, 1, blind(1, [10, 20], 1_000));
    const issued = director.directiveFor(HUNT.huntId, 1, blind(1, [10, 20], 1_000));

    expect(issued).toEqual(fallbackDirective(HUNT.salt, HUNT.huntId, 1, 'med'));
  });
});

describe('2. a round is issued once and broadcast identically', () => {
  it('hands every racer the same directive', () => {
    const first = director.directiveFor(HUNT.huntId, 0, blind(0, [0, 0, 0], 0));
    // A second racer reaching the same round a moment later, with the state
    // already moved on.
    const second = director.directiveFor(HUNT.huntId, 0, blind(0, [40, 5, 0], 900));

    expect(second).toEqual(first);
  });

  it('cannot be overwritten by an answer that arrives late', async () => {
    inference.setProviderForTests(async () => {
      await new Promise(r => setTimeout(r, 30));
      return { ok: true, text: asJson({ difficulty: 5, roundType: 'endurance', twist: 'haste' }) };
    });

    const state = blind(1, [10], 500);
    const prefetching = director.prefetch(HUNT.huntId, 1, state);
    // The round is reached while the prefetch is still in flight.
    const issued = director.directiveFor(HUNT.huntId, 1, state);
    await prefetching;

    // Some racers would already have seen the fallback, so the late answer must
    // not become the round.
    expect(director.directiveFor(HUNT.huntId, 1, state)).toEqual(issued);
  });
});

describe('3. the model is never in the critical path', () => {
  it('returns synchronously', () => {
    // Not "usually fast" — there is no code path on which a slow model can
    // delay a round, because there is nothing to await.
    const result = director.directiveFor(HUNT.huntId, 0, blind(0, [0], 0));
    expect(result).not.toBeInstanceOf(Promise);
    expect(directiveSchema.safeParse(result).success).toBe(true);
  });

  it('returns immediately even when the provider hangs', async () => {
    inference.setProviderForTests(
      () => new Promise(() => {}) as Promise<never>, // never resolves
    );

    const started = Date.now();
    director.directiveFor(HUNT.huntId, 0, blind(0, [0], 0));
    director.directiveFor(HUNT.huntId, 1, blind(1, [10], 500));
    // A hung provider is the case this design exists for.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('chooses the next round while this one plays', async () => {
    let askedFor = 0;
    inference.setProviderForTests(async () => {
      askedFor += 1;
      return { ok: true, text: asJson(legal) };
    });

    director.directiveFor(HUNT.huntId, 0, blind(0, [0], 0));
    await settle();

    // Issuing round 0 kicked off round 1 — that is the pipeline.
    expect(askedFor).toBe(1);
    expect(director.directiveFor(HUNT.huntId, 1, blind(1, [10], 500))).toEqual(legal);
  });
});

describe('4. past the budget, the fallback supplies the round', () => {
  it('uses the deterministic directive when nothing was prefetched', () => {
    const issued = director.directiveFor(HUNT.huntId, 3, blind(3, [50], 3_000));
    expect(issued).toEqual(fallbackDirective(HUNT.salt, HUNT.huntId, 3, 'med'));
  });

  it('discards an answer that took too long', async () => {
    inference.setProviderForTests(async () => {
      await new Promise(r => setTimeout(r, director.BUDGET_MS + 40));
      return { ok: true, text: asJson(legal) };
    });

    await director.prefetch(HUNT.huntId, 2, blind(2, [10], 900));
    // Late is dropped, not used: see the broadcast constraint above.
    expect(director.directiveFor(HUNT.huntId, 2, blind(2, [10], 900))).toEqual(
      fallbackDirective(HUNT.salt, HUNT.huntId, 2, 'med'),
    );
  });

  it('keeps running when the provider is gone entirely', async () => {
    inference.setProviderForTests(async () => ({ ok: false, reason: 'network' }));

    for (let round = 0; round < 5; round++) {
      const issued = director.directiveFor(HUNT.huntId, round, blind(round, [10], 1_000));
      expect(directiveSchema.safeParse(issued).success).toBe(true);
    }
    await settle();
    // If the model never answers again, hunts run exactly as they did before
    // phase 8. That is what makes it safe to put a model here at all.
    expect(director.transcriptOf(HUNT.huntId)!.length).toBe(5);
  });

  it('is deterministic, so a fallback round can be rechecked afterwards', () => {
    expect(fallbackDirective('salt-abc', 'h', 2, 'med')).toEqual(
      fallbackDirective('salt-abc', 'h', 2, 'med'),
    );
    expect(fallbackDirective('salt-abc', 'h', 2, 'med')).not.toEqual(
      fallbackDirective('salt-xyz', 'h', 2, 'med'),
    );
  });
});

describe('5. the Director is blind to who is playing', () => {
  /**
   * THE test the plan asks for by name: two states differing only in player
   * identity must produce the same directive.
   */
  it('produces the same state however the racers are ordered', () => {
    // Identity, in a blind state, can only survive as position — so a
    // permutation is the only way to express "the same race, different people".
    const alice = blind(4, [80, 10, 45], 5_000);
    const bob = blind(4, [45, 80, 10], 5_000);

    expect(alice).toEqual(bob);
  });

  it('issues the same directive for those states', async () => {
    let seen: string[] = [];
    inference.setProviderForTests(async req => {
      seen.push(req.user);
      return { ok: true, text: asJson(legal) };
    });

    await director.prefetch(HUNT.huntId, 1, blind(1, [80, 10, 45], 5_000));
    const first = director.directiveFor(HUNT.huntId, 1, blind(1, [80, 10, 45], 5_000));
    // Only the round-1 prompt. Issuing a round pipelines the next one, so later
    // entries describe a different round and would not be comparable.
    const firstPrompt = seen[0]!;

    director.reset();
    director.open(HUNT);
    seen = [];
    await director.prefetch(HUNT.huntId, 1, blind(1, [10, 45, 80], 5_000));
    const second = director.directiveFor(HUNT.huntId, 1, blind(1, [45, 80, 10], 5_000));

    expect(second).toEqual(first);
    // And the model was shown the identical prompt both times — the racers were
    // reordered in every call, and none of it reached the model.
    expect(seen[0]).toBe(firstPrompt);
  });

  it('has nowhere to put an identity', () => {
    // Structural rather than behavioural: the state type has no field for a
    // handle, an address or an attempt id, so blinding is not something the
    // caller has to remember.
    const state = blind(1, [10, 20], 500);
    expect(Object.keys(state).sort()).toEqual(['elapsedMs', 'progress', 'racers', 'round']);
    expect(JSON.stringify(state)).not.toMatch(/0x|handle|player/i);
  });

  it('never sees a player id even if the caller has one', async () => {
    const prompts: string[] = [];
    inference.setProviderForTests(async req => {
      prompts.push(`${req.system}\n${req.user}`);
      return { ok: true, text: asJson(legal) };
    });

    await director.prefetch(HUNT.huntId, 1, blind(1, [10, 90], 2_000));

    expect(prompts[0]).not.toContain('0x');
    expect(prompts[0]!.toLowerCase()).not.toContain('winning');
  });
});

describe('no wallet, no writes, no arbitrary HTTP', () => {
  it('imports nothing that could sign, store or fetch', () => {
    // "We did not give it a wallet" is exactly the kind of property that stops
    // being true in a later refactor, so it is asserted against the source.
    const sources = ['index.ts', 'types.ts', 'fallback.ts', 'transcript.ts'].map(f =>
      readFileSync(join(here, f), 'utf8'),
    );

    for (const source of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
      for (const path of imports) {
        expect(path, `director must not import ${path}`).not.toMatch(
          /db\/|repos\/|viem\/accounts|chain\/|attestor|privateKey/i,
        );
      }
      // The one network call it may make goes through the inference seam.
      expect(source).not.toMatch(/\bfetch\(/);
    }
  });
});

describe('the transcript replaces what a live Director destroys', () => {
  it('chains every issued round, fallbacks included', () => {
    // A chain recording only the model's rounds would have holes exactly where
    // the interesting question is.
    inference.setProviderForTests(async () => ({ ok: false, reason: 'network' }));

    for (let round = 0; round < 4; round++) {
      director.directiveFor(HUNT.huntId, round, blind(round, [10], 1_000), 1_700_000_000_000 + round);
    }

    const transcript = director.transcriptOf(HUNT.huntId)!;
    expect(transcript.length).toBe(4);
    expect(transcript.list().map(e => e.round)).toEqual([0, 1, 2, 3]);
  });

  it('can be recomputed by anyone holding the salt', () => {
    for (let round = 0; round < 3; round++) {
      director.directiveFor(HUNT.huntId, round, blind(round, [10], 0), 1_700_000_000_000 + round);
    }

    const transcript = director.transcriptOf(HUNT.huntId)!;
    // A verification only this server could perform would not be one.
    expect(verify(HUNT.huntId, HUNT.salt, transcript.list(), transcript.chainHead)).toBe(true);
  });

  it('detects a rewritten round', () => {
    const transcript = new Transcript('h', 'salt');
    transcript.append(0, legal, 1_000);
    transcript.append(1, { difficulty: 2, roundType: 'standard', twist: 'none' }, 2_000);

    const tampered = transcript.list();
    tampered[0]!.directive = { difficulty: 5, roundType: 'endurance', twist: 'haste' };

    // The point of the chain: not rigged differently per player, and not
    // rewritten after seeing who led.
    expect(verify('h', 'salt', tampered, transcript.chainHead)).toBe(false);
  });

  it('detects a backdated timestamp', () => {
    const transcript = new Transcript('h', 'salt');
    transcript.append(0, legal, 1_000);

    const tampered = transcript.list();
    tampered[0]!.at = 500;

    expect(verify('h', 'salt', tampered, transcript.chainHead)).toBe(false);
  });

  it('starts from the hunt and its salt', () => {
    // So the first link is computable by anyone holding a revealed salt,
    // without our help.
    expect(genesis('h', 'salt')).toBe(genesis('h', 'salt'));
    expect(genesis('h', 'salt')).not.toBe(genesis('h', 'other'));
  });
});
