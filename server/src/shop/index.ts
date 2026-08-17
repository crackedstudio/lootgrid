import { ENERGY, PASS } from '../config';
import * as shopRepo from '../db/repos/shop';
import * as energy from '../energy';
import { randomHex } from '../hash';
import { logger } from '../logger';
import * as metrics from '../metrics';
import * as store from '../store';
import type { Player } from '../types';
import { CATALOGUE, itemFor, type Grant, type ShopItem } from './catalogue';

export { CATALOGUE, itemFor } from './catalogue';
export type { Grant, ShopItem, ShopCategory } from './catalogue';

/**
 * Selling things, and the one thing that is never for sale.
 *
 * ─────────────────────────── what the business actually is ──────────────────
 *
 * Worth stating here because it decides what gets instrumented. Ranked by the
 * review, cheapest claim first:
 *
 *   3. Our rake on player-to-player hint trades. **Not revenue.** It is a
 *      market-health tool — eight thousand trades to make ten dollars.
 *   2. Hints we sell ourselves. Real money at near-pure margin, and gated on an
 *      honesty precondition that is not yet met (see catalogue.ts).
 *   1. **Energy burned manufacturing hints to sell.** This is the business.
 *
 * The reason (1) has no ceiling is the two-currency split: a player buying
 * energy to *compete* is capped at five keys a day, and a player buying energy
 * to *supply the market* is capped by nothing at all.
 *
 * Which is why the Compass matters more than its ten cents suggests, and why
 * every SKU is counted separately from day one. If refill revenue dwarfs
 * Compass revenue forever, the thesis above is wrong and we should find that
 * out from a counter rather than from an argument.
 */

export interface PurchaseResult {
  sku: string;
  priceCents: number;
  /** What the player has now, so the client never has to guess. */
  energy: ReturnType<typeof energy.view>;
  entitlements: shopRepo.Entitlement[];
}

/**
 * Apply what was bought.
 *
 * Deliberately takes the already-validated item rather than a sku string: the
 * price must have been settled against the same object whose grant is applied,
 * or a race between a catalogue edit and a payment could charge for one thing
 * and deliver another.
 */
function applyGrant(player: Player, grant: Grant, now: number): void {
  switch (grant.kind) {
    case 'energy': {
      // `refund` is the capped top-up path — it will not push a bar past max,
      // and it preserves partial regen progress.
      energy.refund(player, grant.amount, now);
      store.savePlayerEnergy(player);
      return;
    }
    case 'refillCredits':
      shopRepo.grant(player.id, 'refillCredits', { remaining: grant.count }, now);
      return;
    case 'pass': {
      // Extends from wherever the current pass ends rather than from now, so
      // buying a second one while the first is live is never a loss.
      const from = player.passUntil !== null && player.passUntil > now ? player.passUntil : now;
      const until = from + grant.days * PASS.dayMs;
      // Written to BOTH: the player row is what the energy math reads on the
      // hot path, the entitlement row is what the shop lists. See migration 017.
      store.setPass(player, until);
      shopRepo.grant(player.id, 'pass', { expiresAt: until }, now);
      return;
    }
    case 'compass':
      // No target yet. Pointing it is a separate, free act — see `aim`. Selling
      // a Compass that had to be aimed at purchase time would mean choosing a
      // treasure before you had any reason to prefer one.
      shopRepo.grant(player.id, 'compass', { remaining: grant.hints }, now);
      return;
    case 'cosmetic':
      // No cosmetic layer exists yet; the member is here so the shape is
      // settled. Recorded as a purchase, applied as nothing.
      return;
  }
}

/**
 * Complete a purchase that has already been paid for.
 *
 * `paymentRef` is whatever the rail gave us, or null in dev where the shop runs
 * without a facilitator. The purchase row is written either way, because the
 * payout ratio is computed from it and a gap would silently flatter us.
 */
export function fulfil(
  player: Player,
  item: ShopItem,
  paymentRef: string | null,
  now = Date.now(),
): PurchaseResult {
  shopRepo.recordPurchase({
    id: `pur_${randomHex(10)}`,
    playerId: player.id,
    sku: item.sku,
    // As charged, never re-read from the catalogue later. Prices move.
    priceCents: item.priceCents,
    paymentRef,
    createdAt: now,
  });

  applyGrant(player, item.grant, now);

  // Per SKU and per category, not one lump. See the header: the whole business
  // thesis is a claim about WHICH of these sells, and a single revenue counter
  // could not falsify it.
  metrics.shopPurchases.inc({ sku: item.sku, category: item.category });
  metrics.shopRevenueCents.inc({ sku: item.sku, category: item.category }, item.priceCents);

  logger.info({ playerId: player.id, sku: item.sku, cents: item.priceCents }, 'purchase fulfilled');

  return {
    sku: item.sku,
    priceCents: item.priceCents,
    energy: energy.view(player, now),
    entitlements: shopRepo.activeFor(player.id, now),
  };
}

