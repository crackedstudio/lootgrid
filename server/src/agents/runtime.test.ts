import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as budget from './budget';
import { defaultConfig, type AgentConfig } from './config';
import * as inference from './inference';
import { messageSchema, PROTOCOL_VERSION } from './protocol';
import * as runtime from './runtime';
import * as seats from './seats';
import { MOVE_SCHEMAS } from './validate';

/**
 * The multi-tenant pool.
 *
 * The plan's gate for this phase names one property that lives here: **no
 * cross-tenant context bleed.** Agent A's prompt must never contain agent B's
 * hints, budget or anything else — one provider account serves everybody, and
 * the failure mode is silent.
 *
 * The other two are operational and just as load-bearing: a busy tenant must not
 * starve a quiet one, and a looping agent must be refused its next call rather
 * than billed for it.
 */

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b0';
const ALICE_PLAYER = '0x00000000000000000000000000000000000000c1';
const BOB_PLAYER = '0x00000000000000000000000000000000000000c2';

const mut = env as { AGENTS_ENABLED: boolean; DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL: string };
const original = { ...mut };

/** A deduction context. The spec and state are this tenant's alone. */
function context(
  agentId: string,
  playerId: string,
  over: Partial<runtime.TurnContext> = {},
): runtime.TurnContext {
  return {
    agentId,
    playerId,
    huntId: 'hunt-1',
    difficulty: 'med',
    gameType: 'deduction',
    config: { ...defaultConfig(), zones: ['ridge'] } as AgentConfig,
    spec: { rows: 18, cols: 12, budget: 9, limitMs: 600_000 },
    state: { used: 0, answers: [], solved: false },
    inbox: [],
    ...over,
  };
}

beforeEach(() => {
  freshWorld();
  runtime.reset();
  mut.AGENTS_ENABLED = true;
  mut.DEEPSEEK_API_KEY = 'test-key-not-a-real-one';
  mut.DEEPSEEK_MODEL = 'deepseek-v4-flash';
  agentRepo.create(ALICE, ALICE_PLAYER);
  agentRepo.create(BOB, BOB_PLAYER);
  // Inference is house-funded, so a turn that reaches the provider needs a seat.
  // These tests are about the pool and the budget, not about who paid — the
  // seat gate has its own tests.
  seats.grant(ALICE, ALICE_PLAYER, { mills: 1_000_000 });
  seats.grant(BOB, BOB_PLAYER, { mills: 1_000_000 });
});

afterEach(() => {
  Object.assign(mut, original);
  inference.setProviderForTests(null);
  runtime.reset();
  teardownWorld();
});

describe('no cross-tenant context bleed', () => {
  it('builds a prompt from this tenant’s data and nothing else', () => {
    // The gate. Bob's secrets are put somewhere a careless implementation might
    // reach for — a shared cache, a module-level buffer — and then Alice's
    // prompt is checked for them.
    const bobSecret = 'BOBS-PRIVATE-HINT-PAYLOAD';
    runtime.buildPrompt(
      context(BOB, BOB_PLAYER, {
        state: { used: 3, answers: [{ payload: { note: bobSecret } }], solved: false },
      }),
    );

    const alicePrompt = runtime.buildPrompt(context(ALICE, ALICE_PLAYER));

    expect(alicePrompt).not.toContain(bobSecret);
    expect(alicePrompt).not.toContain(BOB);
    expect(alicePrompt).not.toContain(BOB_PLAYER);
  });

  it('is a pure function of its argument', () => {
    // Purity is what makes the property structural rather than a habit: a leak
    // would require passing another tenant's data in explicitly.
    const ctx = context(ALICE, ALICE_PLAYER);
    const first = runtime.buildPrompt(ctx);

    runtime.buildPrompt(context(BOB, BOB_PLAYER, { state: { used: 7, answers: [], solved: true } }));

    expect(runtime.buildPrompt(ctx)).toBe(first);
  });

  it('never puts money in the prompt', () => {
    // A model that knows its own ceiling plans around the ceiling; a model that
    // knows its vault address has been handed the thing the caps protect.
    const rich = context(ALICE, ALICE_PLAYER, {
      config: { ...defaultConfig(), zones: ['ridge'], dailyBudgetCents: 99_999 } as AgentConfig,
    });
    const prompt = runtime.buildPrompt(rich);

    expect(prompt).not.toContain('99999');
    expect(prompt).not.toContain('dailyBudget');
    expect(prompt).not.toContain('maxHintPrice');
    expect(prompt).not.toContain('inferenceMills');
  });

  it('renders rival messages through the typed protocol, never raw', () => {
    const message = messageSchema.parse({
      v: PROTOCOL_VERSION,
      from: BOB,
      thread: 'th_1',
      intent: 'offer_hint',
      listingId: 'lst_1',
      priceCents: 25,
      tier: 2,
      reliabilityBps: 7_000,
      zoneId: 'ridge',
    });

    const prompt = runtime.buildPrompt(context(ALICE, ALICE_PLAYER, { inbox: [message] }));

    expect(prompt).toContain('A rival offers listing lst_1');
    // Not the object. Handing a model raw JSON invites it to treat unexpected
    // keys as meaningful.
    expect(prompt).not.toContain('"intent"');
    expect(prompt).not.toContain('{"v"');
  });

  it('keeps the provider key out of every prompt', () => {
    const prompt = runtime.buildPrompt(context(ALICE, ALICE_PLAYER));
    expect(prompt).not.toContain('test-key-not-a-real-one');
    expect(runtime.SYSTEM_PROMPT).not.toContain('test-key-not-a-real-one');
  });
});

