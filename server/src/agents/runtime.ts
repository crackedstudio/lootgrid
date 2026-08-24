import * as agentRepo from '../db/repos/agents';
import { logger } from '../logger';
import { env } from '../env';
import * as metrics from '../metrics';
import * as seats from './seats';
import type { Difficulty, GameType } from '../types';
import * as budget from './budget';
import { promptView, type AgentConfig } from './config';
import { model } from './inference';
import { render, type Message } from './protocol';
import { fallbackMove, isAgentGame, takeTurn, type AgentGame, type Move } from './validate';

/**
 * One pool, many agents.
 *
 * ─────────────────────────── this is a service, not a process ───────────────
 *
 * Players do not bring API keys, so the house runs inference for everybody
 * against one provider account. That makes this multi-tenant, and multi-tenant
 * is where the interesting failures are: one agent's data reaching another's
 * prompt, one busy tenant starving everyone else, one looping agent billing the
 * house. Architecture §7 lists those as requirements; this module is where they
 * are met.
 *
 * ─────────────────────────── isolation by construction ─────────────────────
 *
 * A prompt is built from exactly three things, all passed as arguments:
 *
 *   * the game's public spec and this agent's own state
 *   * this agent's own config, through {@link promptView}
 *   * messages addressed to this agent, rendered by the typed protocol
 *
 * There is no module-level cache of prompts, no shared conversation buffer, and
 * no "recent context" anything. {@link buildPrompt} is a pure function, so a
 * cross-tenant leak would require passing another tenant's data in explicitly —
 * which is exactly what the isolation test does, in reverse, to prove it cannot
 * happen by accident.
 *
 * The shared mutable state in this file is the queue, and it holds turn requests
 * rather than content.
 *
 * ─────────────────────────── fair scheduling ───────────────────────────
 *
 * Round-robin across tenants, not FIFO across turns. An agent playing three
 * hunts at once must not get three times the throughput of one playing a single
 * hunt, or a busy tenant starves a quiet one on a shared provider quota — and
 * "starves" here means somebody's hunt expires.
 */

export interface TurnContext {
  agentId: string;
  playerId: string;
  huntId: string;
  difficulty: Difficulty;
  gameType: GameType;
  config: AgentConfig;
  /** The module's public spec. Never the secret. */
  spec: unknown;
  /** This agent's own runtime state for the attempt. */
  state: unknown;
  /** Messages addressed to THIS agent. Already validated by protocol.ts. */
  inbox: Message[];
}

export interface TurnOutcome {
  move: Move;
  source: 'model' | 'retry' | 'fallback';
  /** Mills actually billed. Zero when the budget refused before any call. */
  billedMills: number;
  refused?: string;
}

/**
 * The instructions. Fixed, and deliberately not per-player.
 *
 * A per-player system prompt would be a string a player controls reaching a
 * model that can spend their money — the same argument that keeps free text out
 * of the agent config and out of the A2A protocol. What a player configures is
 * numbers, and numbers arrive in the user turn.
 */
export const SYSTEM_PROMPT = [
  'You are playing a turn-based puzzle for a small cash prize.',
  'Reply with a single JSON object describing ONE legal move and nothing else.',
  'No prose, no explanation, no markdown fence.',
  'If the situation is unclear, make the move that most reduces uncertainty.',
].join(' ');

/** Bounded: a move is a small object, and a model that rambles is one that bills. */
export const MAX_TOKENS = 200;

/**
 * Build the user turn.
 *
 * Pure, and takes everything it needs as arguments — that is what makes
 * cross-tenant leakage structurally impossible rather than merely avoided. Note
 * what is absent: the agent's daily budget, its vault address, its balance, and
 * anything at all about another agent. A model that knows its own ceiling plans
 * around the ceiling; a model that knows someone else's should not exist.
 */
/**
 * The exact shape a move must take, per game.
 *
 * ─────────────────────────── why this has to be spelled out ─────────────────
 *
 * The prompt used to send the spec, the state and the style, and trust the
 * system prompt's "a single JSON object describing ONE legal move" to convey the
 * format. It does not. A model given a negotiation position and no schema
 * answers with something reasonable and differently-shaped — `{"keepBps":6000}`,
 * or an `action` key instead of `kind` — which `MOVE_SCHEMAS` rejects whole,
 * because a partially-honoured move is worse than none.
 *
 * Measured on mainnet before this existed: every turn produced two
 * `not_a_move` violations (the call and its one retry) and then a fallback. The
 * agent played the deterministic line every single time while paying for
 * inference on both attempts — the exact failure the schema-violation gauge was
 * put there to surface.
 *
 * These strings MUST track `MOVE_SCHEMAS` in validate.ts. `runtime.test.ts`
 * asserts every game has one and that the examples parse, so drift fails a test
 * rather than quietly costing money.
 */
