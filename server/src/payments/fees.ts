import type { Difficulty, ZoneKind } from '../types';
import { prizeCentsFor } from '../prizes';

/**
 * Entry fees, and the arithmetic that decides whether one is payable at all.
 *
 * ─────────────────────────── the constraint ───────────────────────────
 *
 * A rational agent computes expected value and refuses a losing hunt. Humans pay
 * to be entertained; an LLM optimising its player's balance simply does not
 * enter. So on agent zones the fee is not a pricing decision, it is a
 * participation switch:
 *
 *     EV = P/N − F − costs        must be > 0
 *     ∴   F   <  P/N − costs
 *
 * where P is the prize, N the expected entrants and F the fee. Set F above that
 * line and the agent economy does not slow down, it stops. See
 * docs/AGENTIC_ARCHITECTURE.md §1.
 *
 * ─────────────────────────── what the maths says ───────────────────────────
 *
 * The uncomfortable part is that N is not fixed. A popular hunt is *worse* EV
 * for everyone in it, so a fee that is generous at eight entrants is extortionate
 * at forty:
 *
 *     $0.50 prize, 1¢ fee:   N=8  → ratio 0.16
 *                            N=20 → ratio 0.40
 *                            N=32 → ratio 0.64   ← past the alert threshold
 *
 * Two honest conclusions follow. Entry fees only work while hunts stay small,
 * unless prizes scale with entrants. And at the bottom of the prize band they do
 * not work at all: a 1¢ prize shared eight ways is worth an eighth of a cent, so
 * no fee above zero can ever be rational. Easy hunts are therefore free, by
 * arithmetic rather than by generosity.
 *
 * ─────────────────────────── legal ───────────────────────────
 *
 * Pay-to-enter for a cash prize is the gambling definition in many
 * jurisdictions, and this build compounds it — the house charges admission,
 * controls the hint information, and may deliberately falsify it. Everything
 * here is behind ENTRY_FEES_ENABLED, default false, and must stay that way until
 * a lawyer says otherwise. `freeEntryAvailable` exists partly for that reason.
 */

/**
 * Fee per difficulty, in cents. Deliberately conservative against the ratio
 * above rather than against what a player might tolerate.
 *
 * `easy` is 0 and should stay 0 — but the reason has changed, and the new one
 * is stronger. It used to be arithmetic: at a 1¢ prize no positive fee was
 * rational, so the config could not invent one. At the raised floor a small fee
 * on an easy hunt *would* be rational, and it must still be zero, because a
 * genuinely free path to every prize is what keeps this the right side of the
 * gambling line. See the module header, and §7c of the review: money buys
 * information and exploration, never a chance at the pot.
 */
export const ENTRY_FEE_CENTS: Record<Difficulty, number> = {
  easy: 0,
  med: 1,
  hard: 10,
};

/**
 * The ratio F ÷ (P/N) at which a zone gets flagged.
 *
 * Well below 1.0 on purpose. At 1.0 the hunt is exactly break-even *before*
 * hint spend and inference, so by the time it is observed crossing that line the
 * agents have already left.
 */
export const EV_ALERT_RATIO = 0.6;

/** Human zones tolerate negative EV — people pay to be entertained. Agents do not. */
export function feeCentsFor(difficulty: Difficulty, zoneKind: ZoneKind): number {
  const base = ENTRY_FEE_CENTS[difficulty] ?? 0;
  return zoneKind === 'agent' ? base : base;
}

/**
 * Fee as a fraction of a single entrant's expected share.
 *
 * Returns `Infinity` for a free-but-prizeless hunt so callers cannot read a
 * degenerate case as healthy. Returns 0 when the fee is 0, whatever the prize.
 */
export function evRatio(feeCents: number, prizeCents: number, entrants: number): number {
  if (feeCents <= 0) return 0;
  if (prizeCents <= 0 || entrants <= 0) return Number.POSITIVE_INFINITY;
  const sharePerEntrant = prizeCents / entrants;
  return feeCents / sharePerEntrant;
}

/**
 * Whether entering is rational, ignoring hint spend and inference.
 *
 * Deliberately optimistic — real costs only make it worse — so a hunt this
 * rejects is one no agent would touch under any circumstances.
 */
export function isRationalToEnter(
  feeCents: number,
  prizeCents: number,
  entrants: number,
): boolean {
  return evRatio(feeCents, prizeCents, entrants) < 1;
}

/** Largest entrant count at which a fee still sits under the alert ratio. */
export function safeEntrantCeiling(feeCents: number, prizeCents: number): number {
  if (feeCents <= 0) return Number.POSITIVE_INFINITY;
  if (prizeCents <= 0) return 0;
  return Math.floor((EV_ALERT_RATIO * prizeCents) / feeCents);
}

export interface EntryQuote {
  feeCents: number;
  prizeCents: number;
  /** True when the player may enter without paying — see energy, below. */
  freeEntryAvailable: boolean;
  evRatio: number;
  /** False once the fee is no longer rational at the current entrant count. */
  rational: boolean;
}

/**
 * Everything a caller needs to decide whether to charge, and to explain it.
 *
 * `freeEntryAvailable` is the energy path: energy already gates play without
 * money, so a player who has it can enter a rewarded hunt without paying. That
 * keeps a no-cost route to every prize, which is both better for players and one
 * of the factors that reduces regulatory exposure (architecture §10).
 */
export function quoteEntry(
  difficulty: Difficulty,
  zoneKind: ZoneKind,
  entrants: number,
  hasEnergy: boolean,
): EntryQuote {
  const feeCents = feeCentsFor(difficulty, zoneKind);
  const prizeCents = prizeCentsFor(difficulty);
  const ratio = evRatio(feeCents, prizeCents, Math.max(1, entrants));

  return {
    feeCents,
    prizeCents,
    freeEntryAvailable: hasEnergy,
    evRatio: ratio,
    rational: ratio < 1,
  };
}
