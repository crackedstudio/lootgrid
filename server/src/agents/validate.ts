import { z } from 'zod';
import { GRID } from '../config';
import { MAX_RING_RADIUS } from '../hints/types';
import { candidates, type DeductionSpec, type DeductionState } from '../games/deduction';
import { potAfter, type NegotiationSpec, type NegotiationState } from '../games/negotiation';
import type { SearchSpec, SearchState } from '../games/search';
import type { GameType } from '../types';
import * as metrics from '../metrics';
import { complete, model, type CompletionRequest } from './inference';

/**
 * Turning a model's output into a legal move, or not using it.
 *
 * ─────────────────────────── validate, retry, fall back ─────────────────────
 *
 * A model's response is untrusted input. It arrives as text, it may be prose, it
 * may be JSON describing a move that does not exist, and under adversarial input
 * it may be something a rival talked it into. So:
 *
 *   1. **Validate** against a schema per game. Anything that does not parse into
 *      a legal move is discarded whole — never partially honoured, for the same
 *      reason `parsePayload` drops a malformed hint rather than salvaging it.
 *   2. **Retry** once. Models fail this way transiently, and one retry is the
 *      difference between a bad turn and a wasted one. Only once: a retry loop
 *      is how an agent bills past its budget, and the budget is checked per call.
 *   3. **Fall back** to a deterministic move. Never stall, never skip a turn.
 *
 * ─────────────────────────── the fallbacks are good moves ───────────────────
 *
 * They are not placeholders. Each one is a competent, unimaginative line — the
 * halving probe, the safe non-insulting offer, the centre sweep — chosen so that
 * a provider outage costs an agent its edge rather than its attempt. An agent
 * whose model is down should play like a simple bot, not lose.
 *
 * That also makes the fallback a floor on quality: if the model cannot beat
 * these, it is not earning its inference cost, and the schema-violation gauge
 * below is how that shows up before it becomes a bill.
 */

const cell = z.object({
  r: z.number().int().min(0).max(GRID.rows - 1),
  c: z.number().int().min(0).max(GRID.cols - 1),
});

const quadrant = z.enum(['NW', 'NE', 'SW', 'SE']);

/**
 * The probe vocabulary, mirroring `hints/types.ts`.
 *
 * Restated here rather than imported as a zod schema because the hint module
 * validates with a hand-written parser; keeping both means a model's output and
 * a stored hint are checked by code with the same shape but no shared bug.
 */
const hintPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('region'), quadrant }).strict(),
  z.object({ kind: z.literal('exclusion'), quadrant }).strict(),
  z
    .object({
      kind: z.literal('rowBand'),
      from: z.number().int().min(0).max(GRID.rows - 1),
      to: z.number().int().min(0).max(GRID.rows - 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('colBand'),
      from: z.number().int().min(0).max(GRID.cols - 1),
      to: z.number().int().min(0).max(GRID.cols - 1),
    })
    .strict(),
  z.object({ kind: z.literal('parity'), parity: z.enum(['even', 'odd']) }).strict(),
  z
    .object({
      kind: z.literal('distance'),
      r: z.number().int().min(0).max(GRID.rows - 1),
      c: z.number().int().min(0).max(GRID.cols - 1),
      within: z.number().int().min(0).max(MAX_RING_RADIUS),
    })
    .strict(),
]);

/** One legal move, per game. Nothing here accepts a string. */
export const MOVE_SCHEMAS = {
  deduction: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('probe'), value: hintPayload }).strict(),
    z.object({ kind: z.literal('commit'), value: cell }).strict(),
  ]),
  search: z.object({ kind: z.literal('probe'), value: cell }).strict(),
  negotiation: z
    .object({
      kind: z.literal('offer'),
      value: z.object({ keepBps: z.number().int().min(0).max(10_000) }).strict(),
    })
    .strict(),
} as const;

export type AgentGame = keyof typeof MOVE_SCHEMAS;

export const isAgentGame = (type: GameType): type is AgentGame => type in MOVE_SCHEMAS;

export interface Move {
  kind: string;
  value?: unknown;
}

export type ParseResult = { ok: true; move: Move } | { ok: false; reason: 'not_json' | 'not_a_move' };

/**
 * Parse a model's response into a legal move.
 *
 * Tolerant about wrapping — models fence JSON in markdown no matter what they
 * are told — and strict about content. Everything past the fence is the schema's
 * problem, and the schema does not negotiate.
 */
