import { post } from './http';
import { activeProvider, publicClient } from './session';

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

/**
 * Optional override, e.g. VITE_FEE_CURRENCY=0x765DE816845861e75A25fCA122bb6898B8B1282a (cUSD).
 * Applied only inside MiniPay — see {@link sendCall}.
 */
const FEE_CURRENCY = import.meta.env.VITE_FEE_CURRENCY || null;

function provider() {
  // The wallet the player chose, not whichever extension won `window.ethereum`.
  try {
    return activeProvider();
  } catch {
    return undefined;
  }
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
 * The address that will pay.
 *
 * `eth_accounts` is the SILENT variant: it lists already-granted accounts and
 * never prompts. That is right for background work — MiniPay connects on load,
 * and a permission dialog interrupting a hunt to publish a game record would be
 * worse than the missing record.
 *
 * It is wrong for anything the player just clicked. MetaMask answers `[]` until
 * it has granted accounts to this page, so a silent `payer()` returned null,
 * `sendCall` returned null WITHOUT SENDING, and the caller carried on as though
 * a transaction had been made. That is what produced a "create vault" that
 * created nothing and a run of `no_vault_on_chain`.
 *
 * So: prompt when a human is waiting, stay silent when nobody is.
 */
async function payer(prompt = false) {
  const eth = provider();
  if (!eth) return null;
  try {
    const accounts = await eth.request({ method: 'eth_accounts' });
    if (accounts?.[0]) return accounts[0];
    if (!prompt) return null;
    const granted = await eth.request({ method: 'eth_requestAccounts' });
    return granted?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Send a server-encoded call. Resolves to a transaction hash, or `null` when
 * there is no wallet to send it with.
 *
 * Exported because the hint market needs the same wallet plumbing for a very
 * different purpose. Note the difference in how the two use it: publishing a
 * record swallows every failure, because a missing log costs nothing. Funding a
 * trade must not — a payment that silently fails to send is a player staring at
 * a hint they think they bought. Callers there surface the error.
 */
export async function sendCall(call, { wait = true, prompt = false } = {}) {
  const eth = provider();
  const from = await payer(prompt);
  // Callers that prompted have a human waiting on a result, so "no wallet" is an
  // error rather than a shrug. Returning null to them is how a skipped
  // transaction gets mistaken for a completed one.
  if (!eth || !from) {
    if (prompt) throw new Error('No wallet account available — connect your wallet and retry.');
    return null;
  }

  const tx = {
    from,
    to: call.to,
    data: call.data,
    gas: call.gas,
    // `feeCurrency` is a Celo extension for paying gas in a stablecoin. ONLY
    // MiniPay understands it — MetaMask and every generic wallet either reject
    // the unknown field or drop it, and a dropped one means the player is
    // charged in CELO while believing they are not. Sent only where it works.
    ...(FEE_CURRENCY && isMiniPay() ? { feeCurrency: FEE_CURRENCY } : {}),
  };

  const hash = await eth.request({ method: 'eth_sendTransaction', params: [tx] });
  if (!wait || !hash) return hash;

  // `eth_sendTransaction` resolves the moment the wallet BROADCASTS. Callers
  // that then read the chain — `attachVault` most of all — were racing a
  // transaction that had not been mined, which is what produced a run of
  // `no_vault_on_chain` 409s and a vault the server never learned about.
  //
  // A revert is surfaced here rather than left to look like a missing vault.
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const err = new Error('The transaction failed on chain.');
    err.hash = hash;
    throw err;
  }
  return hash;
}

const send = sendCall;

/**
 * Sign server-built EIP-712 typed data. Resolves to a signature, or `null` when
 * there is no wallet or the player declines.
 *
 * The entry-fee path uses this: an x402 payment is an EIP-3009 authorisation,
 * so the wallet signs rather than sends, and the token contract moves the funds
 * later. One prompt, no gas, no transaction of our own.
 *
 * `eth_signTypedData_v4` takes the payload as a JSON *string*, which is easy to
 * get wrong by passing the object.
 */
export async function signTypedData(typedData) {
  const eth = provider();
  const from = await payer();
  if (!eth || !from) return null;

  return eth.request({
    method: 'eth_signTypedData_v4',
    params: [from, JSON.stringify(typedData)],
  });
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
    // No receipt wait and no prompt: this is fire-and-forget. Blocking a race on
    // a block confirmation to publish a cosmetic record would trade the thing
    // that matters for the thing that does not.
    return await send(attestation.call, { wait: false });
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
