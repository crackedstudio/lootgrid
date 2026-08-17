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

/**
 * ─────────────────────── hint shapes are grid-relative ──────────────────────
 *
 * A hint is priced by {@link sharpness} — the fraction of the map it rules out
 * — and reliability is published per tier. Both of those are promises. So when
 * the map changes size, a hint shape written as a *constant* silently breaks
 * the promise: a ±2 row band covered 28% of an 18-row grid and would cover 8%
 * of a 60-row one, turning a tier-2 hint into something sharper than tier 3
 * while still advertising 70% reliability and still priced as tier 2.
 *
 * Quadrants and parity are already proportional — a quadrant is a quarter of
 * any grid — which is why they need nothing here. Bands and distance rings do
 * not scale on their own, so they are expressed as the fraction of the map they
 * are *meant* to cover, and the constants are recovered from the grid.
 *
 * The fractions below are exactly the shapes the 18×12 grid produced, so this
 * is a re-derivation rather than a rebalance: feed it the old grid and it
 * returns the old numbers. `hints/generate.test.ts` asserts that.
 */

/** Share of the rows a tier-2 row band spans. 5 rows of 18. */
const ROW_BAND_SPAN = 5 / 18;
/** Share of the columns a tier-2 column band spans. 3 cols of 12. */
const COL_BAND_SPAN = 3 / 12;
/** Share of the map a tier-3 ring covers, at its two sizes. 9 and 25 of 216. */
const RING_AREA = [9 / 216, 25 / 216] as const;

/** Half-width of a band covering `share` of `axis` cells. */
function halfSpan(axis: number, share: number): number {
  const span = Math.max(1, Math.round(axis * share));
  return Math.floor((span - 1) / 2);
}

/** Chebyshev radius of a square covering `share` of the map. */
function ringRadius(share: number): number {
  const side = Math.sqrt(share * GRID.rows * GRID.cols);
  return Math.max(0, Math.round((side - 1) / 2));
}

export const ROW_BAND_HALF = halfSpan(GRID.rows, ROW_BAND_SPAN);
export const COL_BAND_HALF = halfSpan(GRID.cols, COL_BAND_SPAN);
/** The two tier-3 radii, smallest first. */
export const RING_RADII = RING_AREA.map(ringRadius);

/**
 * Largest radius a stored or transmitted hint may claim.
 *
 * Twice the sharpest the generator will produce — the same slack the old
 * hardcoded `4` gave against a generated maximum of 2. It is a bound on
 * untrusted input, not a game parameter: a hint claiming a radius the generator
 * cannot produce is malformed, and one claiming a huge radius is just noise.
 */
export const MAX_RING_RADIUS = 2 * Math.max(...RING_RADII);

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
 * How many cells a hint is consistent with — counted, not enumerated.
 *
 * {@link candidateCells} materialises the list and is the readable definition;
 * this is the same number in closed form. On a 216-cell grid the difference was
 * academic. On a 3,600-cell one it is not: {@link sharpness} is what
 * `market/pricing.ts` values every hint with, so the enumerating version put a
 * 3,600-iteration scan on the pricing path of a market that is supposed to be
 * busy.
 *
 * `candidateCells` remains the specification. `candidateCount.matchesEnumeration`
 * in the tests asserts the two agree cell-for-cell on every shape, at more than
 * one grid size — which is the only thing that makes an optimisation like this
 * safe to keep.
 */
export function candidateCount(payload: HintPayload): number {
  const { rows, cols } = GRID;

  // Quadrants split at the midpoint, so on an odd axis they are NOT equal
  // quarters — north gets the smaller half. Counting has to respect that or it
  // disagrees with `quadrantOf` on exactly the grids where it matters.
  const north = MID_ROW;
  const south = rows - MID_ROW;
  const west = MID_COL;
  const east = cols - MID_COL;

  const quadrantArea = (q: Quadrant): number =>
    (q[0] === 'N' ? north : south) * (q[1] === 'W' ? west : east);

  /** Cells in [centre-w, centre+w] clamped to an axis of `len`. */
  const span = (centre: number, w: number, len: number): number =>
    Math.min(len - 1, centre + w) - Math.max(0, centre - w) + 1;

  switch (payload.kind) {
    case 'region':
      return quadrantArea(payload.quadrant);
    case 'exclusion':
      return rows * cols - quadrantArea(payload.quadrant);
    case 'rowBand':
      return (payload.to - payload.from + 1) * cols;
    case 'colBand':
      return (payload.to - payload.from + 1) * rows;
    case 'parity': {
      // A row contributes the columns matching its own parity.
      const evenCols = Math.ceil(cols / 2);
      const oddCols = cols - evenCols;
      const evenRows = Math.ceil(rows / 2);
      const oddRows = rows - evenRows;
      const even = evenRows * evenCols + oddRows * oddCols;
      return payload.parity === 'even' ? even : rows * cols - even;
    }
    case 'distance':
      return span(payload.r, payload.within, rows) * span(payload.c, payload.within, cols);
  }
}

/**
 * Fraction of the grid a hint rules out, 0–1. Higher is sharper.
 * Phase 5 prices hints off this; phase 1 uses it to sanity-check tiers.
 */
export function sharpness(payload: HintPayload): number {
  return 1 - candidateCount(payload) / (GRID.rows * GRID.cols);
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
      return inRows(p.r) &&
        inCols(p.c) &&
        int(p.within) &&
        p.within >= 0 &&
        p.within <= MAX_RING_RADIUS
        ? { kind: 'distance', r: p.r, c: p.c, within: p.within }
        : null;
    default:
      return null;
  }
}
