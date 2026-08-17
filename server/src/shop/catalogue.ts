import { ENERGY } from '../config';

/**
 * What may be sold, and the line that cannot be crossed.
 *
 * ─────────────────────────── the four rules ───────────────────────────
 *
 * Every future money-making idea gets tested against these, and they are the
 * reason this file is a closed catalogue rather than a database table someone
 * can insert into:
 *
 *   1. Money never buys a key, an entry, or a retry. Five shots a day, for
 *      everyone alive.
 *   2. Information is capped at 25% of the prize. Buy every hint and you still
 *      have to win.
 *   3. The tiebreak rewards using fewer hints — so spending actively costs you
 *      the close ones.
 *   4. The finale is skill-decided and hint sales are closed by then.
 *
 * ─────────────────────────── how rule 1 is enforced ─────────────────────────
 *
 * Not by anyone remembering it. {@link Grant} has no member that could produce
 * an entry, and it never will, because there is nothing for such a member to
 * write to: a key is a **count of cash attempts already recorded today**
 * subtracted from a constant (keys.ts). There is no balance to credit, so a
 * shop item that granted one could not be implemented even by someone trying.
 *
 * That is the strongest form this rule can take. A `grantKeys()` function
 * guarded by a comment would be one careless caller away from undoing the whole
 * legal argument — money buys information and exploration, never a chance at a
 * prize, and that is the sentence handed to a lawyer.
 *
 * ─────────────────────────── what each category is ──────────────────────────
 *
 *   speed      energy and faster refills. Buys attempts at *finding*, never at
 *              *winning*. The volume product.
 *   targeting  which treasure your hints concern. Scarce, and it makes energy
 *              sell more — you still have to dig to cash it in.
 *   cosmetic   status. Sells nothing that touches the game.
 *
 * Information — hints and scout reports — is deliberately absent. It is sold
 * player-to-player through the market, which already caps it at 25% of the
 * prize and takes a rake. A house-sold hint is legitimate but has a hard
 * precondition (§5f: only from a set locked in before anyone entered, revealed
 * true or false after) and belongs with the sponsor work, not here.
 */

export type ShopCategory = 'speed' | 'targeting' | 'cosmetic';

/**
 * What a purchase does.
 *
 * Read the members and note what is missing: nothing here grants an entry, a
 * key, a retry, or a second attempt at anything. See the header.
 */
export type Grant =
  /** Energy, immediately. Capped at the bar like every other refund. */
  | { kind: 'energy'; amount: number }
  /** Refills the player triggers later. Energy in a drawer, not entries. */
  | { kind: 'refillCredits'; count: number }
  /** Faster regen and a daily top-up, for a while. */
  | { kind: 'pass'; days: number }
  /** The next N hints concern a treasure the player picks. */
  | { kind: 'compass'; hints: number }
  /** Pure decoration. */
  | { kind: 'cosmetic'; id: string };

export interface ShopItem {
  sku: string;
  name: string;
  blurb: string;
  priceCents: number;
  category: ShopCategory;
  grant: Grant;
}

/**
 * The catalogue.
 *
 * ─────────────────────────── cheap and frequent ───────────────────────────
 *
 * These prices look wrong for a mobile game and are deliberate. App store
 * billing has a practical floor near a dollar and takes 30%, so the standard
 * play is one 99-cent buyer in a hundred. MiniPay users already hold digital
 * dollars and pay in one tap: we can charge five cents and keep five cents. The
 * target is ten five-cent buyers in a hundred, not one big one.
 *
 * A price here is never raised for repeat buyers. A spender's third purchase
 * costs what their first did, or it reads as punishment.
 */
export const CATALOGUE: ShopItem[] = [
  {
    sku: 'refill',
    name: 'ENERGY REFILL',
    blurb: 'Fill the bar now.',
    priceCents: 5,
    category: 'speed',
    grant: { kind: 'energy', amount: ENERGY.max },
  },
  {
    sku: 'refill5',
    name: '5 REFILLS',
    blurb: 'Five, banked. Use them when you are actually stuck.',
    priceCents: 20,
    category: 'speed',
    grant: { kind: 'refillCredits', count: 5 },
  },
  {
    /**
     * The revenue backbone, and the only subscription-shaped thing here.
     *
     * Three days is one cycle, so it expires exactly when the map does — a pass
     * that straddled a reset would be selling speed on a board that no longer
     * exists.
     */
    sku: 'cyclepass',
    name: 'CYCLE PASS',
    blurb: 'Three days: double refill speed, and a full bar every morning.',
    priceCents: 50,
    category: 'speed',
    grant: { kind: 'pass', days: 3 },
  },
  {
    /**
     * The sleeper hit, per the review, and the reasoning holds up: it sells the
     * scarce thing while *requiring* energy to cash in. It is the only item
     * that makes another item sell more.
     */
    sku: 'compass',
    name: "PROSPECTOR'S COMPASS",
    blurb: 'Your next 5 hints all concern one treasure — you choose which.',
    priceCents: 10,
    category: 'targeting',
    grant: { kind: 'compass', hints: 5 },
  },
];

export const itemFor = (sku: string): ShopItem | undefined =>
  CATALOGUE.find(i => i.sku === sku);

/**
 * Items the review lists that are deliberately NOT here yet, and why.
 *
 * Kept as a note rather than as commented-out entries, so nobody ships one by
 * deleting a comment.
 *
 *   **More hint slots.** There is no cap on hints held, so this has nothing to
 *   sell. Adding a cap in order to sell relief from it is taking something away
 *   and charging to give it back — the same move as raising prices on repeat
 *   buyers, which §5g rules out for the same reason. If seller inventory turns
 *   out to need managing, the cap should be justified by that, not by the SKU.
 *
 *   **Post-game report card.** Wants hint accuracy per player per hunt, which
 *   `attempts.hints_used` and the revealed sets now make computable. Real, and
 *   it is a build rather than a config line.
 *
 *   **Skins, themes, winner's mark.** No cosmetic layer exists to attach them
 *   to. `Grant` carries the member so the shape is settled.
 *
 *   **House scout reports.** Legitimate, with a hard precondition: only from a
 *   set locked in before anyone entered and revealed true-or-false afterwards.
 *   The commitment machinery for that already exists — see hints/commit.ts —
 *   but selling information the house also controls needs the sponsor and
 *   audit story around it, not just a price.
 */
export const NOT_YET_SOLD = ['hintSlots', 'reportCard', 'cosmetics', 'houseScoutReport'] as const;
