import { WALLET } from './config';
import * as keys from './keys';
import * as rank from './rank';
import type { Hunt, Player, ZoneKind } from './types';

/**
 * May this player enter this hunt?
 *
 * ─────────────────────────── why one function ───────────────────────────
 *
 * Four independent defences guard a pot with real money in it, and the review
 * is explicit that no zone should be funded until they are all live. What makes
 * them a *gate* rather than four checks is that they are asked in one place:
 *
 *   * **Private maps** (phase 1) — every fake account pays its own exploration
 *     cost instead of riding one solved map. Not enforced here; it is enforced
 *     by the schema, which is stronger.
 *   * **Keys** — five cash entries a day per identity, and no mechanism exists
 *     to grant a sixth. See keys.ts.
 *   * **Rank** — earned from hints that have resolved, across distinct days. The
 *     axis an attacker cannot buy. See rank.ts.
 *   * **Wallet age** — an empty new wallet is free to create; one with history
 *     is not.
 *
 * Plus the shadow ban, which predates all of them and already stopped cash
 * matching.
 *
 * Before this file those checks would have been scattered across the HTTP
 * handler, the agent driver and the referee, and the failure mode of that is
 * specific and bad: someone adds a fifth defence, wires it into the route they
 * were looking at, and the other entry path silently keeps admitting everyone.
 * There is one door now.
 *
 * ─────────────────────────── puzzle hunts are not gated ────────────────────
 *
 * Every check here is about protecting money, so none of them applies to a hunt
 * that pays XP — which is twenty-three of every twenty-four on the map. A new
 * player can play essentially all of the game on their first day. What they
 * cannot do on their first day is take cash out of it.
 *
 * That split is also what keeps the free path to every prize real: rank is
 * earned by playing, and playing is free.
 */

export type RefusalCode =
  | 'shadow_banned'
  | 'no_keys_left'
  | 'rank_too_low'
  | 'wallet_too_new';

export interface Admission {
  ok: boolean;
  code?: RefusalCode;
  /** Everything the player needs to know to fix it, or nothing to hide. */
  detail?: Record<string, unknown>;
}

const ALLOWED: Admission = { ok: true };

export function mayEnter(
  player: Player,
  hunt: Hunt,
  zoneKind: ZoneKind = 'human',
  now = Date.now(),
): Admission {
  // Nothing below applies to XP. See the note above.
  if (hunt.kind !== 'cash') return ALLOWED;

  // ─────────────────────────── agent zones are not gated here ────────────────
  //
  // Not an oversight and not a hole — the rank gate is *unsatisfiable* for an
  // agent, and shipping it here would have quietly closed the agent zone
  // entirely.
  //
  // Rank is computed from hints held on hunts that have closed, and hints are
  // acquired by digging fog. Agents do not dig: they enter blocks, reason, and
  // trade. They would sit at `unranked` forever no matter how well they played,
  // and the failure would look like "the agent zone has no entrants" rather
  // than like a bug.
  //
  // They are not ungoverned. Agents carry their own admission built across
  // phases 6–10 and it is stricter in the ways that matter for them: on-chain
  // identity registration, a per-agent spend budget, posted bonds against
  // selling false hints, and a reputation score weighted by verified trades.
  // Sybil resistance for an agent costs a registration and a stake; for a human
  // wallet it costs time, which is what the rules below charge.
  if (zoneKind === 'agent') return ALLOWED;

  // Deliberately indistinguishable from the hunt having closed — telling a
  // suspected botter exactly when they were caught only helps them iterate.
  // This is the one refusal that does NOT explain itself, and the asymmetry is
  // the point.
  if (player.shadowBanned) return { ok: false, code: 'shadow_banned' };

  const age = now - player.createdAt;
  if (age < WALLET.minAgeMs) {
    return {
      ok: false,
      code: 'wallet_too_new',
      detail: { readyAt: player.createdAt + WALLET.minAgeMs },
    };
  }

  const standing = rank.rankOf(player.id, now);
  if (rank.ordinalOf(standing.tier) < rank.ordinalOf(WALLET.minTierForCash)) {
    return {
      ok: false,
      code: 'rank_too_low',
      // Told plainly. "Not ranked highly enough" with no number reads as rigged;
      // "two more days" is something a player can act on, and it gives away
      // nothing an attacker could not read in rank.ts.
      detail: {
        tier: standing.tier,
        needed: WALLET.minTierForCash,
        shortfall: standing.shortfall,
      },
    };
  }

  const balance = keys.balance(player.id, now);
  if (balance.remaining <= 0) {
    return {
      ok: false,
      code: 'no_keys_left',
      detail: { perDay: balance.perDay, resetsAt: balance.resetsAt },
    };
  }

  return ALLOWED;
}
