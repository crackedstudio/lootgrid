import { encodeFunctionData, parseAbi } from 'viem';
import { get, post, put } from './http';
import { sendCall, walletAvailable } from './records';
import { publicClient } from './session';
import { ApiError } from './http';
import { signPayment } from './entry';
import { TOKEN_ADDRESS, TOKEN_DECIMALS, TOKEN_SYMBOL } from './config';

const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/**
 * The player's agent.
 *
 * ─────────────────────────── who signs what ───────────────────────────
 *
 * Every transaction here is the player's. The server derives the agent key,
 * proves it consents to being bound, and encodes calldata — but binding the
 * agent, creating the vault, changing a cap, revoking and withdrawing are all
 * signed by the wallet in front of you. Nothing in this file asks the server to
 * move money, because the server cannot.
 *
 * ─────────────────────────── the honest bit about kill ──────────────────────
 *
 * `stopAgent` does two things and only one of them is instant. The server stops
 * giving the agent turns straight away; revoking its *on-chain* spending rights
 * is a transaction the player has to send. Until that lands the agent can still
 * spend, within its caps, and the UI says so rather than showing a tick.
 */

export const fetchAgent = () => get('/agent').then(r => r.agent);
export const fetchLedger = () => get('/agent/ledger');

/**
 * What the agent has been playing, move by move.
 *
 * The ledger says what it spent; this says what it did. An agent you cannot
 * watch is indistinguishable from a broken one — which is exactly how a working
 * agent read until this existed.
 */
export const fetchActivity = () => get('/agent/activity');

/** A one-line summary of a module's state, for the activity feed. */
export function describeState(game, state) {
  if (!state) return null;
  const s = typeof state === 'string' ? safeParse(state) : state;
  if (!s) return null;
  if (game === 'negotiation') {
    return s.closed
      ? `settled — kept ${((s.keptBps ?? 0) / 100).toFixed(0)}%`
      : `round ${s.round ?? 0} — asking ${((s.askBps ?? 0) / 100).toFixed(0)}%`;
  }
  if (game === 'deduction') {
    const used = s.used ?? (s.answers?.length ?? 0);
    return `${used} probes used`;
  }
  if (game === 'search') return `${s.probes?.length ?? 0} cells probed`;
  return null;
}

function safeParse(v) {
  try { return JSON.parse(v); } catch { return null; }
}

export const configureAgent = patch => put('/agent/config', patch).then(r => r.agent);

/**
 * Bring an agent to life: create its vault, and tell the server about it.
 *
 * ─────────────────────────── why `bind` is NOT sent ─────────────────────────
 *
 * `/agent/setup` also returns a `bind` call that would register the agent as
 * this player's session key. Sending it is actively harmful, for two reasons.
 *
 * It buys the agent nothing. A session key exists to authenticate HTTP requests
 * to the referee, and the agent never makes any — the driver runs inside the
 * server, and it spends from the vault by signing transactions directly with its
 * derived key (`vaultChain.sendAsAgent`). Neither path consults the registry.
 *
 * And `PlayerRegistry.bind` allows exactly one session key per player, replacing
 * whatever was there. So binding the agent REVOKES this browser's key: every
 * subsequent request fails to verify, and the player can no longer change a cap,
 * stop the agent, or withdraw from their own vault. The old flow sent bind first
 * and then called `attachVault()` — a request the browser had, one line earlier,
 * lost the ability to sign.
 *
 * The kill switch survives regardless, because it is an on-chain call the wallet
 * sends, not an API request. But locking a player out of their own controls to
 * gain nothing is not a trade worth making.
 */
export async function setupAgent() {
  if (!walletAvailable()) throw new Error('no_wallet');

  const offer = await post('/agent/setup');
  // `prompt` because a human just pressed a button: MetaMask answers
  // `eth_accounts` with [] until it has granted this page an account, and a
  // silent send would return null having done nothing at all.
  const hash = await sendCall(offer.createVault, { prompt: true });
  if (!hash) throw new Error('The vault transaction was not sent.');

  // Close the loop: without this the vault exists on chain and the server never
  // learns of it, so the screen reads "Not funded" forever. `sendCall` has
  // already waited for the receipt, so this is a read of settled state.
  const agent = await attachVault();

  return { agent, hash, caps: offer.caps };
}

/**
 * Ask the server to find the vault on chain.
 *
 * Sends no address on purpose — the server reads it from the factory. One the
 * client could supply would be one the server then lets an agent spend against.
 *
 * Retries, because forno.celo.org is load-balanced: the read that follows a
 * creation lands on whichever node answers, and one that has not seen the block
 * yet reports no vault. Measured live — the first attempt returned 409
 * `no_vault_on_chain` and the second succeeded. Without this the vault exists,
 * the server never learns of it, and the screen reads "Not funded" forever.
 */
export async function attachVault(tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await post('/agent/vault').then(r => r.agent);
    } catch (err) {
      last = err;
      if (err?.code !== 'no_vault_on_chain') throw err;
      await new Promise(r => setTimeout(r, 2500));
    }
  }
  throw last;
}

/**
 * Stop the agent here, and hand back the transaction that stops it on chain.
 *
 * Returns `{ stoppedHere, call }`. Callers must send `call` and must not report
 * the agent as revoked until it lands.
 */
export const stopAgent = () => post('/agent/kill');

export const resumeAgent = () => post('/agent/resume').then(r => r.agent);

/**
 * Stop hunting for now, keeping the vault and the on-chain rights.
 *
 * Not `stopAgent` — that one revokes spending rights on chain and only the
 * player can grant them again, which is an incident action rather than a
 * change of mind. This is one tap each way.
 */
