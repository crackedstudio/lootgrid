import { get, post } from './http';
import { sendCall, walletAvailable } from './records';

/**
 * Collecting a prize from LootGridEscrow.
 *
 * ─────────────────────────── two transactions, on purpose ───────────────────
 *
 * `claim` credits the pot to the winner; `withdraw` moves the tokens, and only
 * once the challenge window has elapsed. That gap is not an inconvenience to
 * route around — it is the guardian's only chance to halt a payout signed with
 * a leaked key, and money that is owed but not yet moved is money that can
 * still be stopped.
 *
 * So the UI has two states and says so: *claimed* and *collected*.
 *
 * ─────────────────────────── errors are visible here ────────────────────────
 *
 * Unlike `records.js`, which swallows everything because a missing public log
 * costs nothing, a failure on this path costs a player their prize. Callers
 * surface it.
 */

/**
 * Fetch the referee's payout attestation and send the claim.
 *
 * Returns the transaction hash. Throws if there is no wallet, if the caller is
 * not the winner, or if payouts are switched off server-side — all of which the
 * player needs to be told rather than left to wonder about.
 */
export async function claimPrize(huntId) {
  if (!walletAvailable()) throw new Error('no_wallet');
  const attestation = await post(`/hunts/${encodeURIComponent(huntId)}/attestations/payout`);
  if (!attestation?.call) throw new Error('payouts_disabled');
  return sendCall(attestation.call, { prompt: true });
}

/**
 * What the escrow owes you, read from the chain rather than remembered.
 *
 * The server signed the attestation but never saw the transaction, so only the
 * contract knows whether the claim landed. Returns `null` when payouts are off,
 * which is an ordinary state rather than an error.
 */
export async function fetchPrizeBalance() {
  try {
    return await get('/escrow/balance');
  } catch (err) {
    if (err.code === 'payouts_disabled') return null;
    throw err;
  }
}

/** Move a credited balance to the winner's wallet. Reverts if sent too early. */
export async function withdrawPrize(balance) {
  if (!walletAvailable()) throw new Error('no_wallet');
  if (!balance?.call) throw new Error('nothing_owed');
  return sendCall(balance.call, { prompt: true });
}

/** Seconds until a credited prize becomes collectable. Zero once it is. */
export function secondsUntilCollectable(balance) {
  if (!balance?.withdrawableAt) return 0;
  return Math.max(0, balance.withdrawableAt - Math.floor(Date.now() / 1000));
}

/** "42m" / "58s" — the wait, in the smallest unit that still reads sensibly. */
export function formatWait(seconds) {
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}
