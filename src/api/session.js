import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  parseAbi,
} from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { CHAIN_ID, REGISTRY_ADDRESS, RPC_URL } from './config';

/**
 * Real authentication: a session key, bound on-chain, signing every request.
 *
 * ─────────────────────────── why a second key at all ───────────────────────
 *
 * MiniPay cannot sign arbitrary messages. If the wallet had to sign each
 * request there would be no game — just a wallet prompt per dig. So the browser
 * generates its own throwaway keypair, and the wallet is used exactly once, to
 * send a transaction saying "this key speaks for me". That transaction is the
 * login, and it is the only time the wallet is involved.
 *
 * ─────────────────────────── what the session key is worth ─────────────────
 *
 * It lives in localStorage, so treat it as compromised the moment the device is.
 * It cannot move money: it authenticates gameplay, nothing more. Revoking it is
 * `PlayerRegistry.clear()` from the wallet, and the server watches for that
 * event and drops the key immediately rather than waiting out its cache.
 *
 * ─────────────────────────── the ordering that matters ─────────────────────
 *
 * The session key signs the digest BEFORE the wallet sends the transaction. The
 * contract checks that signature, which is what stops anyone naming a key they
 * do not hold — including a key already bound to somebody else.
 */

const SESSION_KEY = 'lootgrid.sessionKey';
const PLAYER_KEY = 'lootgrid.player';
/** Which wallet the player chose, so a second visit does not silently pick another. */
const WALLET_KEY = 'lootgrid.wallet';

const REGISTRY_ABI = parseAbi([
  'function bind(address sessionKey, bytes sig)',
  'function clear()',
  'function sessionKeyOf(address player) view returns (address)',
]);

/** Must match PlayerRegistry.BIND_TYPEHASH exactly, or every bind reverts. */
const BIND_TYPEHASH = keccak256(
  toHex('LootGridBindSessionKey(address player,address sessionKey)'),
);

let cachedAccount = null;

// ─────────────────────────────── the session key ───────────────────────────

/** The browser's own key. Created once, then reused until revoked. */
export function getSessionAccount() {
  if (cachedAccount) return cachedAccount;
  let pk = localStorage.getItem(SESSION_KEY);
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem(SESSION_KEY, pk);
  }
  cachedAccount = privateKeyToAccount(pk);
  return cachedAccount;
}

/** The wallet address we are acting as. Null until a wallet has connected. */
export function getPlayerId() {
  return localStorage.getItem(PLAYER_KEY);
}

export function isAuthenticated() {
  return Boolean(getPlayerId() && localStorage.getItem(SESSION_KEY));
}

/**
 * Forget everything local. Does NOT revoke on-chain — use `revoke()` for that.
 * Used when switching accounts, where the old session key is simply irrelevant.
 */
export function resetPlayerId() {
  localStorage.removeItem(PLAYER_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(WALLET_KEY);
  cachedAccount = null;
}

// ─────────────────────────── finding the wallet ─────────────────────────────

/**
 * Wallets announced over EIP-6963.
 *
 * `window.ethereum` is a single slot that several extensions fight over: with
 * MetaMask and one other installed, whoever loaded last wins and the player gets
 * a wallet they did not choose. EIP-6963 replaced that with an announcement
 * event, which is how a page can name the wallet it wants.
 *
 * Discovery is synchronous-ish — providers answer the request event immediately
 * — but it is still an event, so this collects rather than returns.
 */
const discovered = new Map(); // rdns -> { info, provider }

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', e => {
    if (e.detail?.info?.rdns) discovered.set(e.detail.info.rdns, e.detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Wallets we know how to name in the UI, best first. */
const PREFERRED = ['io.metamask', 'com.opera.crypto', 'app.core.extension'];

export function listWallets() {
  return [...discovered.values()].map(d => ({ rdns: d.info.rdns, name: d.info.name, icon: d.info.icon }));
}

/**
 * The provider to use.
 *
 * MiniPay first and unconditionally: inside MiniPay there is exactly one wallet
 * and it is the point of the app. Otherwise prefer an explicitly requested
 * wallet, then MetaMask, then whatever announced itself, and only then fall back
 * to the contested `window.ethereum` slot for wallets predating EIP-6963.
 */
function injected(rdns) {
  if (typeof window === 'undefined') throw new Error('No wallet available.');

  if (window.ethereum?.isMiniPay) return window.ethereum;
  if (rdns && discovered.has(rdns)) return discovered.get(rdns).provider;

  for (const id of PREFERRED) {
    if (discovered.has(id)) return discovered.get(id).provider;
  }
  const first = [...discovered.values()][0];
  if (first) return first.provider;

  if (window.ethereum) return window.ethereum;

  throw new Error(
    'No wallet found. Install MetaMask, or open this inside MiniPay.',
  );
}

export const publicClient = () =>
  createPublicClient({ chain: celo, transport: http(RPC_URL) });

/**
 * The provider the player actually connected with.
 *
 * Exported so every module sends from the SAME wallet. `records.js` used to
 * reach for `window.ethereum` on its own, which with two extensions installed is
 * a different wallet than the one holding the bound address — the transaction
 * then comes from an account the registry has never heard of.
 */
export const activeProvider = () => injected(rememberedWallet());

/** True only inside MiniPay, which is the one wallet that understands feeCurrency. */
export const isMiniPay = () =>
  typeof window !== 'undefined' && Boolean(window.ethereum?.isMiniPay);

/**
 * Celo, in the shape `wallet_addEthereumChain` wants.
 *
 * MetaMask ships Ethereum and a handful of others; Celo is not among them. A
 * plain `wallet_switchEthereumChain` therefore fails with 4902 on a fresh
 * install — the single most likely first-run error — so the switch has to be
 * able to add the chain and retry.
 */
const CELO_PARAMS = {
  chainId: '0x' + CHAIN_ID.toString(16),
  chainName: 'Celo',
  nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: ['https://celoscan.io'],
};

async function ensureCelo(eth) {
  const current = await eth.request({ method: 'eth_chainId' });
  if (parseInt(current, 16) === CHAIN_ID) return;

  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CELO_PARAMS.chainId }],
    });
  } catch (err) {
    // 4902: unrecognised chain. Some wallets nest it under `err.data`.
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902) throw err;
    await eth.request({ method: 'wallet_addEthereumChain', params: [CELO_PARAMS] });
  }

  // Adding does not always switch, and a wallet left on the wrong chain would
  // send the bind to a registry the server never reads — succeeding locally and
  // being invisible. Verify rather than assume.
  const after = await eth.request({ method: 'eth_chainId' });
  if (parseInt(after, 16) !== CHAIN_ID) {
    throw new Error('Please switch your wallet to the Celo network and try again.');
  }
}

