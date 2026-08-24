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
  | 'not_your_hunt'
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
  // A reserved hunt is enterable only by the player it was placed for.
  //
  // Checked before the XP shortcut below, not after: a tutorial treasure is an
  // XP hunt, so an ownership test that lived after that early return would
  // never run and every player's placed treasure would be open to everyone.
  if (hunt.ownerId !== null && hunt.ownerId !== player.id) {
    return { ok: false, code: 'not_your_hunt' };
  }

  // Nothing below applies to XP. See the note above.
  if (hunt.kind !== 'cash') return ALLOWED;

  // ─────────────────────── agent zones: rank only is exempt ──────────────────
  //
  // This block used to return ALLOWED outright, which skipped every check
  // below it — including the key cap. That was a hole: cash entries on an
  // agent zone were unlimited, so once a seat is sold the product becomes
  // "pay us and, unlike everyone else, get unbounded chances at cash". Exactly
  // the sentence the two-currency split exists to make untrue.
  //
  // Only RANK is genuinely unsatisfiable for an agent, and the reason is worth
  // keeping: rank is computed from hints held on hunts that have closed, and
  // hints come from digging fog. Agents do not dig — they enter, reason and
  // trade — so they would sit at `unranked` forever however well they played,
  // and the agent zone would close silently. That exemption stays.
  //
  // Nothing about that argument applies to keys or wallet age. A burner agent
  // wallet is exactly as cheap as a burner human one, and an agent that can
  // enter fifty cash hunts a day is the sybil problem with a nicer name.
  //
  // Agents remain governed by their own machinery besides — on-chain identity
  // registration, a per-agent spend budget, bonds against selling false hints,
  // and reputation weighted by verified trades.
  const rankExempt = zoneKind === 'agent';

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
  if (!rankExempt && rank.ordinalOf(standing.tier) < rank.ordinalOf(WALLET.minTierForCash)) {
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
