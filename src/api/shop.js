import { get, post } from './http';

/**
 * The shop.
 *
 * The catalogue is served rather than duplicated here on purpose: prices and
 * copy live in one place on the server, so a client that has not been reloaded
 * cannot offer a price we no longer charge.
 */
export const fetchShop = () => get('/shop');

export const buyItem = sku => post(`/shop/${sku}/buy`);

/**
 * Spend a banked refill. Free — it was paid for when it was bought.
 *
 * Not named `useRefill`: React's rules-of-hooks lint treats any `useX` as a
 * hook and refuses to see it called from a callback.
 */
export const spendRefillCredit = () => post('/shop/refill/use');

/**
 * Point a Compass at a treasure. Free, and separate from buying one: choosing
 * at the checkout would mean choosing before you had a reason to prefer any.
 */
export const aimCompass = huntId => post('/shop/compass/aim', { huntId });
