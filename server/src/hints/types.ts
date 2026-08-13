import { GRID } from '../config';

/**
 * Hints: directions toward a hunt, and the core loop of v2.
 *
 * ─────────────────────────── the schema is a boundary ───────────────────────
 *
 * There is no free-text field here and there must never be one. In later phases
 * hints are traded between agents, which makes a hint's contents
 * attacker-controlled input arriving at a model that can spend a player's money.
 * A closed set of kinds with numeric/enum payloads is what keeps that safe —
 * adding a `note: string` would quietly undo it. See
 * docs/AGENTIC_ARCHITECTURE.md §6.
 *
 * ─────────────────────────── hints can lie ───────────────────────────
 *
 * Precision and reliability are inversely correlated, deliberately: a vague hint
 * is usually true, a precise one is close to a coin flip. That is what makes
 * aggregating several weak hints better play than trusting one strong hint, and
 * it is what gives seller reputation something to measure later.
 *
 * `isTrue` is decided at generation time and **never leaves the server**. Phase 2
 * commits to the whole set up front and reveals it after the hunt, so the
 * deception rate is auditable rather than something players have to take on
 * trust.
 */

export type HintKind =
  | 'region'
  | 'exclusion'
  | 'rowBand'
  | 'colBand'
  | 'parity'
  | 'distance';

export type Quadrant = 'NW' | 'NE' | 'SW' | 'SE';

/** 1 = vaguest and most reliable, 3 = sharpest and least. */
export type HintTier = 1 | 2 | 3;

export type HintPayload =
  | { kind: 'region'; quadrant: Quadrant }
  | { kind: 'exclusion'; quadrant: Quadrant }
  | { kind: 'rowBand'; from: number; to: number }
  | { kind: 'colBand'; from: number; to: number }
  | { kind: 'parity'; parity: 'even' | 'odd' }
  | { kind: 'distance'; r: number; c: number; within: number };

/** What a player sees. Note the absence of `isTrue`. */
export interface Hint {
  id: string;
  huntId: string;
  zoneId: string;
  epoch: number;
  tier: HintTier;
  /** Advertised accuracy of this tier's pool, in basis points. */
  reliabilityBps: number;
  payload: HintPayload;
  /** Mirrors the hunt's expiry. Null means it lives as long as the hunt does. */
  expiresAt: number | null;
}

/** Server-side only. `isTrue` is the input to the phase 2 commitment. */
export interface HintRecord extends Hint {
  isTrue: boolean;
  /** Position within the hunt's generated set; stable across regeneration. */
  idx: number;
}

/**
 * Advertised accuracy per tier. Published to players, committed to in phase 2,
 * and checked against observed accuracy afterwards — so these are a promise,
 * not a tuning knob to be quietly adjusted.
 */
export const TIER_RELIABILITY_BPS: Record<HintTier, number> = {
  1: 9_000, // 90% — broad strokes, rarely a lie
  2: 7_000, // 70%
  3: 5_000, // 50% — sharp enough to be worth it, honest enough to be a gamble
};

/** How many hints exist per hunt. The set phase 2 commits to. */
export const HINTS_PER_HUNT = 6;

// ─────────────────────────── geometry ───────────────────────────

export const MID_ROW = Math.floor(GRID.rows / 2);
export const MID_COL = Math.floor(GRID.cols / 2);

export function quadrantOf(r: number, c: number): Quadrant {
  const ns = r < MID_ROW ? 'N' : 'S';
  const we = c < MID_COL ? 'W' : 'E';
  return `${ns}${we}` as Quadrant;
}

// ─────────────────────────── predicates ───────────────────────────

/**
 * Whether a cell is consistent with a hint, **taken at face value**.
 *
 * This is the whole meaning of a hint and it is deliberately pure: the client
 * mirrors it to shade the grid, tests assert against it, and later phases price
 * hints by how much of the grid it eliminates. It says nothing about whether the
 * hint is true — a false hint is perfectly self-consistent, which is exactly why
 * it is worth something to the player who believes it.
 */
export function cellMatches(payload: HintPayload, r: number, c: number): boolean {
  switch (payload.kind) {
    case 'region':
      return quadrantOf(r, c) === payload.quadrant;
    case 'exclusion':
      return quadrantOf(r, c) !== payload.quadrant;
    case 'rowBand':
      return r >= payload.from && r <= payload.to;
    case 'colBand':
      return c >= payload.from && c <= payload.to;
    case 'parity':
      return ((r + c) % 2 === 0 ? 'even' : 'odd') === payload.parity;
    case 'distance':
      // Chebyshev: a square ring, which reads naturally on a grid.
      return Math.max(Math.abs(r - payload.r), Math.abs(c - payload.c)) <= payload.within;
  }
}

/** Every cell consistent with a hint. Used for scoring and for tests. */
export function candidateCells(payload: HintPayload): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      if (cellMatches(payload, r, c)) out.push({ r, c });
    }
  }
  return out;
}

/**
 * Fraction of the grid a hint rules out, 0–1. Higher is sharper.
 * Phase 5 prices hints off this; phase 1 uses it to sanity-check tiers.
 */
export function sharpness(payload: HintPayload): number {
  const total = GRID.rows * GRID.cols;
  return 1 - candidateCells(payload).length / total;
}

// ─────────────────────────── validation ───────────────────────────

const QUADRANTS: Quadrant[] = ['NW', 'NE', 'SW', 'SE'];

/**
 * Parse an untrusted payload. Everything crossing a trust boundary — storage,
 * the wire, and in later phases another agent — comes back through here.
 * Returns null rather than throwing: a malformed hint is dropped, never
 * partially honoured.
 */
export function parsePayload(raw: unknown): HintPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  const inRows = (v: unknown): v is number => int(v) && v >= 0 && v < GRID.rows;
  const inCols = (v: unknown): v is number => int(v) && v >= 0 && v < GRID.cols;

  switch (p.kind) {
    case 'region':
    case 'exclusion':
      return QUADRANTS.includes(p.quadrant as Quadrant)
        ? { kind: p.kind, quadrant: p.quadrant as Quadrant }
        : null;
    case 'rowBand':
      return inRows(p.from) && inRows(p.to) && p.from <= p.to
        ? { kind: 'rowBand', from: p.from, to: p.to }
        : null;
    case 'colBand':
      return inCols(p.from) && inCols(p.to) && p.from <= p.to
        ? { kind: 'colBand', from: p.from, to: p.to }
        : null;
    case 'parity':
      return p.parity === 'even' || p.parity === 'odd'
        ? { kind: 'parity', parity: p.parity }
        : null;
    case 'distance':
      return inRows(p.r) && inCols(p.c) && int(p.within) && p.within >= 0 && p.within <= 4
        ? { kind: 'distance', r: p.r, c: p.c, within: p.within }
        : null;
    default:
      return null;
  }
}