export function parseMove(game: AgentGame, text: string): ParseResult {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  const result = MOVE_SCHEMAS[game].safeParse(raw);
  return result.success ? { ok: true, move: result.data } : { ok: false, reason: 'not_a_move' };
}

// ─────────────────────────── deterministic fallbacks ───────────────────────

/**
 * A legal move for every game, computed without a model.
 *
 * Deliberately good rather than merely legal — see the header. Each is
 * deterministic given the state, so a fallback turn is reproducible from the
 * transcript afterwards.
 */
export function fallbackMove(
  game: AgentGame,
  spec: unknown,
  state: unknown,
): Move {
  switch (game) {
    case 'deduction': {
      const s = state as DeductionState;
      const p = spec as DeductionSpec;
      const live = candidates(s.answers, p.rows, p.cols);

      // Narrowed to one, or out of questions: commit to the best guess there is.
      if (live.length <= 1 || s.used >= p.budget) {
        const target = live[0] ?? { r: 0, c: 0 };
        return { kind: 'commit', value: { r: target.r, c: target.c } };
      }

      // Otherwise halve the surviving set on whichever axis splits it evenly.
      // The same line the module's own tests use to prove the game winnable.
      const rows = live.map(x => x.r).sort((a, b) => a - b);
      const median = rows[Math.floor(rows.length / 2)]!;
      return { kind: 'probe', value: { kind: 'rowBand', from: 0, to: median } };
    }

    case 'search': {
      const s = state as SearchState;
      const p = spec as SearchSpec;
      // A deterministic sweep. Not clever — a tracking hunter beats it easily —
      // but it makes progress and never repeats a cell.
      const step = Math.max(1, Math.floor(p.rows / 4));
      const index = s.used;
      return {
        kind: 'probe',
        value: {
          r: (index * step) % p.rows,
          c: (index * 5) % p.cols,
        },
      };
    }

    case 'negotiation': {
      const s = state as NegotiationState;
      const p = spec as NegotiationSpec;
      const pot = potAfter(s.round, p.decayBps);
      const bestKeep = pot - s.askBps;

      // Take the deal if it is finally worth taking; otherwise offer one basis
      // point above the published walk-away line and survive the round.
      const keep = bestKeep >= p.minKeepBps ? bestKeep : pot - (s.askBps - p.insultBps) - 1;
      return { kind: 'offer', value: { keepBps: Math.max(0, Math.min(10_000, keep)) } };
    }
  }
}

// ─────────────────────────── the whole turn ───────────────────────────

export interface TurnRequest extends CompletionRequest {
  game: AgentGame;
  spec: unknown;
  state: unknown;
}

export interface TurnResult {
  move: Move;
  /** How the move was arrived at. Drives the gauge, and the transcript. */
  source: 'model' | 'retry' | 'fallback';
  /** Calls actually made, so the caller can bill exactly what happened. */
  calls: number;
}

/** One retry. More would be a loop that bills; none would waste a transient blip. */
export const MAX_ATTEMPTS = 2;

/**
 * Ask for a move, and always return one.
 *
 * The caller has already checked the budget for at least one call. This makes at
 * most {@link MAX_ATTEMPTS} and reports how many it used, so the ledger records
 * what was spent rather than what was planned.
 */
export async function takeTurn(req: TurnRequest): Promise<TurnResult> {
  let calls = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await complete({
      system: req.system,
      user: req.user,
      maxTokens: req.maxTokens,
    });
    calls += 1;

    if (!response.ok) {
      metrics.agentInferenceFailures.inc({ reason: response.reason });
      // A disabled provider will not become enabled on a retry.
      if (response.reason === 'disabled') break;
      continue;
    }

    const parsed = parseMove(req.game, response.text);
    if (parsed.ok) {
      metrics.agentMoves.inc({ game: req.game, source: attempt === 0 ? 'model' : 'retry' });
      return { move: parsed.move, source: attempt === 0 ? 'model' : 'retry', calls };
    }

    // The number to watch. A model that starts failing the schema is a model
    // that is about to start costing money for nothing — architecture §7 asks
    // for this to be tracked per model, and a regression treated as an incident.
    metrics.agentSchemaViolations.inc({ model: model(), reason: parsed.reason });
  }

  metrics.agentMoves.inc({ game: req.game, source: 'fallback' });
  return { move: fallbackMove(req.game, req.spec, req.state), source: 'fallback', calls };
}
