import { ApiError, post } from './http';
import { signTypedData, walletAvailable } from './records';

/**
 * Entering a hunt, including the part where you pay for it.
 *
 * ─────────────────────────── the x402 round trip ───────────────────────────
 *
 *   POST /hunts/:id/attempts          →  402, with terms and a payload to sign
 *   eth_signTypedData_v4              →  one wallet prompt
 *   POST the same URL + X-PAYMENT     →  200, you are in
 *
 * The retry is the same request with one extra header. That is the whole
 * protocol, and it is why the payment path does not need its own endpoint.
 *
 * ─────────────────────────── the client signs, and knows nothing ────────────
 *
 * The payload comes from the server ready to sign — domain, types, message,
 * and the envelope to put the signature back into. The browser holds no web3
 * library, no ABI and no token addresses, exactly as it holds no ABI for the
 * attestation calls. Nothing is conceded by trusting it: the signature only
 * authorises moving the stated amount to the stated recipient, and the server
 * re-derives both from its own terms before settling.
 *
 * ─────────────────────────── energy comes first ───────────────────────────
 *
 * A player with energy never sees any of this. The server tries the free route
 * before it quotes a price, so the 402 only ever appears once energy is spent —
 * which keeps a no-cost path to every prize.
 */

const ENTRY_PATH = id => `/hunts/${encodeURIComponent(id)}/attempts`;

/**
 * Enter a hunt, paying only if asked.
 *
 * `onQuote` is called with the terms before the wallet is prompted, so the UI
 * can show the price and let the player decline. Returning false from it
 * abandons the entry — nobody should be charged by a screen they did not read.
 */
export async function enterHunt(huntId, { onQuote } = {}) {
  try {
    return await post(ENTRY_PATH(huntId));
  } catch (err) {
    if (!(err instanceof ApiError) || !err.paymentRequired) throw err;

    const terms = err.payment;
    if (onQuote && (await onQuote(terms)) === false) return null;

    const header = await signPayment(terms);
    // Same URL, same method, plus the payment. A second 402 here means the
    // payment was refused rather than missing, and is surfaced as an error.
    return post(ENTRY_PATH(huntId), undefined, { payment: header });
  }
}

/**
 * Sign the server's payload and pack it into an X-PAYMENT header.
 *
 * The envelope is returned complete but for `payload.signature`; filling that
 * in and base64-encoding is the entire client-side contribution to the wire
 * format, which is why it is worth keeping in one small function.
 */
export async function signPayment(terms) {
  if (!walletAvailable()) throw new ApiError('no_wallet', 0, null);

  const signature = await signTypedData(terms.typedData);
  if (!signature) throw new ApiError('signature_refused', 0, null);

  const envelope = {
    ...terms.envelope,
    payload: { ...terms.envelope.payload, signature },
  };
  return base64(JSON.stringify(envelope));
}

/** UTF-8 safe: `btoa` alone throws on anything above U+00FF. */
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** "$0.10" — already formatted by the server, with a fallback. */
export const priceOf = terms => terms?.price ?? '—';