describe('the budget is checked before the call', () => {
  it('makes no provider call once the hunt’s inference budget is gone', async () => {
    let calls = 0;
    inference.setProviderForTests(async () => {
      calls += 1;
      return { ok: true, text: '{"kind":"probe","value":{"kind":"parity","parity":"even"}}' };
    });

    const ctx = context(ALICE, ALICE_PLAYER, {
      config: { ...defaultConfig(), zones: ['ridge'], inferenceMillsPerHunt: 0 } as AgentConfig,
    });
    const outcome = await runtime.schedule(ctx);

    // A looping agent must be refused its next call, not billed for it.
    expect(calls).toBe(0);
    expect(outcome.billedMills).toBe(0);
    expect(outcome.refused).toBe('inference_budget');
    // Refused is not forfeited: it plays on deterministically, for free.
    expect(outcome.source).toBe('fallback');
    expect(outcome.move.kind).toBeTruthy();
  });

  it('bills what actually happened, including a retry', async () => {
    let calls = 0;
    inference.setProviderForTests(async () => {
      calls += 1;
      // First response is prose; the retry is a legal move.
      return calls === 1
        ? { ok: true, text: 'I think I should probe the north-west.' }
        : { ok: true, text: '{"kind":"probe","value":{"kind":"region","quadrant":"NW"}}' };
    });

    const outcome = await runtime.schedule(context(ALICE, ALICE_PLAYER));

    expect(outcome.source).toBe('retry');
    // The budget authorised one call; a retry that took a second is still the
    // house's money, so the ledger records two.
    expect(outcome.billedMills).toBe(2 * budget.callCostMills('deepseek-v4-flash'));
    expect(agentRepo.spentOnHunt(ALICE, 'hunt-1', 'inference')).toBe(outcome.billedMills);
  });

  it('refuses a killed agent without calling anything', async () => {
    let calls = 0;
    inference.setProviderForTests(async () => {
      calls += 1;
      return { ok: false, reason: 'network' };
    });

    agentRepo.setStatus(ALICE, 'killed');
    const outcome = await runtime.schedule(context(ALICE, ALICE_PLAYER));

    expect(calls).toBe(0);
    expect(outcome.refused).toBe('agent_not_active');
  });
});

