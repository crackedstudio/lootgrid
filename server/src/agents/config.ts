import { z } from 'zod';
import { MAX_PRIZE_CENTS } from '../prizes';

/**
 * What a player tells their agent to do.
 *
 * ─────────────────────────── every field is a number ────────────────────────
 *
 * There is no free-text field here and there must never be one, for the same
 * reason `hints/types.ts` has none: this configuration is read into a prompt.
 * A `strategyNotes: string` would be the most natural feature request in this
 * file and it would be a hole straight through the security model — anything a
 * player can type, a prompt-injected rival can persuade a model to type back,
 * and the model reading it can spend money.
 *
 * So the knobs are bounded integers and closed sets. `aggression` is the only
 * genuinely subjective one, and it is a number precisely so that it cannot
 * become an instruction.
 *
 * ─────────────────────────── these are not the caps ─────────────────────────
 *
 * The vault enforces spending on chain and does not consult any of this. What
 * these are for is refusing early and cheaply: an agent about to attempt a
 * trade its owner's `maxHintPriceCents` forbids should never get as far as a
 * transaction that would revert. If the two ever disagree, the contract wins —
 * it is the one holding the money.
 */

export type AgentStatus = 'active' | 'paused' | 'killed';

/**
 * Bounds chosen so that a misconfigured agent is a bad agent rather than an
 * expensive one. Every ceiling is deliberately below what the vault would allow.
 */
export const LIMITS = {
  aggression: { min: 0, max: 100 },
  /** No hint is worth more than the largest prize; usually far less. */
  maxHintPriceCents: { min: 1, max: MAX_PRIZE_CENTS },
  dailyBudgetCents: { min: 1, max: 10 * MAX_PRIZE_CENTS },
  /**
   * Inference per hunt, in mills.
   *
   * The default is generous against measured pricing and still tiny: a whole
   * hunt of agent play costs about 270 mills at DeepSeek v4-flash rates. See
   * `budget.ts` for the arithmetic this number comes from.
   */
  inferenceMillsPerHunt: { min: 0, max: 20_000 },
} as const;

export const DEFAULTS = {
  aggression: 40,
  maxHintPriceCents: 25,
  dailyBudgetCents: 100,
  inferenceMillsPerHunt: 1_000,
  zones: [] as string[],
  minReliabilityBps: 5_000,
} as const;

/**
 * The parser everything untrusted goes through.
 *
 * Strict rather than lenient: an unknown key is a rejection, not a shrug. A
 * config that silently dropped a field a player thought they had set would be a
 * player who thinks they have a spending limit and does not.
 */
export const configSchema = z
  .object({
    aggression: z.number().int().min(LIMITS.aggression.min).max(LIMITS.aggression.max),
    maxHintPriceCents: z
      .number()
      .int()
      .min(LIMITS.maxHintPriceCents.min)
      .max(LIMITS.maxHintPriceCents.max),
    dailyBudgetCents: z
      .number()
      .int()
      .min(LIMITS.dailyBudgetCents.min)
      .max(LIMITS.dailyBudgetCents.max),
    inferenceMillsPerHunt: z
      .number()
      .int()
      .min(LIMITS.inferenceMillsPerHunt.min)
      .max(LIMITS.inferenceMillsPerHunt.max),
    /** Zone ids it may enter. Ids, not descriptions — a closed set by nature. */
    zones: z.array(z.string().min(1).max(64)).max(32),
    minReliabilityBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export type AgentConfig = z.infer<typeof configSchema>;

/**
 * Parse a partial update over the current config.
 *
 * Returns the merged result or a list of problems. Never throws and never
 * half-applies: a config that took three of four fields would leave the agent
 * in a state its owner never chose.
 */
export function parseUpdate(
  current: AgentConfig,
  patch: unknown,
): { ok: true; config: AgentConfig } | { ok: false; problems: string[] } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, problems: ['config must be an object'] };
  }

  const merged = { ...current, ...(patch as Record<string, unknown>) };
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map(i => `${i.path.join('.') || 'config'}: ${i.message}`),
    };
  }
  return { ok: true, config: result.data };
}

export const defaultConfig = (): AgentConfig => ({ ...DEFAULTS, zones: [...DEFAULTS.zones] });

/**
 * The subset an agent's prompt is allowed to contain.
 *
 * Not the whole config: `dailyBudgetCents` and the vault's limits are the
 * house's business and the chain's, not the model's. Telling a model its own
 * daily ceiling invites it to plan around the ceiling, and telling it another
 * tenant's would be the cross-tenant leak this phase's gate is about.
 */
export function promptView(config: AgentConfig): { aggression: number; minReliabilityBps: number } {
  return { aggression: config.aggression, minReliabilityBps: config.minReliabilityBps };
}