export const pauseAgent = () => post('/agent/pause').then(r => r.agent);

/**
 * Send a call the server already prepared — the kill transaction handed back by
 * {@link stopAgent}.
 *
 * Separate from `vaultAction` because that one asks the server to build a call
 * first, and the whole point of the kill path is that the transaction is already
 * in the player's hands the moment they press stop. One fewer round trip on the
 * one action that happens during an incident.
 */
export function sendPrepared(call) {
  if (!call) return Promise.resolve(null);
  if (!walletAvailable()) throw new Error('no_wallet');
  return sendCall(call, { prompt: true });
}

/** Owner-only vault transactions. Encoded server-side, signed by the player. */
export async function vaultAction(action, args) {
  if (!walletAvailable()) throw new Error('no_wallet');
  const { call } = await post(`/agent/vault/${encodeURIComponent(action)}`, args);
  return sendCall(call, { prompt: true });
}

// ─────────────────────────── the funded seat ────────────────────────────────

/**
 * What a seat costs and what it buys. Free to ask.
 *
 * The payload deliberately carries `doesNotBuy` and `freeAlternative` as well as
 * the price, so a purchase screen cannot honestly render this as buying access.
 * A seat pays for the model calls the house makes on your behalf — nothing else.
 * An agent without one enters the same hunts for the same prizes, playing its
 * deterministic strategy instead.
 */
export const fetchSeat = () => get('/agent/seat');

/**
 * Buy inference credit, via the same x402 round trip as an entry fee.
 *
 * `onQuote` is called with the terms BEFORE the wallet is prompted, so the
 * player can read what they are buying and decline. Nobody should be charged by
 * a screen they did not read — and here that matters more than usual, because
 * the thing being sold is easy to mistake for a ticket.
 */
export async function buySeat({ onQuote } = {}) {
  try {
    return await post('/agent/seat');
  } catch (err) {
    if (!(err instanceof ApiError) || !err.paymentRequired) throw err;

    const terms = err.payment;
    if (onQuote && (await onQuote(terms)) === false) return null;

    const header = await signPayment(terms);
    // Same URL, same method, plus the payment. A second 402 means refused
    // rather than missing.
    return post('/agent/seat', undefined, { payment: header });
  }
}

// ─────────────────────────── funding the vault ──────────────────────────────

/**
 * What the agent can actually spend.
 *
 * Read from the token contract rather than the server, because the vault's
 * balance is a fact about the chain and the server is not the authority on it.
 * A server-reported balance would also go stale the moment the agent spends.
 */
export async function fetchVaultBalance(vault) {
  if (!vault) return 0n;
  return publicClient().readContract({
    address: TOKEN_ADDRESS, abi: ERC20, functionName: 'balanceOf', args: [vault],
  });
}

/**
 * Move money from the player's wallet into their own vault.
 *
 * A plain ERC20 transfer, deliberately: the vault is the player's, `withdrawAll`
 * is theirs alone, and the agent may only ever spend within the per-transaction
 * and per-day caps written into the contract at creation. Nothing here grants
 * the house anything — this is not a fee, it is the player moving their own
 * money somewhere their agent can reach it.
 */
export async function fundVault(vault, amount) {
  if (!vault) throw new Error('No vault yet — create one first.');
  if (!walletAvailable()) throw new Error('no_wallet');
  return sendCall({
    to: TOKEN_ADDRESS,
    data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [vault, amount] }),
  }, { prompt: true });
}

/** Human amount → raw units. Uses the configured decimals, never a hardcoded 18. */
export const toRaw = human => BigInt(Math.round(human * 10 ** TOKEN_DECIMALS));

export const formatToken = raw =>
  `${(Number(raw) / 10 ** TOKEN_DECIMALS).toFixed(2)} ${TOKEN_SYMBOL}`;

// ─────────────────────────── presentation ───────────────────────────

/** Mills are thousandths of a cent — see the server's budget module. */
export const millsToUsd = mills => `$${(mills / 100_000).toFixed(4)}`;

export const centsToUsd = cents => `$${(cents / 100).toFixed(2)}`;

export function statusLabel(agent) {
  if (!agent) return 'None';
  if (agent.status === 'killed') return 'Stopped';
  if (agent.status === 'paused') return 'Paused';
  if (!agent.vault) return 'Not funded';
  return 'Running';
}

/**
 * Which zones the agent may play.
 *
 * NOT in {@link CONFIG_FIELDS} because it is a set of ids rather than a number,
 * and it needs the zone list to render. It is nonetheless the single most
 * important setting: `zones` defaults to EMPTY, and an empty list means no
 * zones — never all zones — so an agent configured through the UI without it
 * sits idle forever while looking perfectly healthy.
 *
 * Only agent zones are offerable. The driver skips every human zone regardless,
 * so listing one would be a control that silently does nothing.
 */
export const fetchAgentZones = () =>
  get('/zones').then(r => (r.zones ?? []).filter(z => z.kind === 'agent'));

/**
 * The config fields a player may change, with their bounds.
 *
 * Every one is a number, and that is deliberate rather than a limitation: a
 * free-text instruction field would be a string a player controls reaching a
 * model that can spend their money.
 */
export const CONFIG_FIELDS = [
  { key: 'aggression', label: 'AGGRESSION', min: 0, max: 100, help: 'How boldly it bids on hints.' },
  { key: 'maxHintPriceCents', label: 'MAX PER HINT', min: 1, max: 500, unit: 'c' },
  { key: 'dailyBudgetCents', label: 'DAILY BUDGET', min: 1, max: 5000, unit: 'c' },
  { key: 'minReliabilityBps', label: 'MIN RELIABILITY', min: 0, max: 10000, unit: 'bps' },
];
