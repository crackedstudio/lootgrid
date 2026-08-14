import { get, post, put } from './http';
import { sendCall, walletAvailable } from './records';

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

export const configureAgent = patch => put('/agent/config', patch).then(r => r.agent);

/**
 * Bring an agent to life: bind it, then create its vault.
 *
 * Sequential and both awaited. The vault names the agent as its spender, so
 * creating it before the binding exists would produce a vault pointing at an
 * address the registry does not yet recognise.
 */
export async function setupAgent() {
  if (!walletAvailable()) throw new Error('no_wallet');

  const offer = await post('/agent/setup');
  await sendCall(offer.bind.call);
  const hash = await sendCall(offer.createVault);

  // Close the loop: without this the vault exists on chain and the server never
  // learns of it, so the screen reads "Not funded" forever.
  const agent = await attachVault();

  return { agent, hash, caps: offer.caps };
}

/**
 * Ask the server to find the vault on chain.
 *
 * Sends no address on purpose — the server reads it from the factory. One the
 * client could supply would be one the server then lets an agent spend against.
 */
export const attachVault = () => post('/agent/vault').then(r => r.agent);

/**
 * Stop the agent here, and hand back the transaction that stops it on chain.
 *
 * Returns `{ stoppedHere, call }`. Callers must send `call` and must not report
 * the agent as revoked until it lands.
 */
export const stopAgent = () => post('/agent/kill');

export const resumeAgent = () => post('/agent/resume').then(r => r.agent);

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
  return sendCall(call);
}

/** Owner-only vault transactions. Encoded server-side, signed by the player. */
export async function vaultAction(action, args) {
  if (!walletAvailable()) throw new Error('no_wallet');
  const { call } = await post(`/agent/vault/${encodeURIComponent(action)}`, args);
  return sendCall(call);
}

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
