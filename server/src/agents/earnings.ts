import * as agentRepo from '../db/repos/agents';
import { MILLS_PER_CENT } from '../market/fees';
import * as metrics from '../metrics';
import { prizeCentsFor } from '../prizes';
import * as store from '../store';
import type { Attempt, Hunt } from '../types';

/**
 * What an agent won, and whether the model that let it enter was right.
 *
 * ─────────────────────────── the hole this fills ───────────────────────────
 *
 * `agentRepo` could answer "what has this agent cost" four different ways —
 * `spentSince`, `spentOnHunt`, `recentSpend`, the ledger endpoint — and could
 * not answer "did it win anything" at all. An owner could see every penny their
 * agent spent and had no way to learn whether it was net positive, which is the
 * only question they actually have.
 *
 * It matters beyond the screen. `budget.viableFor` refuses a hunt whose prize,
 * divided by entrants, does not clear the cost of thinking about it:
 *
 *     EV  =  prize / entrants  −  inference
 *
 * That is an *a-priori* model. It was never once checked against what happened,
 * because nothing recorded what happened. An EV model nobody reconciles is a
 * guess with a decimal point, and the failure mode is quiet: agents keep
 * entering hunts the arithmetic says are winnable while losing every one of them.
 *
 * ─────────────────────────── awarded, not collected ─────────────────────────
 *
 * The server pays nobody. A winner asks for a signed voucher and claims from
 * escrow themselves, so everything here means "won, and claimable" rather than
 * "has the money". For a prize worth cents, a winner who never bothers to claim
 * is an ordinary case rather than an edge one — so the two numbers genuinely
 * differ, and calling this `earned` while meaning `collected` would overstate
 * every agent's position. `claimed_at` is where that reconciliation goes when
 * there is a claim feed to drive it.
 */

/**
 * Record a prize, if an agent won it.
 *
 * Called from the referee's resolve path via `observability.ts`. Must never
 * throw: it runs inline on the race's critical path, and a bookkeeping failure
 * may not cost somebody the hunt they just won.
 */
export function onHuntResolved(hunt: Hunt, winner: Attempt, racers: number): void {
  try {
    // Only agent zones. An agent plays AS its owner, so `player_id` alone
    // cannot tell an agent's win from the same human winning by hand — and the
    // driver only ever enters agent zones, which makes zone kind the exact
    // discriminator. `agents/index.activity` uses the same test for the same
    // reason.
    if (store.getZone(hunt.zoneId)?.kind !== 'agent') return;

    // Cash only. A puzzle hunt pays XP, and recording XP as a prize in mills
    // would put a currency that buys nothing into a net-position figure.
    if (hunt.kind !== 'cash') return;

    const agent = agentRepo.ofPlayer(winner.playerId);
    if (!agent) return;

    const prizeMills = prizeCentsFor(hunt.difficulty) * MILLS_PER_CENT;
    agentRepo.recordEarning(agent.id, hunt.id, prizeMills, hunt.difficulty, racers);

    metrics.agentPrizesWon.inc({ difficulty: hunt.difficulty });
    metrics.agentPrizeMills.inc(prizeMills);

    // ── the reconciliation ──
    //
    // What the entry decision predicted this hunt was worth, against what it
    // actually paid. `viableFor` divides the prize by entrants, so the same
    // division is the prediction — and the ratio between them is how the
    // a-priori model gets checked without anyone running an analysis.
    //
    // Above 1 means the field was smaller than feared and the model is leaving
    // playable hunts on the table. Persistently below 1 is the dangerous
    // direction: agents entering races they were always going to lose.
    const predictedShare = prizeMills / Math.max(1, racers);
    if (predictedShare > 0) {
      metrics.agentEvRealised.observe(prizeMills / predictedShare);
    }
  } catch {
    // Swallowed on purpose. Losing a ledger row is worth strictly less than
    // interrupting the resolve of a race that has already been won.
  }
}

export interface Position {
  /** Prize mills won in the window — awarded, not necessarily claimed. */
  earnedMills: number;
  /** Everything the agent cost in the window: hints plus house inference. */
  spentMills: number;
  /** Earned minus spent. Negative is a real and common answer. */
  netMills: number;
  wins: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An agent's net position over a window.
 *
 * Computed here, at the point of display, and never anywhere a limit is
 * enforced — see migration 022. Spend is the combined figure deliberately: the
 * question "was this agent worth running" includes the compute, even though the
 * house paid for it, because an agent that only wins when someone else funds its
 * thinking has not answered the question.
 */
export function positionOf(agentId: string, sinceMs = DAY_MS, now = Date.now()): Position {
  const since = now - sinceMs;
  const earnedMills = agentRepo.earnedSince(agentId, since);
  const spentMills = agentRepo.spentSince(agentId, since);

  return {
    earnedMills,
    spentMills,
    netMills: earnedMills - spentMills,
    wins: agentRepo.winsSince(agentId, since),
  };
}
