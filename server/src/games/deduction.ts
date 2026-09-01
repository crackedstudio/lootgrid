import { z } from 'zod';
import { DEDUCTION, GRID, RACE } from '../config';
import { hashInt } from '../hash';
import { cellMatches, parsePayload, type HintKind, type HintPayload } from '../hints/types';
import type { Difficulty } from '../types';
import type { Directive } from '../director/types';
import type { GameModule, StepResult } from './types';

/**
 * Deduction: find the cell by asking the fewest questions.
 *
 * ─────────────────────────── what makes it agent-native ─────────────────────
 *
 * Nothing here rewards speed, and nothing here can be brute-forced. The server
 * holds a hidden cell; you may ask a bounded number of yes/no questions about
 * it, then commit to one cell, once. On `hard` the budget is exactly
 * ⌈log₂ 216⌉ = 8 — the information-theoretic floor for an 18×12 grid — so any
 * question that fails to halve the remaining space is a question you cannot
 * afford. That is a reasoning task with a right answer, which is precisely what
 * the human modules are not: they test reflexes and arithmetic, which an agent
 * performs perfectly and is then rejected for.
 *
 * ─────────────────────────── the probe language is the hint language ────────
 *
 * Questions are `HintPayload`s — the same closed, schema-validated vocabulary
 * hints are issued in, run through the same `parsePayload` and answered by the
 * same `cellMatches`. Three things follow, and all three are the reason:
 *
 *   1. An agent that bought a hint in the market already speaks the language it
 *      probes in, so a purchased constraint and a self-derived one compose.
 *   2. The security boundary from phase 1 is inherited rather than rebuilt.
 *      There is no free-text field here for the same reason there is none
 *      there — in phase 7 this input arrives from a model that can spend money.
 *   3. A hint is literally a probe someone else paid for. That is the whole
 *      economic argument for the market, made mechanical.
 *
 * ─────────────────────────── one commit ───────────────────────────
 *
 * A commit you can retry is brute force with extra steps: 216 guesses beats any
 * amount of thinking. So a wrong commit ends the attempt, and the budget bounds
 * how much you may learn before spending it.
 */

/**
 * The two probe kinds every block allows, and the reason the game is always
 * winnable.
 *
 * `rowBand` and `colBand` take arbitrary `from`/`to` (see `parsePayload`), so
 * the pair is a binary search on each axis: ⌈log₂ 60⌉ + ⌈log₂ 60⌉ = 12 probes
 * to isolate one of 3,600 cells, which is exactly `DEDUCTION.budget.hard`.
 * Neither may ever be priced above one by a recipe, and neither may ever be
 * withheld — together those two rules are what make every recipe in the space
 * solvable rather than merely plausible. `deduction.test.ts` proves it by
 * running the search on every recipe the schema can produce.
 */
export const CORE_KINDS = ['rowBand', 'colBand'] as const;

/**
 * The probe kinds a block MAY offer on top of the core two.
 *
 * These are shortcuts rather than necessities. `parity` halves the board in one
 * question but never narrows further; `region` and `exclusion` buy two bits at
 * a corner; `distance` is the only one that reasons about both axes at once.
 * Which of them a block lends you, and what it charges, is the puzzle — an
 * agent that always binary-searches is leaving budget on the table, and one
 * that reaches for a tool this block priced at two is wasting it.
 */
export const EXTRA_KINDS = ['region', 'exclusion', 'parity', 'distance'] as const;

export type DeductionExtra = (typeof EXTRA_KINDS)[number];

/**
 * What one block lends you, and what it charges.
 *
 * This is the whole variety of the game and it used to be nothing: `generate`
 * returned `{rows, cols, budget, limitMs}`, every field a function of
 * difficulty alone, so all 500 salts in a measurement produced ONE distinct
 * spec. The hidden cell moved and nothing else did.
 */
export interface DeductionRecipe {
  /** Probe kinds offered beyond {@link CORE_KINDS}. Unique, may be empty. */
  extras: DeductionExtra[];
  /** Which of `extras` cost two of the budget instead of one. A subset. */
  dear: DeductionExtra[];
}

const extraEnum = z.enum(EXTRA_KINDS);
const unique = <T>(a: T[]): boolean => new Set(a).size === a.length;

