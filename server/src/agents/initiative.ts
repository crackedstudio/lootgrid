import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import type { Condition } from '../director/world';
import * as budget from './budget';
import type { Persona } from './persona';

/**
 * Deciding *when* to act, and which of several hunts to take.
 *
 * ─────────────────────────── the tell this removes ───────────────────────────
 *
 * `enterSomething` entered the first viable hunt it found, in whatever order the
 * zone happened to list them. Every agent shares that order, so every agent made
 * the same choice for the same reason at the same moment — the single most
 * mechanical thing a watching player could notice, and no amount of varied
 * timing hides it.
 *
 * This scores the candidates instead and takes the best one *for this agent*, or
 * takes none and waits. Two agents looking at the same board now disagree,
 * because they want different things.
 *
 * ─────────────────────────── it costs nothing to think this way ─────────────
 *
 * Not one provider call. That is a design constraint, not an accident: the
 * obvious way to build opportunism is to ask a model "should I enter?", and at
 * `runtime.MAX_IN_FLIGHT` that doubles the load on the gate that already bounds
 * everything agents do. Spontaneity bought with inference is spontaneity behind
 * a queue.
 *
 * So the inputs are all free, and the model's influence arrives through the one
 * call that is already being made and already shared — the zone's weather, which
 * costs one call per zone per ninety seconds however many agents read it.
 *
 *     persona (free)  ×  weather (one shared call)  ×  EV arithmetic (free)
 *
 * ─────────────────────────── it may not spend more ──────────────────────────
 *
 * Nothing here authorises anything. `viableFor`, `canInfer` and `canBuyHint`
 * still decide what is affordable, and the vault still decides what is possible.
 * This only ever chooses *between* options that were already permitted, or
 * declines them all — so the worst an aggressive score can do is enter a hunt
 * the agent was already allowed to enter.
 */

export interface Candidate {
  huntId: string;
  difficulty: Difficulty;
  /** Racers already on it. Contention cuts both ways — see {@link score}. */
  entrants: number;
}

/**
 * How much this agent wants this hunt, 0–1.
 *
 * Zero means "not worth taking". Anything above {@link APPETITE} is taken, and
 * the highest scorer wins when several clear it.
 */
export function score(
  candidate: Candidate,
  persona: Persona,
  condition: Condition | null,
  model: string,
): number {
  // The floor is the same arithmetic that already governs entry: a hunt that is
  // not viable is not a preference, it is a refusal, and no temperament may
  // overrule it.
  if (!budget.viableFor(candidate.difficulty, candidate.entrants, model)) return 0;

  // ── contention ──
  //
  // A crowd is a worse expected share and a better story. Bold agents discount
  // it less than timid ones, which is what makes two agents standing in front of
  // the same busy hunt reach opposite conclusions.
  const crowdTolerance = 0.3 + (persona.boldness / 100) * 0.7;
  const contention = 1 / (1 + (candidate.entrants - 1) * (1 - crowdTolerance));

  // ── difficulty ──
  //
  // Nerve is appetite for the hard tiers. A steady agent prefers a sure easy
  // win; a nervy one would rather lose a hard hunt than win a dull one.
  const tier = TIER_WEIGHT[candidate.difficulty];
  const nerve = persona.nerve / 100;
  const appetiteForTier = 1 - Math.abs(tier - nerve);

  // ── weather ──
  //
  // The only place a model reaches this decision, and it arrives pre-shared.
  const mood = condition ? MOOD[condition.kind] * (condition.intensity / 3) : 0;

  return clamp01(contention * 0.5 + appetiteForTier * 0.35 + mood * 0.15);
}

/** Prize tiers as a 0–1 axis, so nerve can be compared against them. */
const TIER_WEIGHT: Record<Difficulty, number> = { easy: 0, med: 0.5, hard: 1 };

/** How much each weather nudges an agent toward acting at all. */
const MOOD: Record<Condition['kind'], number> = {
  goldrush: 1,
  scramble: 0.6,
  calm: 0.4,
  hush: 0.3,
  fogbank: 0,
};

/**
 * The bar a hunt must clear to be worth entering.
 *
 * Low enough that agents play — an agent holding out for a perfect hunt is an
 * agent that never appears, and a zone of those is indistinguishable from a
 * broken driver.
 */
export const APPETITE = 0.35;

export interface Choice {
  candidate: Candidate;
  score: number;
}

/**
 * Which hunt to take now, if any.
 *
 * Returns null when nothing clears the bar — a real answer, not a failure.
 * Waiting for a better hunt is the behaviour that makes an agent look like it
 * has an opinion, and `driver.ts` treats a null here as "no entry this tick"
 * rather than as an error.
 *
 * Ties break on the hunt id rather than on list order, so two equally attractive
 * hunts do not both go to whichever the zone happened to list first — the tell
 * this module exists to remove would otherwise walk straight back in through
 * the sort.
 */
export function choose(
  candidates: Candidate[],
  persona: Persona,
  condition: Condition | null,
  model: string,
  agentId: string,
): Choice | null {
  let best: Choice | null = null;

  for (const candidate of candidates) {
    const s = score(candidate, persona, condition, model);
    if (s < APPETITE) continue;

    if (
      !best ||
      s > best.score ||
      // Deterministic per agent, so two agents break the same tie differently.
      (s === best.score &&
        hashInt(agentId, candidate.huntId) > hashInt(agentId, best.candidate.huntId))
    ) {
      best = { candidate, score: s };
    }
  }

  return best;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