// ─────────────────────────── refill credits ───────────────────────────

/** Spend one banked refill. Returns false when there are none. */
export function useRefillCredit(player: Player, now = Date.now()): boolean {
  const held = shopRepo.entitlement(player.id, 'refillCredits', now);
  if (!held || held.remaining <= 0) return false;

  shopRepo.setRemaining(player.id, 'refillCredits', held.remaining - 1, now);
  energy.refund(player, ENERGY.max, now);
  store.savePlayerEnergy(player);
  metrics.shopCreditsUsed.inc();
  return true;
}

// ─────────────────────────── the compass ───────────────────────────

/**
 * Point a Compass at a treasure.
 *
 * Free, and separate from buying one. A Compass that had to be aimed at the
 * checkout would mean choosing a treasure before you had a reason to prefer
 * any — which is the opposite of what targeting is worth.
 */
export function aim(playerId: string, huntId: string, now = Date.now()): boolean {
  const held = shopRepo.entitlement(playerId, 'compass', now);
  if (!held || held.remaining <= 0) return false;
  shopRepo.setTarget(playerId, 'compass', huntId, now);
  return true;
}

/**
 * Which hunt this player's hints should be about, or null for the default.
 *
 * ─────────────────────────── §0-B, decided ───────────────────────────
 *
 * This is the deliberate invariant the plan flagged. `awardForReveal` used to
 * scatter hints across every live hunt so that "a player cannot steer their
 * hints towards a hunt they have already narrowed down"; phase 3 replaced that
 * with proximity, on the review's own rule that a *dug* hint is about whatever
 * is nearest. What was left open is whether a player may choose a target
 * WITHOUT digging near it. This says yes, and charges for it.
 *
 * Three things make that safe, and all three already exist:
 *
 *   * You still have to dig. A Compass redirects hints; it does not produce
 *     them. Every hint it aims still costs the energy that turns it up, which
 *     is exactly why the review calls it the only item that makes another item
 *     sell more.
 *   * Information is capped at 25% of the prize, in `market/pricing.ts`.
 *   * **It costs you the close ones.** The Crack's tiebreak ranks on hints
 *     HELD about the hunt, so five aimed hints are five points of tiebreak
 *     debt. A player who bought their way to the answer loses to one who did
 *     not, which is anti-pay-to-win rule 3 doing its work without a special
 *     case anywhere.
 *
 * Returns null once the charges run out, at which point hints go back to being
 * about whatever is nearest.
 */
export function targetFor(playerId: string, now = Date.now()): string | null {
  const held = shopRepo.entitlement(playerId, 'compass', now);
  if (!held || held.remaining <= 0) return null;
  return held.targetId;
}

/** Burn one Compass charge. Called only when an aimed hint was actually granted. */
export function consumeCharge(playerId: string, now = Date.now()): void {
  const held = shopRepo.entitlement(playerId, 'compass', now);
  if (!held || held.remaining <= 0) return;

  const left = held.remaining - 1;
  shopRepo.setRemaining(playerId, 'compass', left, now);
  metrics.compassHintsAimed.inc();
  // Clear the aim when it runs out, so a stale target cannot silently steer a
  // later Compass the player has not aimed yet.
  if (left <= 0) shopRepo.setTarget(playerId, 'compass', null, now);
}

// ─────────────────────────── the pass ───────────────────────────

export const hasPass = (playerId: string, now = Date.now()): boolean =>
  shopRepo.entitlement(playerId, 'pass', now) !== null;

/**
 * Take the pass's daily top-up, if one is owed.
 *
 * **Claimed, never pushed.** A scheduler that credits energy to sleeping
 * accounts is a scheduler that has to be right about time zones and restarts
 * forever; this runs when the player shows up, which is the only moment the
 * energy is worth anything to them anyway.
 *
 * Returns true when a top-up was taken, so the caller can say so.
 */
export function claimDailyTopUp(player: Player, now = Date.now()): boolean {
  if (!PASS.dailyTopUp) return false;
  if (player.passUntil === null || player.passUntil <= now) return false;

  const today = Math.floor(now / PASS.dayMs);
  const last = player.passToppedUpAt === null ? -1 : Math.floor(player.passToppedUpAt / PASS.dayMs);
  if (last >= today) return false;

  store.setPassToppedUp(player, now);
  energy.refund(player, ENERGY.max, now);
  store.savePlayerEnergy(player);
  metrics.passTopUps.inc();
  return true;
}

/** Everything a client needs to render the shop and what the player holds. */
export function stateFor(playerId: string, now = Date.now()) {
  return {
    catalogue: CATALOGUE,
    entitlements: shopRepo.activeFor(playerId, now),
    pass: hasPass(playerId, now),
  };
}