describe('a provider that is down never stalls a hunt', () => {
  it('falls back to a legal move', async () => {
    inference.setProviderForTests(async () => ({ ok: false, reason: 'timeout' }));

    const outcome = await runtime.schedule(context(ALICE, ALICE_PLAYER));

    expect(outcome.source).toBe('fallback');
    // Good, not merely legal: the halving probe is the line the module's own
    // tests use to prove the game winnable.
    expect(outcome.move.kind).toBe('probe');
  });

  it('falls back when the model returns nonsense twice', async () => {
    inference.setProviderForTests(async () => ({ ok: true, text: 'no idea, sorry' }));

    const outcome = await runtime.schedule(context(ALICE, ALICE_PLAYER));
    expect(outcome.source).toBe('fallback');
  });

  it('stops retrying a disabled provider', async () => {
    let calls = 0;
    inference.setProviderForTests(async () => {
      calls += 1;
      return { ok: false, reason: 'disabled' };
    });

    await runtime.schedule(context(ALICE, ALICE_PLAYER));
    // Disabled will not become enabled on a retry.
    expect(calls).toBe(1);
  });
});

describe('fair scheduling', () => {
  it('does not let a busy tenant starve a quiet one', async () => {
    const order: string[] = [];
    inference.setProviderForTests(async () => {
      await new Promise(r => setTimeout(r, 1));
      return { ok: true, text: '{"kind":"probe","value":{"kind":"parity","parity":"even"}}' };
    });

    // Alice queues ten turns before Bob queues one.
    const busy = Array.from({ length: 10 }, (_, i) =>
      runtime
        .schedule(context(ALICE, ALICE_PLAYER, { huntId: `hunt-${i}` }))
        .then(() => order.push('alice')),
    );
    const quiet = runtime
      .schedule(context(BOB, BOB_PLAYER, { huntId: 'hunt-bob' }))
      .then(() => order.push('bob'));

    await Promise.all([...busy, quiet]);

    // Round-robin, not FIFO: Bob's single turn must not wait behind all ten.
    // "Starved" here would mean somebody's hunt expiring.
    expect(order.indexOf('bob')).toBeLessThan(5);
  });

  it('drains everything it is given', async () => {
    inference.setProviderForTests(async () => ({
      ok: true,
      text: '{"kind":"probe","value":{"kind":"parity","parity":"odd"}}',
    }));

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runtime.schedule(context(ALICE, ALICE_PLAYER, { huntId: `h-${i}` })),
      ),
    );

    expect(outcomes).toHaveLength(12);
    expect(outcomes.every(o => o.move.kind === 'probe')).toBe(true);
  });
});

describe('the prompt states the move format', () => {
  /**
   * The mainnet failure this guards.
   *
   * Without an explicit shape the model answers plausibly and differently —
   * `{"keepBps":6000}`, or `action` where `kind` belongs — and MOVE_SCHEMAS
   * rejects it whole. Observed live: two `not_a_move` violations per turn (the
   * call and its retry) and a deterministic fallback every time, while both
   * attempts were billed.
   */
  it('has a format for every game the agent can play', () => {
    for (const game of Object.keys(MOVE_SCHEMAS)) {
      const prompt = runtime.buildPrompt({
        game, gameType: game, spec: {}, state: {},
        config: defaultConfig() as AgentConfig, inbox: [],
      } as never);
      expect(prompt).toContain('"kind"');
    }
  });

  it('shows negotiation the exact key the schema demands', () => {
    const prompt = runtime.buildPrompt({
      game: 'negotiation', gameType: 'negotiation', spec: {}, state: {},
      config: defaultConfig() as AgentConfig, inbox: [],
    } as never);
    expect(prompt).toContain('keepBps');
    expect(prompt).toContain('"kind":"offer"');
  });

  /** The examples must actually satisfy the schemas they describe. */
  it('advertises only shapes MOVE_SCHEMAS accepts', () => {
    expect(MOVE_SCHEMAS.negotiation.safeParse(
      { kind: 'offer', value: { keepBps: 6000 } }).success).toBe(true);
    expect(MOVE_SCHEMAS.search.safeParse(
      { kind: 'probe', value: { r: 3, c: 4 } }).success).toBe(true);
    expect(MOVE_SCHEMAS.deduction.safeParse(
      { kind: 'commit', value: { r: 3, c: 4 } }).success).toBe(true);
    expect(MOVE_SCHEMAS.deduction.safeParse(
      { kind: 'probe', value: { kind: 'parity', parity: 'even' } }).success).toBe(true);
    // The shape the model produced unprompted, which must stay invalid.
    expect(MOVE_SCHEMAS.negotiation.safeParse({ keepBps: 6000 }).success).toBe(false);
  });
});
