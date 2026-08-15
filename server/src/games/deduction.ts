import { DEDUCTION, GRID, RACE } from '../config';
import { hashInt } from '../hash';
import { cellMatches, parsePayload, type HintPayload } from '../hints/types';
import type { Difficulty } from '../types';
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
    return { used: 0, answers: [], solved: false };
  },

  step({ spec, secret, state, timing }, input): StepResult {
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
      state.used += 1;
      state.answers.push({ payload, answer });

      // The remaining candidate count is deliberately NOT sent back. Intersecting
      // your own constraints is the game; handing over the count would leave
      // only the arithmetic.
      return {
        kind: 'progress',
        emit: { answer, used: state.used, budgetLeft: spec.budget - state.used },
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
