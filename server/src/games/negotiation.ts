import { NEGOTIATION, RACE } from '../config';
import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import type { Directive } from '../director/types';
import type { GameModule, StepResult } from './types';

/**
 * Negotiation: read the concession schedule, then strike.
 *
 * ─────────────────────────── the rules ───────────────────────────
 *
 * The counterparty has an **ask** — how much of the pot it wants. It is
 * published at the start and re-published after every refusal, so it is always
 * known. What is hidden is how fast it comes down.
 *
 * Each round you propose a split:
 *
 *   * offer at or above the ask → the deal closes. You win **only** if you are
 *     still holding `minKeepBps`; closing for less is a deal you should not
 *     have made.
 *   * offer more than `insultBps` below the ask → they walk, and the attempt
 *     ends.
 *   * anything between → refused. You lose a round, the ask comes down, and the
 *     pot shrinks.
 *
 * Early on the two constraints are incompatible: the ask is high enough that
 * keeping your minimum would be an insult. So you cannot simply demand your
 * floor every round and wait — that is the line a scripted client would take,
 * and on a block whose counterparty opens late it gets you thrown out. There is
 * a test for precisely that, because a module a constant beats would answer
 * phase 6's question with a false yes.
 *
 * ─────────────────────────── nothing is blind ───────────────────────────
 *
 * Both lines are computable from what you have been told: the ask is public and
 * `insultBps` is in the spec. A player who does the arithmetic is never
 * surprised, and every block has a line that wins. That matters more than
 * making it hard — a hunt that can kill you for something you could not have
 * known is not difficult, it is unfair, and it takes a player's energy for it.
 *
 * What is genuinely uncertain is *when* to strike: the ask falls at a hidden
 * rate while the pot decays at a published one, so the window in which you can
 * both satisfy the ask and keep your minimum opens at a round you have to infer
 * from the concessions you have watched. Push past it and you run out of rounds.
 *
 * ─────────────────────────── what phase 7 changes ───────────────────────────
 *
 * The depth here is honestly limited: against a fixed schedule this is
 * arithmetic over observations, not strategy. It is built now because the
 * *seam* is what phase 7 needs — an offer is two integers, never prose, because
 * the thing on the other end will be a model reading attacker-controlled input
 * with a wallet attached. Swap the schedule for a live counterparty and the
 * same struct becomes a real negotiation.
 */

export interface NegotiationSpec {
  potBps: number;
  rounds: number;
  /** The share you must still hold when it closes. */
  minKeepBps: number;
  /** How far below the CURRENT ask you may go before they walk. Published. */
  insultBps: number;
  /** What they want in round 0, in bps of the original pot. Published. */
  openingAskBps: number;
  decayBps: number;
  limitMs: number;
}

export interface NegotiationSecret {
  /** How much the ask comes down per refusal. The one thing not published. */
  concedeBps: number;
  /**
   * The first round at which a deal at exactly `minKeepBps` is possible.
   *
   * Stored because it is what the generator solved for: the schedule is
   * positioned so this block is winnable, and winnable no earlier.
   */
  opensAt: number;
}

export interface NegotiationState {
  round: number;
  /** What they are asking right now. Emitted after every refusal. */
  askBps: number;
  closed: boolean;
  keptBps: number | null;
  /**
   * How much they will come down after the next refusal, set when the last one
   * was answered.
   *
   * Recorded rather than recomputed, for the reason every directed module does
   * it: an offer is judged against the ask the player was actually shown, and a
   * directive landing mid-round shapes the concession after it. Undefined on
   * states written before the Director reached this module, which reads as the
   * counterparty's own schedule.
   */
  nextConcedeBps?: number;
}

export interface NegotiationInput {
  kind: string;
  /** `{ keepBps }` — bps of the ORIGINAL pot you propose to keep. */
  value?: unknown;
}

/** The pot after `round` rounds of decay, in bps of the original. */
export function potAfter(round: number, decayBps: number): number {
  let pot = 10_000;
  for (let i = 0; i < round; i++) pot -= Math.floor((pot * decayBps) / 10_000);
  return pot;
}

/**
 * Concession per refusal.
 *
 * Faster than the pot decays, or waiting could never pay and the only rational
 * line would be to close in round 0 regardless of the ask.
 */
const CONCEDE_BPS = 1_200;

/**
 * Latest round a block may open at.
 *
 * Capped because an `opensAt` further out implies an opening ask above the
 * whole pot, which is not a negotiation, it is a wall.
 */
const MAX_OPENS_AT = 4;

/**
 * The floor under any concession the Director may impose.
 *
 * A counterparty that stops conceding is not a hard negotiation, it is a wall:
 * `generate` promises a deal exists at or above `minKeepBps`, and a schedule
 * that flattens to nothing can walk the ask past the point where that promise
 * still holds. Two thirds of the block's own rate is stubborn; zero is a
 * different game with no answer in it.
 */
const MIN_CONCEDE_RATIO = 0.66;

/**
 * How far they come down after the next refusal.
 *
 * The one lever here that stays honest. `askBps` is already emitted every
 * round, so a changed concession is visible in the next number the player reads
 * — they are never told a schedule that turns out to be false, only one that
 * turns out to be steeper. Compare `insultBps`, which is in the spec and read
 * before an offer is composed: bending that would move a line the player had
 * already aimed at, and is exactly why it is left alone.
 */
function concedeFor(directive: Directive | null, base: number): number {
  if (!directive) return base;

  // 1 is generous, 5 is stubborn.
  let ratio = 1 + (3 - directive.difficulty) * 0.12;
  if (directive.roundType === 'endurance') ratio -= 0.1;
  if (directive.twist === 'silence') ratio -= 0.1;

  return Math.max(Math.round(base * MIN_CONCEDE_RATIO), Math.round(base * ratio));
}

