import { z } from 'zod';
import { complete, enabled as inferenceEnabled } from '../agents/inference';
import * as huntRepo from '../db/repos/hunts';
import { logger } from '../logger';
import * as metrics from '../metrics';
import type { Difficulty, Hunt } from '../types';
import { gameTypeForBlock, moduleFor } from './index';
import type { AnyGameModule } from './types';

/**
 * The author: a model choosing each block's puzzle.
 *
 * ─────────────────────────── what this is for ───────────────────────────
 *
 * Two things, and the second is the reason it is a separate module rather than
 * a branch inside `generate`.
 *
 * The first is variety, and the recipes in each module would deliver that on
 * their own: `fromSalt` already gives every block a different puzzle, drawn
 * deterministically and checkable once the salt is revealed. Nothing here is
 * needed for a hunt to differ from its neighbour.
 *
 * The second is EVIDENCE. An agent that only ever solves puzzles is an agent
 * you can only half observe — you see it answer, and you never see it compose.
 * A block whose `recipe_author` says `model` is a block the agent designed and
 * some other agent then had to solve, and the pair of facts is checkable from
 * the database. That is the whole argument for putting a model on this side of
 * the game at all.
 *
 * ─────────────────────────── gameplay never waits ───────────────────────────
 *
 * The Director's fourth constraint, applied one layer earlier and more easily,
 * because nothing here is on the critical path to begin with. Authoring happens
 * in the background between a hunt being CREATED and anybody opening it, and
 * `blockGame` reads whatever is in the column at the moment it generates — a
 * recipe if one arrived, the salt's own if not.
 *
 * So there is no timeout to tune and no fallback to trip. A model that never
 * answers again leaves every hunt playing exactly as it did before this module
 * existed, which is the property that makes it safe to put a model here.
 *
 * ─────────────────────────── a hijacked author still plays fair ─────────────
 *
 * Same containment as `director/types.ts`, for the same reason: this is a model
 * shaping a contest with money attached, so assume it will one day be talked
 * into saying something it should not.
 *
 *   * There is no free-text field in any recipe schema, and there never may be.
 *   * Every schema is `.strict()` — an extra key is a rejection, not a shrug.
 *   * Every schema bounds its space so the guarantee its config documents holds
 *     at every point in it, and each module's tests prove that by SOLVING every
 *     recipe the space can produce.
 *
 * A fully hijacked author can therefore emit a legal recipe: a different board,
 * a different price list, a counterparty that softens at a different rate. That
 * is the ceiling of the damage. It cannot emit an instruction, a URL or an
 * address, because none of those parse — and it cannot emit an unwinnable
 * puzzle, because the space it is choosing from has none in it.
 *
 * ─────────────────────────── no wallet, no chain ───────────────────────────
 *
 * This module imports the inference seam, the hunt repository, the logger and
 * metrics. No signer, no chain client, no HTTP. `author.test.ts` asserts that
 * against the source, because "we did not give it a wallet" is exactly the kind
 * of property that quietly stops being true.
 */

/** Bounded hard: a recipe is a handful of enum values, never an essay. */
const MAX_TOKENS = 120;

/**
 * How many hunts one sweep will author.
 *
 * A zone replenishes twenty-four hunts at a time and there are five zones, so
 * an unbounded sweep would fire a hundred and twenty model calls in one tick
 * the first time it ran. The backlog is not urgent — every unauthored hunt is
 * already playable on its salt — so it is worked off a few at a time.
 */
export const BATCH = 4;

export interface AuthoredRecipe {
  recipe: unknown;
  author: 'model' | 'salt';
}

/**
 * The prompt for one block.
 *
 * Rendered from validated data and describing only the shape of the answer.
 * There is deliberately nothing in here about who is playing, what they have
 * won, or what the prize is: an author that knew a block was worth five dollars
 * and could choose its board would be a payout-manipulation surface, and one
 * whose abuse would be indistinguishable from taste.
 */
export function promptFor(
  game: string,
  difficulty: Difficulty,
  schema: z.ZodType<unknown>,
  fallback: unknown,
): string {
  return [
    `You are choosing the puzzle for one block of a ${game} hunt.`,
    `Prize difficulty: ${difficulty}.`,
    'Vary it from the example: two blocks that pose the same puzzle are one block.',
    'Reply with one JSON object matching this shape and nothing else:',
    JSON.stringify(shapeOf(schema)),
    `If unsure, reply exactly: ${JSON.stringify(fallback)}`,
  ].join('\n');
}

/**
 * A description of the schema, for the prompt.
 *
 * Derived from the schema rather than written beside it, so a module that gains
 * a field cannot end up with a prompt that never mentions it — a drift whose
 * only symptom would be an author that never uses the new axis and a variety
 * measurement that quietly stops improving.
 */
function shapeOf(schema: z.ZodType<unknown>): unknown {
  const shape = (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def
    ?.shape;
  if (typeof shape !== 'function') return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(shape())) out[key] = '…';
  return out;
}