/** Turns wallet error codes into something a player can act on. */
function friendly(err) {
  const code = err?.code ?? err?.data?.originalError?.code;
  if (code === 4001) return new Error('You rejected the request in your wallet.');
  if (code === -32002) return new Error('Your wallet already has a pending request — open it.');
  return err;
}

/** Connects the wallet and remembers which address we are playing as. */
export async function connectWallet(rdns) {
  const eth = injected(rdns);
  let address;
  try {
    [address] = await eth.request({ method: 'eth_requestAccounts' });
    if (!address) throw new Error('Wallet returned no account.');
    await ensureCelo(eth);
  } catch (err) {
    throw friendly(err);
  }

  const previous = getPlayerId();
  if (previous && previous.toLowerCase() !== address.toLowerCase()) {
    // A session key belongs to one wallet. Carrying it across would send
    // requests signed by a key the registry maps to somebody else.
    resetPlayerId();
  }
  localStorage.setItem(PLAYER_KEY, address);
  if (rdns) localStorage.setItem(WALLET_KEY, rdns);
  return address;
}

/**
 * Re-select the wallet the player connected with last time.
 *
 * Without this, a player with two wallets installed gets whichever `PREFERRED`
 * ranks higher on their next visit — and if that is not the wallet holding their
 * bound address, every request fails to verify.
 */
function rememberedWallet() {
  return localStorage.getItem(WALLET_KEY) || undefined;
}

/** Whether the registry already maps this wallet to the key in this browser. */
export async function isBoundOnChain() {
  const player = getPlayerId();
  if (!player) return false;
  const bound = await publicClient().readContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'sessionKeyOf',
    args: [player],
  });
  return bound.toLowerCase() === getSessionAccount().address.toLowerCase();
}

/**
 * Bind this browser's session key to the connected wallet. One transaction,
 * paid by the player, and the only time the wallet is asked for anything.
 */
export async function bindSessionKey() {
  const eth = injected(rememberedWallet());
  const player = getPlayerId();
  if (!player) throw new Error('Connect a wallet first.');

  // The player may have switched networks between connecting and confirming.
  // A bind sent to another chain succeeds in their wallet and is invisible to
  // the server, which reads Celo — the worst kind of failure to debug.
  await ensureCelo(eth);

  const session = getSessionAccount();

  // The digest the contract will recompute. `bindDigest()` returns this already
  // wrapped in the EIP-191 prefix, so what gets signed is the INNER hash —
  // signMessage applies the prefix itself. Signing the wrapped value would
  // double-prefix it and the contract's recover would return a stranger.
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
      ],
      [BIND_TYPEHASH, BigInt(CHAIN_ID), REGISTRY_ADDRESS, player, session.address],
    ),
  );
  const sig = await session.signMessage({ message: { raw: inner } });

  // `account` is the ADDRESS here, deliberately: an injected wallet is a
  // JSON-RPC account, so viem must ask it to sign via eth_sendTransaction
  // rather than signing locally. (The server's own clients pass an account
  // OBJECT for the opposite reason.)
  const wallet = createWalletClient({ account: player, chain: celo, transport: custom(eth) });
  let hash;
  try {
    hash = await wallet.sendTransaction({
      to: REGISTRY_ADDRESS,
      data: encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'bind',
        args: [session.address, sig],
      }),
    });
  } catch (err) {
    throw friendly(err);
  }

  await publicClient().waitForTransactionReceipt({ hash });

  // forno.celo.org is load-balanced, so a read straight after the write can hit
  // a node that has not seen the block and answer with the zero address. Retry
  // rather than telling the player their binding failed when it did not.
  for (let i = 0; i < 10; i++) {
    if (await isBoundOnChain()) return hash;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Binding did not appear on-chain. Check the transaction and retry.');
}

/** Revoke on-chain. The server drops the key as soon as it sees the event. */
export async function revoke() {
  const eth = injected(rememberedWallet());
  const player = getPlayerId();
  const wallet = createWalletClient({ account: player, chain: celo, transport: custom(eth) });
  const hash = await wallet.sendTransaction({
    to: REGISTRY_ADDRESS,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'clear', args: [] }),
  });
  await publicClient().waitForTransactionReceipt({ hash });
  resetPlayerId();
  return hash;
}