export const negotiationModule: GameModule<
  NegotiationSpec,
  NegotiationSecret,
  NegotiationState,
  NegotiationInput
> = {
  type: 'negotiation',
  durable: true,

  generate(seed, difficulty: Difficulty) {
    const rounds = NEGOTIATION.rounds[difficulty] ?? NEGOTIATION.rounds.med;
    const minKeepBps = NEGOTIATION.minKeepBps[difficulty] ?? NEGOTIATION.minKeepBps.med;
    const insultBps = NEGOTIATION.insultBps[difficulty] ?? NEGOTIATION.insultBps.med;

    // Solve for winnability rather than hoping for it: pick the round the
    // window opens, then position the opening ask so that a deal at exactly
    // `minKeepBps` is available then, and not before.
    const opensAt = hashInt(seed, 'negotiation:opens') % Math.min(rounds, MAX_OPENS_AT + 1);
    const openingAskBps =
      potAfter(opensAt, NEGOTIATION.decayBps) - minKeepBps + CONCEDE_BPS * opensAt;

    return {
      spec: {
        potBps: 10_000,
        rounds,
        minKeepBps,
        insultBps,
        openingAskBps,
        decayBps: NEGOTIATION.decayBps,
        limitMs: NEGOTIATION.limitMs,
      },
      secret: { concedeBps: CONCEDE_BPS, opensAt },
      limitMs: NEGOTIATION.limitMs,
    };
  },

  publicSpec(spec) {
    // Every rule and the opening ask. Only the concession rate is withheld —
    // that they soften is knowable, how fast is the game.
    return { ...spec };
  },

  /**
   * The round the next ask will be served for, or null on the last one.
   *
   * Asked for only while a round remains — a directive for a round nobody plays
   * is a decision the transcript records and nobody took.
   */
  directedRound(state, spec) {
    const next = state.round + 1;
    return next < spec.rounds ? next : null;
  },

  init(spec) {
    return { round: 0, askBps: spec.openingAskBps, closed: false, keptBps: null };
  },

  step({ spec, secret, state, timing, directive }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }
    if (input.kind !== 'offer') return { kind: 'reject', reason: 'bad_input', fatal: true };
    if (state.closed) return { kind: 'reject', reason: 'already_closed', fatal: true };
    if (state.round >= spec.rounds) {
      // Out of rounds. Terminal, or there is no deadline and no reason to hurry.
      return { kind: 'reject', reason: 'no_deal', fatal: true };
    }

    const keepBps = parseKeep(input.value);
    if (keepBps === null) return { kind: 'reject', reason: 'bad_offer', fatal: true };

    const pot = potAfter(state.round, spec.decayBps);
    // Every quantity in this game — the ask, the minimum, the offer — is in
    // basis points of the ORIGINAL pot, so decay costs real value and no
    // conversion happens anywhere. That is not tidiness: expressing an offer as
    // a share of the *current* pot means converting twice, and the rounding
    // makes a deal at exactly `minKeepBps` inexpressible — which is precisely
    // the deal the generator promises exists.
    const kept = Math.min(keepBps, pot);
    const offered = pot - kept;
    const ask = state.askBps;

    state.round += 1;

    if (offered >= ask) {
      state.closed = true;
      state.keptBps = kept;
      if (kept < spec.minKeepBps) {
        // Accepted, and a loss. A deal at any price is not the game.
        return { kind: 'reject', reason: 'conceded_too_much', fatal: true };
      }
      return { kind: 'complete', emit: { accepted: true, round: state.round, keptBps: kept } };
    }

    if (offered < ask - spec.insultBps) {
      // They walk. Avoidable with arithmetic the player already has — which is
      // what makes it a rule rather than a trap.
      return { kind: 'reject', reason: 'insulted', fatal: true };
    }

    // They come down by what they were GOING to come down by — the schedule the
    // player has been reading for two rounds — not by whatever the Director has
    // since decided. A concession rewritten under an offer already made would
    // make the published schedule a lie.
    state.askBps = Math.max(0, ask - (state.nextConcedeBps ?? secret.concedeBps));
    state.nextConcedeBps = concedeFor(directive, secret.concedeBps);

    return {
      kind: 'progress',
      emit: {
        accepted: false,
        round: state.round,
        roundsLeft: spec.rounds - state.round,
        // The concession, published. Two of these and the schedule is solved.
        askBps: state.askBps,
        potBps: potAfter(state.round, spec.decayBps),
      },
    };
  },

  /**
   * How close the window is to opening.
   *
   * Rounds spent would reward stalling and rise as you run out of time. This
   * tracks the gap between what you could keep if they accepted now and what
   * you must keep to win — which is the thing actually closing.
   */
  progress(state, spec) {
    if (state.closed) return state.keptBps !== null && state.keptBps >= spec.minKeepBps ? 100 : 0;

    const pot = potAfter(state.round, spec.decayBps);
    const bestKeep = pot - state.askBps;
    if (bestKeep >= spec.minKeepBps) return 99; // Open, but not yet taken.

    const gap = spec.minKeepBps - bestKeep;
    const opening = spec.minKeepBps - (spec.potBps - spec.openingAskBps);
    if (opening <= 0) return 99;
    return Math.max(0, Math.min(99, Math.round((1 - gap / opening) * 99)));
  },
};

function parseKeep(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const { keepBps } = raw as { keepBps?: unknown };
  if (typeof keepBps !== 'number' || !Number.isInteger(keepBps)) return null;
  return keepBps >= 0 && keepBps <= 10_000 ? keepBps : null;
}