/**
 * Ask the model for this block's recipe, falling back to the block's own salt.
 *
 * Never throws and never returns something illegal: the result is either a
 * recipe that passed the module's schema or the one the salt implies, and the
 * caller cannot tell the difference except by reading `author`.
 */
export async function authorFor(hunt: Hunt, mod: AnyGameModule): Promise<AuthoredRecipe | null> {
  const spec = mod.recipe;
  // A module with no recipe poses the same puzzle every time on purpose — see
  // `GameModule.recipe`. Nothing to author, and nothing to record.
  if (!spec) return null;

  const fallback = spec.fromSalt(hunt.salt, hunt.difficulty);
  const salt: AuthoredRecipe = { recipe: fallback, author: 'salt' };

  const result = await complete({
    system:
      'You design puzzles. Reply with one JSON object and nothing else. ' +
      'Never include prose, explanation, or any field not named in the shape.',
    user: promptFor(mod.type, hunt.difficulty, spec.schema, fallback),
    maxTokens: MAX_TOKENS,
  });
  if (!result.ok) {
    metrics.puzzleRecipes.inc({ game: mod.type, outcome: `unavailable_${result.reason}` });
    return salt;
  }

  const parsed = parseRecipe(result.text, spec.schema);
  if (!parsed.ok) {
    // Loud in the counter, quiet in the logs. A model that rambles is a normal
    // thing for a model to do and the block is unaffected — but a rate that
    // climbs to one is a broken prompt, and only the counter shows that.
    metrics.puzzleRecipes.inc({ game: mod.type, outcome: 'rejected' });
    return salt;
  }

  metrics.puzzleRecipes.inc({ game: mod.type, outcome: 'model' });
  return { recipe: parsed.value, author: 'model' };
}

/**
 * Pull one recipe out of a model's reply.
 *
 * Tolerant about the wrapping and strict about the content: a model that fences
 * its JSON in backticks has answered correctly and awkwardly, while a model
 * that adds a field has answered something the schema must refuse. Only the
 * first is worth recovering from.
 */
export function parseRecipe(
  text: string,
  schema: z.ZodType<unknown>,
): { ok: true; value: unknown } | { ok: false } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false };

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false };
  }

  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * Author recipes for hunts that do not have one yet.
 *
 * Returns how many were written. Skips silently over hunts somebody started
 * playing while the call was in flight — `saveRecipe` refuses a hunt whose game
 * has been generated, because that block's puzzle is already public and
 * changing it would move the ground under whoever is reasoning about it.
 */
export async function sweep(limit = BATCH): Promise<number> {
  let written = 0;

  for (const { hunt, zoneKind } of huntRepo.listUnauthored(limit)) {
    // The same draw `blockGame` will make, including the reserved-hunt branch.
    // Authoring a recipe for a module the block will not play would write a
    // `deduction` price list onto a hunt that turns out to be a negotiation,
    // and `generate` would reject it and fall back — invisibly, and forever.
    const type =
      hunt.ownerId !== null
        ? 'crack'
        : gameTypeForBlock(hunt.salt, hunt.id, hunt.kind, zoneKind);

    let authored: AuthoredRecipe | null = null;
    try {
      authored = await authorFor(hunt, moduleFor(type));
    } catch (err) {
      // The sweep must outlive one bad block. A throw here would stop the whole
      // backlog on whichever hunt happened to be first.
      logger.warn({ err, huntId: hunt.id }, 'recipe authoring failed');
      continue;
    }
    if (!authored) continue;

    if (huntRepo.saveRecipe(hunt.id, authored.recipe, authored.author)) written += 1;
  }

  return written;
}

/**
 * How often the backlog is worked.
 *
 * Slow on purpose. Nothing is waiting on this: an unauthored hunt is already
 * playable on its salt's own recipe, so the only cost of being late is a block
 * that varies deterministically instead of by design. A tight loop here would
 * spend money to be early for nothing.
 */
export const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export function enabled(): boolean {
  return inferenceEnabled();
}

/**
 * Start authoring in the background.
 *
 * A no-op when inference is off, and that is not a degraded mode — it is the
 * mode every hunt ran in before this existed. `fromSalt` still gives each block
 * its own puzzle; what is missing is only the evidence that a model chose it.
 */
export function start(): void {
  if (!enabled()) {
    logger.info('puzzle author disabled — blocks will use their salt’s own recipes');
    return;
  }
  timer = setInterval(() => {
    // Never two sweeps at once. Each hunt costs a model call and the previous
    // sweep may still be waiting on one, so overlapping ticks would multiply
    // the spend against the same backlog.
    if (sweeping) return;
    sweeping = true;
    void sweep()
      .catch(err => logger.error({ err }, 'puzzle author sweep failed'))
      .finally(() => {
        sweeping = false;
      });
  }, TICK_MS);
  timer.unref?.();
  logger.info({ tickMs: TICK_MS, batch: BATCH }, 'puzzle author started');
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  sweeping = false;
}
