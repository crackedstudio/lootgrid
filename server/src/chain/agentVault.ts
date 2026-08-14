import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { env } from '../env';
import { logger } from '../logger';
import * as identity from '../agents/identity';

/**
 * Reading a player's vault, and sending the one transaction the agent may.
 *
 * ─────────────────────────── why the server reads it ───────────────────────
 *
 * A vault address supplied by a request would be an address the server then
 * lets an agent spend against. So it is read from the factory, which is the
 * only thing that knows: `vaultOf[player]` is set by the factory at creation
 * and cannot be set by anybody else.
 *
 * ─────────────────────────── the one key that spends ────────────────────────
 *
 * This is the only module where an agent key sends a transaction, and it can
 * send exactly two shapes: a hint-trade funding, and nothing else. The vault
 * refuses everything else anyway — `spend` and `fundHintTrade` are the only
 * functions its spender can call — but the surface here is deliberately just as
 * narrow, so a bug cannot reach for a function the contract would have allowed.
 *
 * The agent pays its own gas from a small float. It holds no stablecoins: its
 * money is in the vault, and the vault only ever moves it to somewhere its
 * owner allowlisted.
 */

export const FACTORY_READ_ABI = parseAbi([
  'function vaultOf(address player) view returns (address)',
]);

export const VAULT_READ_ABI = parseAbi([
  'function remainingToday() view returns (uint256)',
  'function perTxCap() view returns (uint256)',
  'function spender() view returns (address)',
  'function allowed(address target) view returns (bool)',
]);

export interface VaultState {
  address: Address;
  /** What the agent may still move today, in token base units. */
  remainingToday: bigint;
  perTxCap: bigint;
  /** Zero once the owner has pressed kill on chain. */
  spender: Address;
}

export type ReadVaultFn = (player: Address) => Promise<VaultState | null>;
/** `playerId` picks the signing key — the agent's address derives from it. */
export type SendFn = (playerId: string, to: Address, data: Hex, gas: bigint) => Promise<Hex>;

export function enabled(): boolean {
  return Boolean(env.AGENTS_ENABLED && env.AGENT_VAULT_FACTORY_ADDRESS && env.RPC_URL);
}

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function client() {
  if (!publicClient) {
    if (!env.RPC_URL) throw new Error('agent vault reads misconfigured — check enabled()');
    publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return publicClient;
}

const chainRead: ReadVaultFn = async player => {
  const vault = await client().readContract({
    address: env.AGENT_VAULT_FACTORY_ADDRESS as Address,
    abi: FACTORY_READ_ABI,
    functionName: 'vaultOf',
    args: [player],
  });

  // The factory returns the zero address for a player who has never created
  // one. Not an error — most players never will.
  if (!vault || /^0x0+$/.test(vault)) return null;

  const contract = { address: vault, abi: VAULT_READ_ABI } as const;
  const [remainingToday, perTxCap, spender] = await Promise.all([
    client().readContract({ ...contract, functionName: 'remainingToday' }),
    client().readContract({ ...contract, functionName: 'perTxCap' }),
    client().readContract({ ...contract, functionName: 'spender' }),
  ]);

  return { address: vault, remainingToday, perTxCap, spender };
};

const chainSend: SendFn = async (playerId, to, data, gas) => {
  if (!env.RPC_URL) throw new Error('agent sending misconfigured');
  const account = identity.signerFor(playerId);
  const wallet = createWalletClient({ account, transport: http(env.RPC_URL) });
  return wallet.sendTransaction({ account, to, data, gas, chain: null });
};

let readFn: ReadVaultFn = chainRead;
let sendFn: SendFn = chainSend;

/** Swaps the transport. Tests only — `null` restores the real one. */
export function setTransportForTests(read: ReadVaultFn | null, send: SendFn | null): void {
  readFn = read ?? chainRead;
  sendFn = send ?? chainSend;
  publicClient = null;
}

/**
 * A player's vault, as the chain sees it.
 *
 * Returns null when they have none, and throws only when the RPC is
 * unreachable — "no vault" and "could not ask" must not look the same, because
 * the first is a normal state and the second is a reason to try again.
 */
export async function readVault(player: Address): Promise<VaultState | null> {
  try {
    return await readFn(player);
  } catch (err) {
    logger.warn({ err, player }, 'vault read failed');
    throw err;
  }
}

/**
 * Send a prepared vault transaction as the agent.
 *
 * `playerId` picks the signing key; the agent's address is derived from it, so
 * there is no way to sign as an agent that is not this player's.
 */
export function sendAsAgent(playerId: string, to: Address, data: Hex, gas = 400_000n): Promise<Hex> {
  return sendFn(playerId, to, data, gas);
}

export function reset(): void {
  publicClient = null;
}
