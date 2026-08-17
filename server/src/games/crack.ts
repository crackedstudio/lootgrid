import { CRACK, GRID, RACE } from '../config';
import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

/**
 * The Crack: six doors, one right, fifteen seconds.
 *
 * ─────────────────────────── the answer is the treasure ─────────────────────
 *
 * Note what this module does NOT do: invent its own hidden cell. `deduction`
 * and `search` both derive a target from the seed that has nothing to do with
 * where the treasure actually is, because for them the block is a puzzle that
 * happens to sit on a tile.
 *
 * Here the answer *is* the hunt's cell, and that is load-bearing. Hints
 * describe the treasure's real position, so if the door you are picking were
 * some other cell the hints would be noise and the whole economy — the market,
 * the bonding, the reputation, three phases of work — would be pricing
 * information that could not be used for the one thing that pays. That is why
 * `generate` takes the cell, and why the module refuses to run without it
 * rather than falling back to a seed-derived cell that would look fine and be
 * silently unwinnable by deduction.
 *
 * ─────────────────────────── the doors are checkable ────────────────────────
 *
 * Candidates are a pure function of the salt, which is committed at hunt
 * creation and revealed at settlement. Anyone can recompute the six doors
 * afterwards and confirm the house did not add one, move one, or show different
 * doors to different players — the same discipline the hint set and the cell
 * commitment already follow.
 *
 * ─────────────────────────── nothing here is timed ──────────────────────────
 *
 * There is no interval floor, no minimum answer time, and no anti-automation
 * check, and their absence is deliberate rather than an oversight. Those exist
 * in `tap` and `math` because speed decides those games, so a script that plays
 * faster than a human wins. Speed decides nothing here: an instant lock and a
 * lock at 14.9 seconds score identically. A bot that picks a door has done
 * exactly what a player does, and it beats nobody by being quick.
 */

export interface Cell {
  r: number;
  c: number;
}

export interface CrackSpec {
  /** The six doors, in a fixed order. The same six for everyone. */
  candidates: Cell[];
  limitMs: number;
}

export interface CrackSecret {
  /** Index into `candidates` of the real cell. */
  answer: number;
}

export interface CrackState {
  /** The door picked, or null while still deciding. One lock per attempt. */
  picked: number | null;
}

export type CrackInput = { kind: 'lock'; value?: unknown };

const sameCell = (a: Cell, b: Cell) => a.r === b.r && a.c === b.c;

/**
 * The six doors for a hunt, derived from its salt.
 *
 * Decoys are drawn uniformly from the whole grid rather than clustered near the
 * real cell. That is what makes hints discriminate: a quadrant hint rules out
 * roughly three quarters of a uniform draw, so a handful of honest hints really
 * does take six doors down to two. Decoys huddled around the answer would
 * survive almost every hint and turn the whole thing back into a coin flip with
 * extra steps.
 */
export function doorsFor(seed: string, cell: Cell): { candidates: Cell[]; answer: number } {
  const total = GRID.rows * GRID.cols;
  const realIdx = cell.r * GRID.cols + cell.c;

  // Distinct offsets in 1..total-1, so no decoy can land on the real cell and
  // no two decoys can collide.
  const taken = new Set<number>([realIdx]);
  const decoys: Cell[] = [];
  for (let i = 0; decoys.length < CRACK.doors - 1; i++) {
    const offset = 1 + (hashInt(seed, 'crack:decoy', i) % (total - 1));
    const idx = (realIdx + offset) % total;
    if (taken.has(idx)) continue;
    taken.add(idx);
    decoys.push({ r: Math.floor(idx / GRID.cols), c: idx % GRID.cols });
  }

  // Where the real cell sits among them. Without this the answer would always
  // be at a fixed position and the game would be over before it started.
  const answer = hashInt(seed, 'crack:answer') % CRACK.doors;
  const candidates = [...decoys];
  candidates.splice(answer, 0, { ...cell });

  return { candidates, answer };
}

export const crackModule: GameModule<CrackSpec, CrackSecret, CrackState, CrackInput> = {
  type: 'crack',

  /**
   * Attempts survive a restart.
   *
   * Fifteen seconds is short enough that the reflex games' argument — nobody is
   * mid-tap across a deploy — nearly applies. It does not, because a lock is a
   * decision rather than a stream of inputs: a player who has already committed
   * their pick is owed that pick, and losing it to a deploy would cost them a
   * cash hunt they had already solved.
   */
  durable: true,

  generate(seed: string, _difficulty: Difficulty, ctx) {
    if (!ctx?.cell) {
      // Refusing loudly rather than inventing a cell. A seed-derived answer
      // would generate cleanly, play convincingly, and be unwinnable by anyone
      // reasoning from hints — a failure that would surface as "deduction feels
      // useless" rather than as an error.
      throw new Error('crack needs the hunt cell — hints must describe the door being picked');
    }

    const { candidates, answer } = doorsFor(seed, ctx.cell);
    return {
      spec: { candidates, limitMs: CRACK.limitMs },
      secret: { answer },
      limitMs: CRACK.limitMs,
    };
  },

  /**
   * The doors, never which one is right.
   *
   * Grid dimensions ride along because the client mirrors `cellMatches` to show
   * which doors a player's hints rule out, and quadrant hints split at the
   * midpoint of the map. Public information either way — the grid size is in
   * every zone payload — and the alternative is a panel that silently computes
   * quadrants against `undefined`.
   */
  publicSpec(spec: CrackSpec) {
    return {
      candidates: spec.candidates,
      limitMs: spec.limitMs,
      doors: spec.candidates.length,
      rows: GRID.rows,
      cols: GRID.cols,
    };
  },

  init(): CrackState {
    return { picked: null };
  },

  step(ctx, input): StepResult {
    if (input.kind !== 'lock') return { kind: 'reject', reason: 'unknown_input', fatal: true };
    if (ctx.state.picked !== null) {
      // One lock per attempt. A second would be a free re-roll on a prize.
      return { kind: 'reject', reason: 'already_locked', fatal: true };
    }

    const value = input.value as Cell | number | undefined;
    const idx = typeof value === 'number' ? value : indexOfCell(ctx.spec, value);
    if (idx === null) return { kind: 'reject', reason: 'not_a_candidate', fatal: true };

    ctx.state.picked = idx;

    // Completing does NOT mean winning. Every lock completes; resolution then
    // discards the wrong ones and ranks the right ones on hints used. Reporting
    // a wrong pick as a failed attempt would leak the answer the moment you
    // locked, fifteen seconds before the reveal.
    return { kind: 'complete' };
  },

  progress(state: CrackState): number {
    return state.picked === null ? 0 : 100;
  },
};

function indexOfCell(spec: CrackSpec, value: Cell | undefined): number | null {
  if (!value || typeof value.r !== 'number' || typeof value.c !== 'number') return null;
  const idx = spec.candidates.findIndex(cell => sameCell(cell, value));
  return idx === -1 ? null : idx;
}

/** Whether an attempt's recorded pick was the right door. */
export function isCorrect(state: unknown, secret: unknown): boolean {
  const picked = (state as CrackState | null)?.picked;
  const answer = (secret as CrackSecret | null)?.answer;
  return typeof picked === 'number' && typeof answer === 'number' && picked === answer;
}

/** Latency grace, so a lock sent at 14.9s is not judged late by transit time. */
export const CRACK_DEADLINE_MS = CRACK.limitMs + RACE.latencyGraceMs;