const MOVE_FORMATS: Record<string, string> = {
  deduction:
    'Reply with EXACTLY one of:\n' +
    '  {"kind":"probe","value":{"kind":"region","quadrant":"NW|NE|SW|SE"}}\n' +
    '  {"kind":"probe","value":{"kind":"exclusion","quadrant":"NW|NE|SW|SE"}}\n' +
    '  {"kind":"probe","value":{"kind":"rowBand","from":<int>,"to":<int>}}\n' +
    '  {"kind":"probe","value":{"kind":"colBand","from":<int>,"to":<int>}}\n' +
    '  {"kind":"probe","value":{"kind":"parity","parity":"even|odd"}}\n' +
    '  {"kind":"probe","value":{"kind":"distance","r":<int>,"c":<int>,"within":<int>}}\n' +
    '  {"kind":"commit","value":{"r":<int>,"c":<int>}}\n' +
    'No other keys. Probe to narrow the candidates; commit only when sure or out of budget.',
  search:
    'Reply with EXACTLY: {"kind":"probe","value":{"r":<int>,"c":<int>}}\n' +
    'No other keys.',
  negotiation:
    'Reply with EXACTLY: {"kind":"offer","value":{"keepBps":<int 0-10000>}}\n' +
    'No other keys. keepBps is the share you keep, in basis points — 6000 means you keep 60%.',
};

export function buildPrompt(ctx: TurnContext): string {
  const parts = [
    `Game: ${ctx.gameType}.`,
    `Rules and current position: ${JSON.stringify(ctx.spec)}.`,
    `Your progress so far: ${JSON.stringify(ctx.state)}.`,
    `Your style: ${JSON.stringify(promptView(ctx.config))}.`,
  ];

  // Last, and unconditional: the reply format is the one instruction that must
  // not be crowded out by however long the position happens to be.
  const format = MOVE_FORMATS[ctx.gameType];
  if (format) parts.push(format);

  if (ctx.inbox.length > 0) {
    // Rendered through the protocol's fixed templates, never as raw objects.
    parts.push('Messages from rivals:');
    for (const message of ctx.inbox) parts.push(`- ${render(message)}`);
  }

  return parts.join('\n');
}

// ─────────────────────────── the queue ───────────────────────────

interface Job {
  tenant: string;
  run: () => Promise<void>;
}

/** tenant → their waiting turns. A map of queues, not one queue. */
const queues = new Map<string, Job[]>();
let draining = false;

/**
 * Concurrent provider calls. Bounded so one burst cannot exhaust the quota.
 *
 * ─────────────────────────── why this is now configurable ───────────────────
 *
 * It was a hardcoded 4, sized when agents were a handful of demo accounts. At a
 * hundred seats it is the binding constraint ahead of both cost and the sweep:
 * every seat holding its {@link MAX_CONCURRENT} attempts, thirteen calls over a
 * ten-minute attempt, demands about 6.5 calls/sec — against 4.0 at one second
 * of provider latency, 2.0 at two, 0.8 at five.
 *
 * Saturation does not drop work: the queue below holds it. But an attempt
 * carries a deadline, and a turn that arrives after it is a LOST HUNT — which
 * for a paid seat is a refund, and for the player is indistinguishable from
 * their agent being bad.
 *
 * The right value is bounded by the provider's own per-account concurrency,
 * which is a fact about our DeepSeek plan rather than about this code. Hence an
 * env var: raise it against a measured limit, not a guessed one.
 */
export const MAX_IN_FLIGHT = env.AGENT_MAX_IN_FLIGHT;

function enqueue(tenant: string, run: () => Promise<void>): void {
  const queue = queues.get(tenant) ?? [];
  queue.push({ tenant, run });
  queues.set(tenant, queue);
  metrics.agentQueueDepth.set(depth());
}

function depth(): number {
  let total = 0;
  for (const queue of queues.values()) total += queue.length;
  return total;
}

/**
 * Take one job from each tenant in turn.
 *
 * The round-robin is the fairness property: an agent with ten queued turns gets
 * one per pass, exactly like an agent with one.
 */
function nextBatch(limit: number): Job[] {
  const batch: Job[] = [];
  for (const [tenant, queue] of queues) {
    if (batch.length >= limit) break;
    const job = queue.shift();
    if (job) batch.push(job);
    if (queue.length === 0) queues.delete(tenant);
  }
  return batch;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (depth() > 0) {
      const batch = nextBatch(MAX_IN_FLIGHT);
      if (batch.length === 0) break;
      await Promise.all(batch.map(job => job.run()));
      metrics.agentQueueDepth.set(depth());
    }
  } finally {
    draining = false;
    metrics.agentQueueDepth.set(depth());
  }
}

/**
 * Take one turn for one agent.
 *
 * Queued per tenant and scheduled round-robin, so a busy agent cannot crowd out
 * a quiet one. Never throws: a turn that cannot be taken falls back to a
 * deterministic move, because the alternative is an attempt that stalls until
 * its deadline.
 */
