import { createPublicClient, encodeFunctionData, http, parseAbi, toHex, type Address, type Hex } from 'viem';
import { env } from '../env';
import { logger } from '../logger';

/**
 * The ERC-8004 registries: identity and reputation.
 *
 * ─────────────────────────── someone else's contracts ───────────────────────
 *
 * These are already deployed on Celo and are not ours to change, which shapes
 * everything here. We cannot add a function, fix a rounding rule, or make the
 * summary mean something different — so this module reads what the registries
 * say and treats it as *one input* to a trust decision rather than the decision
 * itself. See `agents/reputation.ts` for why that distinction is the whole
 * phase.
 *
 * ─────────────────────────── the shape of the API ───────────────────────────
 *
 * Two things about the reputation registry are easy to get wrong and expensive
 * to discover in production:
 *
 *   * `getSummary` requires the client list. It will not gather clients for
 *     you, and passing an empty array is not "all" — it is nothing. So every
 *     read is two calls: `getClients`, then `getSummary`.
 *   * `giveFeedback` blocks self-feedback at the contract, by owner. That stops
 *     an agent praising itself and does nothing about two wallets praising each
 *     other, which is the attack that matters here.
 */

export const IDENTITY_ADDRESS = {
  celo: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  celoSepolia: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
} as const;

export const REPUTATION_ADDRESS = {
  celo: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  celoSepolia: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
} as const;

export const IDENTITY_ABI = parseAbi([
  'function register(string uri) returns (uint256)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function setAgentURI(uint256 agentId, string uri)',
]);

export const REPUTATION_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getClients(uint256 agentId) view returns (address[])',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
]);

/** The tag this game writes under. One tag, so summaries mean one thing. */
export const FEEDBACK_TAG = 'starred';

/** Feedback is 0–100 with no decimals — the registry's own convention. */
export const VALUE_DECIMALS = 0;

export interface Summary {
  /** How many pieces of feedback the registry counted. */
  count: number;
  /** The registry's aggregate, normalised to 0–100. */
  value: number;
  /** Who gave feedback. Needed to read a summary at all, and useful on its own. */
  clients: Address[];
}

export type ReadSummaryFn = (agentId: bigint) => Promise<Summary | null>;
export type GiveFeedbackFn = (
  from: string,
  agentId: bigint,
  value: number,
  endpoint: string,
  feedbackHash: Hex,
) => Promise<Hex>;

export const identityAddress = (): Address => IDENTITY_ADDRESS[env.CHAIN] as Address;
export const reputationAddress = (): Address => REPUTATION_ADDRESS[env.CHAIN] as Address;

export function enabled(): boolean {
  return Boolean(env.AGENTS_ENABLED && env.RPC_URL);
}

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function client() {
  if (!publicClient) {
    if (!env.RPC_URL) throw new Error('erc8004 reads misconfigured — check enabled()');
    publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  }
  return publicClient;
}

/**
 * An agent's reputation, as the registry reports it.
 *
 * Returns null for an agent nobody has rated — which is the common case and not
 * an error. A new agent is unrated, not untrustworthy, and conflating the two
 * would make the market impossible to enter.
 */
const chainReadSummary: ReadSummaryFn = async agentId => {
  const clients = (await client().readContract({
    address: reputationAddress(),
    abi: REPUTATION_ABI,
    functionName: 'getClients',
    args: [agentId],
  })) as Address[];

  // `getSummary` will not gather clients for itself, and an empty array means
  // nothing rather than everything.
  if (clients.length === 0) return null;

  const [count, summaryValue, decimals] = (await client().readContract({
    address: reputationAddress(),
    abi: REPUTATION_ABI,
    functionName: 'getSummary',
    args: [agentId, clients, FEEDBACK_TAG, ''],
  })) as [bigint, bigint, number];

  return {
    count: Number(count),
    // The registry carries its own decimals; normalise so callers never have to
    // remember which scale a particular agent was rated on.
    value: Number(summaryValue) / 10 ** Number(decimals),
    clients,
  };
};

const chainGiveFeedback: GiveFeedbackFn = async () => {
  // Deliberately unimplemented in this build. Writing feedback needs a funded
  // key that is neither the agent's (it must not be able to rate anybody) nor
  // the referee's (the house rating players is not reputation, it is a score).
  // See `agents/reputation.ts` — the feedback a player gives is their own
  // transaction, so the server prepares it and never sends it.
  throw new Error('feedback is submitted by the player, not the server');
};

let readSummaryFn: ReadSummaryFn = chainReadSummary;
let giveFeedbackFn: GiveFeedbackFn = chainGiveFeedback;

export function setTransportForTests(
  read: ReadSummaryFn | null,
  give: GiveFeedbackFn | null,
): void {
  readSummaryFn = read ?? chainReadSummary;
  giveFeedbackFn = give ?? chainGiveFeedback;
  publicClient = null;
}

/** Never throws for an unrated agent; throws only when the chain is unreachable. */
export async function readSummary(agentId: bigint): Promise<Summary | null> {
  try {
    return await readSummaryFn(agentId);
  } catch (err) {
    logger.warn({ err, agentId: String(agentId) }, 'reputation read failed');
    throw err;
  }
}

export const giveFeedback = (
  from: string,
  agentId: bigint,
  value: number,
  endpoint: string,
  feedbackHash: Hex,
) => giveFeedbackFn(from, agentId, value, endpoint, feedbackHash);

// ─────────────────────────── transactions the player sends ──────────────────

/**
 * Register an agent, owned by the player.
 *
 * `ownerOf` becomes `msg.sender`, so this has to be the player's transaction —
 * the house registering on their behalf would make the house the owner of their
 * agent's identity. The URI points at metadata this server hosts, which is what
 * carries the agent's wallet address and endpoints.
 */
export function registerCall(metadataUri: string) {
  return {
    to: identityAddress(),
    data: encodeFunctionData({
      abi: IDENTITY_ABI,
      functionName: 'register',
      args: [metadataUri],
    }),
    gas: toHex(400_000n),
  };
}

/**
 * Leave feedback about an agent, from the player who traded with it.
 *
 * Prepared here and sent by them, for two reasons. The registry blocks
 * self-feedback by owner, so feedback signed by a house key would be the house
 * rating agents rather than their counterparties — a different and much weaker
 * signal. And a player who did not trade should not be able to rate: the server
 * only ever prepares this after seeing a settled trade between the two.
 */
export function feedbackCall(
  agentId: bigint,
  value: number,
  endpoint: string,
  feedbackURI: string,
  feedbackHash: Hex,
) {
  return {
    to: reputationAddress(),
    data: encodeFunctionData({
      abi: REPUTATION_ABI,
      functionName: 'giveFeedback',
      args: [
        agentId,
        BigInt(Math.max(0, Math.min(100, Math.round(value)))),
        VALUE_DECIMALS,
        FEEDBACK_TAG,
        '',
        endpoint,
        feedbackURI,
        feedbackHash,
      ],
    }),
    gas: toHex(400_000n),
  };
}

export function reset(): void {
  publicClient = null;
}