export const deductionRecipeSchema = z
  .object({
    extras: z.array(extraEnum).max(EXTRA_KINDS.length),
    dear: z.array(extraEnum).max(EXTRA_KINDS.length),
  })
  .strict()
  // Not decoration. `dear` naming a kind the block never lent you is a price
  // list for a tool that does not exist, and a duplicated extra would be a
  // spec that advertises the same probe twice.
  .refine(r => unique(r.extras) && unique(r.dear), { message: 'duplicate kinds' })
  .refine(r => r.dear.every(k => r.extras.includes(k)), {
    message: 'dear names a kind that is not on offer',
  });

export interface DeductionSpec {
  rows: number;
  cols: number;
  /** Questions allowed. The whole difficulty of the game. */
  budget: number;
  /**
   * The probe kinds this block answers. Always contains {@link CORE_KINDS}.
   *
   * Published rather than implied: an agent cannot choose well between a cheap
   * band and a dear ring unless it is told which it has and what each costs,
   * and a rule the player has to discover by being rejected is not a rule, it
   * is a trap.
   */
  allowed: HintKind[];
  /** The subset of `allowed` that costs two. Never contains a core kind. */
  dear: HintKind[];
  limitMs: number;
}

export interface DeductionSecret {
  r: number;
  c: number;
}

/** Answered probes, in order. Serialisable — long attempts outlive a restart. */
export interface DeductionState {
  used: number;
  answers: Array<{ payload: HintPayload; answer: boolean }>;
  solved: boolean;
  /**
   * What the next probe will cost against the budget, set when the previous one
   * was answered.
   *
   * Recorded rather than recomputed, for the reason `math.state.rungs` is: a
   * probe is charged the price it was QUOTED, not whatever the Director happens
   * to be saying by the time it arrives. Undefined on states written before the
   * Director reached this module, which reads as the ordinary cost of one.
   */
  nextCost?: number;
  /**
   * The full price list the previous round published, kind → cost.
   *
   * Alongside `nextCost` rather than replacing it, because this module is
   * `durable`: an attempt that spans a deploy resumes from a state written by
   * the old build, and one written before per-kind pricing existed has only the
   * single number. Reading the list first and falling back to the number is
   * what lets those attempts finish at the price they were actually quoted.
   */
  nextPrices?: Record<string, number>;
}

export interface DeductionInput {
  kind: string;
  value?: unknown;
}

/**
 * Cells still consistent with every answer given so far.
 *
 * Exported because it is the game: an agent has to compute exactly this to play
 * well, the progress bar is derived from it, and a test that cannot measure
 * narrowing cannot tell deduction from guessing.
 */
export function candidates(
  answers: DeductionState['answers'],
  rows: number = GRID.rows,
  cols: number = GRID.cols,
): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (answers.every(a => cellMatches(a.payload, r, c) === a.answer)) out.push({ r, c });
    }
  }
  return out;
}

/**
 * What the next probe costs, given the round the Director chose.
 *
 * ─────────────────────────── the one safe lever here ───────────────────────
 *
 * Deduction is a soundness game: the answers must stay true, or the constraints
 * a player intersects stop describing the board and `candidates()` — which the
 * agent fallback reasons with — computes a set the treasure is not in. So the
 * tempting twists are the forbidden ones. A `fog` that made an answer sometimes
 * wrong would not make the hunt harder; it would make it unwinnable in a way
 * nobody could detect from inside.
 *
 * Price is the lever that leaves truth alone. Every answer is still exactly as
 * true as it was; a dear round simply costs two of the budget instead of one,
 * and the player is told before they spend it.
 *
 * The hard floor is one, and the ceiling two: no directive may make a probe
 * free, and none may price one so high that a budget of twelve ends on a
 * decision the player never got to make.
 */
function costFor(directive: Directive | null): number {
  if (!directive) return 1;
  const dear = directive.difficulty >= 4 || directive.roundType === 'sprint';
  return dear ? 2 : 1;
}

/**
 * The full price list for the next probe, one entry per kind on offer.
 *
 * ─────────────────────────── why a list and not a number ────────────────────
 *
 * `nextCost` was a single number because every probe cost the same. Now a block
 * can lend you a ring at two and a band at one, and the module's own rule is
 * that a price is published before it is paid — "a dear round is a real
 * decision, and it is only a decision if the price is known before the probe is
 * sent". One number cannot state a price that depends on which kind you pick,
 * so the whole list goes out each round.
 *
 * The two components combine by MAX rather than by sum, which keeps the
 * documented ceiling of two intact. A recipe's dear kind under a dear directive
 * still costs two, not three — otherwise the two levers would multiply and a
 * budget of twelve would buy four questions.
 */
