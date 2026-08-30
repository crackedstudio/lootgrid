import { DEDUCTION, GRID, RACE } from '../config';
import { hashInt } from '../hash';
import { cellMatches, parsePayload, type HintPayload } from '../hints/types';
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

export interface DeductionSpec {
  rows: number;
  cols: number;
  /** Questions allowed. The whole difficulty of the game. */
  budget: number;
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

export const deductionModule: GameModule<
  DeductionSpec,
  DeductionSecret,
  DeductionState,
  DeductionInput
> = {
  type: 'deduction',
  // Minutes long, so it has to survive a deploy. See referee.ts.
  durable: true,

  generate(seed, difficulty: Difficulty) {
    // Fixed by the block's salt, like everything else about a hunt: the same
    // block poses the same problem to everyone, and it is checkable once the
    // salt is revealed.
    const r = hashInt(seed, 'deduction:r') % GRID.rows;
    const c = hashInt(seed, 'deduction:c') % GRID.cols;
    const budget = DEDUCTION.budget[difficulty] ?? DEDUCTION.budget.med;

    return {
      spec: { rows: GRID.rows, cols: GRID.cols, budget, limitMs: DEDUCTION.limitMs },
      secret: { r, c },
      limitMs: DEDUCTION.limitMs,
    };
  },

  publicSpec(spec) {
    // Everything except the cell. The spec IS the rules; the secret is the game.
    return { rows: spec.rows, cols: spec.cols, budget: spec.budget, limitMs: spec.limitMs };
  },

  init() {
    return { used: 0, answers: [], solved: false, nextCost: 1 };
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

      const answer = cellMatches(payload, secret.r, secret.c);
      // Charged at the price it was quoted, never at whatever the Director is
      // saying now — the same rule `math` follows about the rung a question was
      // served at. A probe already in flight cannot be repriced under it.
      state.used += state.nextCost ?? 1;
      state.answers.push({ payload, answer });

      // What the NEXT probe will cost, chosen now and published below so it is
      // never a surprise. A dear round is a real decision — spend two of a
      // twelve budget on this question, or wait for a cheaper one — and it is
      // only a decision if the price is known before the probe is sent.
      const nextCost = costFor(directive);
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
