import { createPublicClient, encodeFunctionData, http, parseAbi, toHex, type Address, type Hex } from 'viem';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Reads HintEscrow. Nothing here ever writes.
 *
 * ─────────────────────────── why read-only ───────────────────────────
 *
 * The buyer funds their own trade and either party submits the release, so the
 * server needs no key and holds no float for the market — a deliberate contrast
 * with `chain/escrow.ts`, which sends `fundHunt` from a wallet that is the only
 * spendable money on the box. The market's worst-case server compromise costs
 * the ability to *approve* trades, not the ability to drain one.
 *
 * ─────────────────────────── why polling, not an indexer ────────────────────
 *
 * The referee needs to know one thing about a trade: what state the contract
 * says it is in. That is a single `trades(bytes32)` call, made when a player
 * asks about their own trade, so there is no event stream to follow, nothing to
 * backfill, and no window in which a missed log strands a hint. An indexer would
 * be more machinery for a question that already has an exact answer.
 *
 * ─────────────────────────── the seam ───────────────────────────
 *
 * The chain is reached through one function, so the market's state machine can
 * be tested for real without an RPC — the same pattern the relayer and escrow
 * worker use.
 */

export const HINT_ESCROW_READ_ABI = parseAbi([
  'function trades(bytes32) view returns (address buyer, address seller, uint128 amount, uint64 expiresAt, uint8 status, bytes32 hintHash)',
]);

/** Mirrors HintEscrow's `Status` enum. Order is consensus with the contract. */
export enum OnChainStatus {
  None = 0,
  Funded = 1,
  Settled = 2,
  Refunded = 3,
}

export interface OnChainTrade {
  buyer: Address;
  seller: Address;
  amount: bigint;
  expiresAt: number;
  status: OnChainStatus;
  hintHash: Hex;
}

export type ReadTradeFn = (tradeId: Hex) => Promise<OnChainTrade>;

export function enabled(): boolean {
  return Boolean(env.HINT_MARKET_ENABLED && env.HINT_ESCROW_ADDRESS && env.RPC_URL);
}

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function client() {
  if (!publicClient) {
    if (!env.RPC_URL) {
      throw new Error('hint market misconfigured — env validation should have caught this');
    }
    publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return publicClient;
}

const chainRead: ReadTradeFn = async tradeId => {
  const [buyer, seller, amount, expiresAt, status, hintHash] = await client().readContract({
    address: env.HINT_ESCROW_ADDRESS as Address,
    abi: HINT_ESCROW_READ_ABI,
    functionName: 'trades',
    args: [tradeId],
  });

  return {
    buyer,
    seller,
    amount,
    expiresAt: Number(expiresAt),
    status: status as OnChainStatus,
    hintHash,
  };
};

let readFn: ReadTradeFn = chainRead;

/** Swaps the transport. Tests only — `null` restores the real one. */
export function setReaderForTests(fn: ReadTradeFn | null): void {
  readFn = fn ?? chainRead;
}

/**
 * What the contract says about a trade.
 *
 * Throws on an unreachable RPC rather than reporting `None`: "the chain has no
 * record of this" and "we could not ask" must not look the same, because the
 * first is grounds for abandoning a trade and the second is grounds for trying
 * again in a moment.
 */
export async function readTrade(tradeId: Hex): Promise<OnChainTrade> {
  try {
    return await readFn(tradeId);
  } catch (err) {
    logger.warn({ err, tradeId }, 'hint escrow read failed');
    throw err;
  }
}

const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount)']);

/** Approvals are a plain transfer's worth of work; fixed rather than estimated. */
const APPROVE_GAS = 100_000n;

/**
 * The allowance the buyer must grant before `fund` can pull their money.
 *
 * Issued for the exact trade amount rather than an unlimited approval. An
 * infinite allowance to an escrow is a standing invitation for any future bug in
 * it to drain a player's wallet, and the saving — one transaction per trade —
 * is not worth that on a contract this young.
 *
 * A buyer who already holds a sufficient allowance can skip it; the client is
 * told to send it first because a `fund` that reverts on allowance looks to a
 * player like the market being broken.
 */
export function approvalCall(amount: bigint) {
  return {
    to: env.HINT_TOKEN_ADDRESS as Address,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [env.HINT_ESCROW_ADDRESS as Address, amount],
    }),
    gas: toHex(APPROVE_GAS),
  };
}

/** Test-only: drops the cached client. */
export function reset(): void {
  publicClient = null;
}