function pricesFor(spec: DeductionSpec, directive: Directive | null): Record<string, number> {
  const base = costFor(directive);
  const out: Record<string, number> = {};
  for (const kind of spec.allowed) {
    out[kind] = Math.max(base, spec.dear.includes(kind) ? 2 : 1);
  }
  return out;
}

/**
 * The block's own recipe, drawn from its salt.
 *
 * ─────────────────────────── how the space is shaped ────────────────────────
 *
 * Between one and all four extras, so a block is never merely the core two —
 * that would be the old single spec wearing a recipe — and never so richly
 * equipped that the choice stops mattering. Each extra is then independently
 * cheap or dear, which is what makes two blocks offering the same tools still
 * pose different questions: `distance` at one is a first move, `distance` at
 * two is a last resort.
 *
 * Every draw is a separate hash tag. Reusing one would correlate the choices —
 * blocks that lend you `parity` would be exactly the blocks that price it dear
 * — and a space with a hidden correlation is smaller than it looks.
 */
export function deductionRecipeFromSalt(salt: string, difficulty: Difficulty): DeductionRecipe {
  // At least one, so every block differs from the bare core.
  const count = 1 + (hashInt(salt, 'deduction:extras:n') % EXTRA_KINDS.length);

  // Fisher–Yates over a copy, driven by the salt. Picking by "index % 4" four
  // times would collide and yield fewer extras than `count` promises.
  const pool = [...EXTRA_KINDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = hashInt(salt, `deduction:extras:shuffle:${i}`) % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const extras = pool.slice(0, count);

  // Harder blocks price their shortcuts dear more often. This is the one place
  // difficulty touches the recipe, and it moves a price rather than the budget:
  // the budget is the information-theoretic guarantee and must not be jittered.
  const dearInN = difficulty === 'hard' ? 2 : difficulty === 'med' ? 3 : 4;
  const dear = extras.filter(
    k => hashInt(salt, `deduction:dear:${k}`) % dearInN === 0,
  );

  return { extras, dear };
}

export const deductionModule: GameModule<
  DeductionSpec,
  DeductionSecret,
  DeductionState,
  DeductionInput
> = {
  type: 'deduction',
  // Minutes long, so it has to survive a deploy. See referee.ts.
  durable: true,

  recipe: { schema: deductionRecipeSchema, fromSalt: deductionRecipeFromSalt },

  generate(seed, difficulty: Difficulty, ctx) {
    // Fixed by the block's salt, like everything else about a hunt: the same
    // block poses the same problem to everyone, and it is checkable once the
    // salt is revealed.
    const r = hashInt(seed, 'deduction:r') % GRID.rows;
    const c = hashInt(seed, 'deduction:c') % GRID.cols;
    // NOT jittered by the recipe. `DEDUCTION.budget` is derived from
    // ⌈log₂ cells⌉ and `hard` is exactly the information-theoretic floor, so a
    // recipe that moved it by one would make the block unwinnable and nothing
    // inside the game could tell. The recipe varies which questions you may ask
    // and what they cost; how many you get is the config's to decide.
    const budget = DEDUCTION.budget[difficulty] ?? DEDUCTION.budget.med;

    // An unparseable or absent recipe is the ordinary case, not a failure: it
    // is what every hunt gets before an author has spoken, and what every hunt
    // gets while inference is down.
    const parsed = deductionRecipeSchema.safeParse(ctx?.recipe);
    const recipe = parsed.success ? parsed.data : deductionRecipeFromSalt(seed, difficulty);

    return {
      spec: {
        rows: GRID.rows,
        cols: GRID.cols,
        budget,
        allowed: [...CORE_KINDS, ...recipe.extras],
        // Core kinds are absent by construction rather than by filtering: the
        // schema has no way to name one, so the binary-search line is priced at
        // one on every block in the space.
        dear: [...recipe.dear],
        limitMs: DEDUCTION.limitMs,
      },
      secret: { r, c },
      limitMs: DEDUCTION.limitMs,
    };
  },

  publicSpec(spec) {
    // Everything except the cell. The spec IS the rules; the secret is the game.
    // `allowed` and `dear` are rules, and withholding them would leave the
    // player to discover the block's price list by being rejected by it.
    return {
      rows: spec.rows,
      cols: spec.cols,
      budget: spec.budget,
      allowed: spec.allowed,
      dear: spec.dear,
      limitMs: spec.limitMs,
    };
  },

  init(spec) {
    // The first probe is quoted here rather than in `step`, because there is no
    // previous round to have published it. Undirected prices: round 0 goes out
    // in `publicSpec` before anyone has made progress, so no directive exists
    // for it — which is exactly what `directedRound`'s contract already says.
    const prices = pricesFor(spec, null);
    return {
      used: 0,
      answers: [],
      solved: false,
      nextCost: Math.min(...Object.values(prices)),
      nextPrices: prices,
    };
  },

  /**
   * The probe index the next answer will serve, or null on the last one.
   *
   * Rounds here are probes. A directive is asked for only while there is a probe
   * left to shape — a directive for a round nobody plays would sit in the
   * transcript as a decision never taken.
   */
  directedRound(state, spec) {
    const next = state.used + 1;
    return next < spec.budget ? next : null;
  },

  step({ spec, secret, state, timing, directive }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }

    if (input.kind === 'probe') {
      if (state.used >= spec.budget) {
        return { kind: 'reject', reason: 'budget_exhausted', fatal: true };
      }
      // Untrusted input crossing a trust boundary, exactly as a stored hint is.
      // A malformed probe is dropped whole rather than half-honoured.
      const payload = parsePayload(input.value);
      if (!payload) return { kind: 'reject', reason: 'bad_probe', fatal: true };

      // The block only answers the kinds it published. Without this the
      // `allowed` list would be advice rather than a rule, every block would
      // answer all six kinds, and the recipe would vary the description of the
      // puzzle without varying the puzzle.
      //
      // `allowed` is absent on a spec generated before recipes existed and
      // persisted through the change. Absent means "all six", which is exactly
      // how that block played when it was created.
      if (spec.allowed && !spec.allowed.includes(payload.kind)) {
        return { kind: 'reject', reason: 'kind_not_allowed', fatal: true };
      }

      const answer = cellMatches(payload, secret.r, secret.c);
      // Charged at the price it was quoted, never at whatever the Director is
      // saying now — the same rule `math` follows about the rung a question was
      // served at. A probe already in flight cannot be repriced under it.
      state.used += state.nextPrices?.[payload.kind] ?? state.nextCost ?? 1;
      state.answers.push({ payload, answer });

      // What the NEXT probe will cost, chosen now and published below so it is
      // never a surprise. A dear round is a real decision — spend two of a
      // twelve budget on this question, or wait for a cheaper one — and it is
      // only a decision if the price is known before the probe is sent.
      const prices = pricesFor(spec, directive);
      // The cheapest thing on the block. Kept for the client and for every
      // attempt that predates the price list, and honest either way: it is what
      // the next probe costs if you pick well.
      const nextCost = Math.min(...Object.values(prices));
      state.nextPrices = prices;
      state.nextCost = nextCost;

      const budgetLeft = Math.max(0, spec.budget - state.used);

      // The remaining candidate count is deliberately NOT sent back. Intersecting
      // your own constraints is the game; handing over the count would leave
      // only the arithmetic.
      return {
        kind: 'progress',
        emit: {
          answer,
          used: state.used,
          budgetLeft,
          // Published, always. The player is told the price before they pay it.
          nextCost,
          prices,
        },
      };
    }

    if (input.kind === 'commit') {
      const cell = parseCell(input.value, spec);
      if (!cell) return { kind: 'reject', reason: 'bad_commit', fatal: true };

      if (cell.r !== secret.r || cell.c !== secret.c) {
        // One shot. A retryable commit is brute force with extra steps.
        return { kind: 'reject', reason: 'wrong_cell', fatal: true };
      }

      state.solved = true;
      return { kind: 'complete' };
    }

    return { kind: 'reject', reason: 'bad_input', fatal: true };
  },

  /**
   * How much of the grid the player has ruled out, 0–100.
   *
   * Not budget spent — that would show an agent burning questions badly as
   * "progress". This is the only honest measure of how close someone is, and it
   * is what makes a rival bar mean something on a zone where nobody is racing a
   * clock.
   */
  progress(state, spec) {
    if (state.solved) return 100;
    const total = spec.rows * spec.cols;
    const left = candidates(state.answers, spec.rows, spec.cols).length;
    if (left <= 1) return 99; // Narrowed to one cell, but not yet committed.
    return Math.min(99, Math.round(((total - left) / total) * 100));
  },
};

function parseCell(raw: unknown, spec: DeductionSpec): { r: number; c: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { r, c } = raw as { r?: unknown; c?: unknown };
  const inRange = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;
  return inRange(r, spec.rows) && inRange(c, spec.cols) ? { r, c } : null;
}
