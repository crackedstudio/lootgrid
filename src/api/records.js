import { post } from './http';

/**
 * Publishes the player's own hunt entries and wins to LootGridActions, paid for
 * by the player in a Celo fee currency.
 *
 * ─────────────────────────── the one hard rule ───────────────────────────
 *
 *   **Gameplay never waits on this.**
 *
 * Same rule the server's relayer follows. Every function here resolves to a
 * transaction hash or `null` and never throws: the referee has already decided
 * the outcome, and a public record is worth having but not worth a stalled UI,
 * a blocked hunt, or an error thrown at a player whose wallet happens to be
 * empty. Call them and move on; do not await them in a render path.
 *
 * ─────────────────────────── why the server encodes ───────────────────────────
 *
 * The attestation response carries a ready-made `call` — `to`, `data`, `gas`.
 * The client holds no ABI and no web3 library, so nothing here has to encode a
 * dynamic `bytes` argument by hand in a wallet webview. Nothing is conceded by
 * trusting it either: every field is already covered by the referee's signature,
 * so tampered calldata simply fails to verify on chain.
 *
 * ─────────────────────────── fee currency ───────────────────────────
 *
 * MiniPay wallets typically hold stablecoins and no CELO, so a plain
 * native-gas transaction would be unpayable. Celo lets gas be charged in
 * whitelisted ERC-20s via the `feeCurrency` transaction field. MiniPay fills
 * this in itself, so we only set it when an explicit address is configured —
 * guessing wrong is worse than leaving it to the wallet.
 */

/** Optional override, e.g. VITE_FEE_CURRENCY=0x765DE816845861e75A25fCA122bb6898B8B1282a (cUSD). */
const FEE_CURRENCY = import.meta.env.VITE_FEE_CURRENCY || null;

function provider() {
  return typeof window !== 'undefined' ? window.ethereum : undefined;
}

/** Whether a wallet capable of sending the transaction is present. */
export function walletAvailable() {
  return Boolean(provider());
}

/** True inside MiniPay, which pays gas in stablecoins without being asked. */
export function isMiniPay() {
  return Boolean(provider()?.isMiniPay);
}

/**
 * The address that will pay. Uses `eth_accounts`, which returns already-granted
 * accounts without prompting — MiniPay connects on load, and a silent no-op is
 * better than a permission dialog interrupting a hunt.
 */
async function payer() {
  const eth = provider();
  if (!eth) return null;
  try {
    const accounts = await eth.request({ method: 'eth_accounts' });
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

async function send(call) {
  const eth = provider();
  const from = await payer();
  if (!eth || !from) return null;

  const tx = {
    from,
    to: call.to,
    data: call.data,
    gas: call.gas,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
  };

  return eth.request({ method: 'eth_sendTransaction', params: [tx] });
}

/**
 * Fetch an attestation and submit it.
 *
 * Returns the transaction hash, or `null` when there is nothing to do — no
 * wallet, attestations switched off server-side, the player rejecting the
 * prompt, or an empty balance. All of those are ordinary, so none of them throw.
 */
async function publish(path, label) {
  try {
    const attestation = await post(path);
    if (!attestation?.call) return null;
    return await send(attestation.call);
  } catch (err) {
    // Deliberately swallowed. A missing public record is a cosmetic loss; a
    // thrown error here would surface in the middle of a race.
    if (import.meta.env.DEV) console.warn(`[records] ${label} not published:`, err);
    return null;
  }
}

/** Publish "I entered this hunt". Safe to call and ignore. */
export function publishEntry(huntId) {
  return publish(`/hunts/${encodeURIComponent(huntId)}/attestations/entry`, 'entry');
}

/**
 * Publish "I won this hunt". Only the winner of a resolved hunt gets an
 * attestation; for anyone else the server refuses and this resolves to `null`.
 */
export function publishWin(huntId) {
  return publish(`/hunts/${encodeURIComponent(huntId)}/attestations/resolution`, 'resolution');
}
