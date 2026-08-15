import { get } from './http';

/**
 * Hints: directions toward a hunt.
 *
 * The predicates below mirror `server/src/hints/types.ts` exactly. That
 * duplication is deliberate — shading the grid must not cost a round trip per
 * cell — but it means the two must be changed together. The server stays
 * authoritative: it decides which hints exist and who holds them, and this file
 * only decides how they are drawn.
 *
 * A hint is a claim, not a fact. `reliabilityBps` is the advertised accuracy of
 * its tier and the UI must show it, because a tier-3 hint is close to a coin
 * flip and a player deciding where to dig deserves to know that.
 */

export const fetchHints = () => get('/hints').then(r => r.hints ?? []);

const MID_ROW = 9; // GRID.rows / 2
const MID_COL = 6; // GRID.cols / 2

export function quadrantOf(r, c) {
  return `${r < MID_ROW ? 'N' : 'S'}${c < MID_COL ? 'W' : 'E'}`;
}

/** Whether a cell is consistent with a hint, taken at face value. */
export function cellMatches(payload, r, c) {
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
      return Math.max(Math.abs(r - payload.r), Math.abs(c - payload.c)) <= payload.within;
    default:
      // An unknown kind rules nothing out. A client that has not been updated
      // shows a wider net, never a wrong one.
      return true;
  }
}

/**
 * Cells consistent with EVERY applied hint.
 *
 * Intersecting is the whole game: any single hint is weak and possibly a lie,
 * but several agreeing hints are worth acting on. It is also why an empty
 * candidate set is meaningful rather than a bug — it means the applied hints
 * contradict each other, so at least one of them is false.
 */
export function candidates(payloads, rows = 18, cols = 12) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (payloads.every(p => cellMatches(p, r, c))) out.push(`${r}:${c}`);
    }
  }
  return new Set(out);
}

/** Human-readable summary. Kept here so the wire format stays machine-only. */
export function describe(payload) {
  switch (payload.kind) {
    case 'region':
      return `Somewhere in the ${payload.quadrant}`;
    case 'exclusion':
      return `Not in the ${payload.quadrant}`;
    case 'rowBand':
      return `Between rows ${payload.from + 1} and ${payload.to + 1}`;
    case 'colBand':
      return `Between columns ${payload.from + 1} and ${payload.to + 1}`;
    case 'parity':
      return `On an ${payload.parity} square`;
    case 'distance':
      return `Within ${payload.within} of row ${payload.r + 1}, column ${payload.c + 1}`;
    default:
      return 'Unreadable hint';
  }
}

export const reliabilityPct = hint => Math.round((hint.reliabilityBps ?? 0) / 100);

/** Tier label. Sharper means more useful and less trustworthy, both at once. */
export function tierLabel(tier) {
  return tier === 3 ? 'Sharp' : tier === 2 ? 'Narrow' : 'Broad';
}