export function schedule(ctx: TurnContext): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>(resolve => {
    enqueue(ctx.agentId, async () => {
      try {
        resolve(await runTurn(ctx));
      } catch (err) {
        // Belt and braces. `runTurn` handles its own failures; if something
        // unforeseen escapes, an agent still has to move.
        logger.error({ err, agentId: ctx.agentId }, 'agent turn failed');
        resolve({
          move: fallbackFor(ctx),
          source: 'fallback',
          billedMills: 0,
          refused: 'error',
        });
      }
    });
    void drain();
  });
}

function fallbackFor(ctx: TurnContext): Move {
  return fallbackMove(ctx.gameType as AgentGame, ctx.spec, ctx.state);
}

async function runTurn(ctx: TurnContext): Promise<TurnOutcome> {
  if (!isAgentGame(ctx.gameType)) {
    // A human module on an agent zone would be a scoping bug upstream, and
    // there is no legal move to fall back to.
    throw new Error(`agents cannot play "${ctx.gameType}"`);
  }

  const agent = agentRepo.get(ctx.agentId);
  if (!agent || agent.status !== 'active') {
    return {
      move: fallbackFor(ctx),
      source: 'fallback',
      billedMills: 0,
      refused: 'agent_not_active',
    };
  }

  // **Before the call, never after.** A looping agent must be refused its next
  // call rather than billed for it and told afterwards.
  const allowed = budget.canInfer(
    ctx.agentId,
    ctx.config,
    { id: ctx.huntId, difficulty: ctx.difficulty },
    model(),
  );
  if (!allowed.ok) {
    metrics.agentBudgetRefusals.inc({ reason: allowed.reason ?? 'unknown' });
    // Out of budget is not out of the game: it plays on deterministically, for
    // free, which is a strictly better outcome for the player than forfeiting.
    return {
      move: fallbackFor(ctx),
      source: 'fallback',
      billedMills: 0,
      refused: allowed.reason,
    };
  }

  // A funded seat is what makes the HOUSE willing to pay a provider for this
  // turn. It gates nothing else — not the hunt, not the entry, not the prize.
  //
  // An unseated agent lands here and plays `fallbackMove`, which is a competent
  // line rather than a placeholder, against the same opponents for the same
  // money. That is the free path AGENT_TIER.md §3 requires, and it is the whole
  // reason a seat can be sold at all: a fee for something a player NEEDS in
  // order to compete for a cash prize is an entry fee with extra steps.
  const perCall = budget.callCostMills(model());
  if (!seats.hasCredit(ctx.agentId, perCall)) {
    metrics.agentBudgetRefusals.inc({ reason: 'no_seat' });
    return {
      move: fallbackFor(ctx),
      source: 'fallback',
      billedMills: 0,
      refused: 'no_seat',
    };
  }

  const result = await takeTurn({
    game: ctx.gameType,
    spec: ctx.spec,
    state: ctx.state,
    system: SYSTEM_PROMPT,
    user: buildPrompt(ctx),
    maxTokens: MAX_TOKENS,
  });

  // Bill what actually happened, including the retry. The budget authorised one
  // call; a retry that took a second is still the house's money.
  // Billed on the ESTIMATE, deliberately. The budget was checked before the
  // call against the same number, so billing on measured tokens afterwards
  // could charge more than was authorised — which is the failure the
  // check-before-call ordering exists to prevent.
  //
  // Measured usage is recorded separately, for reconciliation. If the two
  // diverge, the estimate is what should be re-derived.
  const billedMills = result.calls * budget.callCostMills(model());
  if (result.usage) {
    metrics.inferenceTokens.inc({ direction: 'prompt', model: model() }, result.usage.promptTokens);
    metrics.inferenceTokens.inc(
      { direction: 'completion', model: model() },
      result.usage.completionTokens,
    );
  }
  if (billedMills > 0) {
    budget.record(ctx.agentId, 'inference', billedMills, { huntId: ctx.huntId });
    metrics.agentInferenceMills.inc(billedMills);
    // Draw down the seat for what the house actually spent, including a retry.
    // Not conditional on success: a retried call cost real money whether or not
    // it produced a usable move, and charging only for good answers would mean
    // the house eats every schema violation.
    //
    // The check above authorised `perCall`; a retry can exceed it by one call,
    // so this may fail on the last turn of a nearly-empty seat. That is fine —
    // it is recorded, and the next turn falls back rather than overdrawing.
    if (!seats.consume(ctx.agentId, billedMills)) {
      logger.warn({ agentId: ctx.agentId, billedMills }, 'seat credit exhausted mid-turn');
    }
  }

  return { move: result.move, source: result.source, billedMills };
}

/** Test-only: drops every queued turn. */
export function reset(): void {
  queues.clear();
  draining = false;
  metrics.agentQueueDepth.set(0);
}
