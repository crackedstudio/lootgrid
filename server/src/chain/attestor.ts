import {encodeFunctionData, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {env} from '../env';
import {logger} from '../logger';

/**
 * Signs EIP-712 attestations that let a *player* publish their own hunt entry
 * or win, paying their own gas.
 *
 * ─────────────────────────── why this exists ───────────────────────────
 *
 * The relayer path works by trusted address: `LootGridActions` believes reveals
 * because only one key can send them. That trick does not survive letting
 * players submit — with no trusted `msg.sender`, nothing would stop a player
 * calling `submitResolution` and declaring themselves winner of every hunt. So
 * on the self-submitted paths the referee's signature *is* the authorisation,
 * and this module is where it is produced.
 *
 * ─────────────────────────── operational notes ───────────────────────────
 *
 * **This key never sends a transaction.** It needs no balance and no nonce, so
 * it can live somewhere colder than `RELAY_PRIVATE_KEY`. It is also strictly
 * more dangerous: a leaked relayer key writes false logs, a leaked attestor key
 * mints entries and wins that anybody can then submit. Rotate with
 * `setAttestor` — in-flight attestations signed by the old key stop verifying
 * the moment that lands.
 *
 * **Attestations are bearer tokens with a short life.** Whoever holds one can
 * spend it, once — the contract burns the digest on use. {@link DEADLINE_SECONDS}
 * keeps the window in which a leaked one is worth anything small.
 *
 * **Signing must never block gameplay.** Same rule as the relayer: the referee
 * decides the outcome and moves on. Issuing an attestation is a separate,
 * failable request the client makes afterwards.
 */

/** Must match the contract's `EIP712("LootGridActions", "1")` exactly. */
const DOMAIN_NAME = 'LootGridActions';
const DOMAIN_VERSION = '1';

/**
 * The escrow verifies the identical `Resolution` struct under its OWN domain,
 * with its own on-chain attestor. So the same message is signed twice: once for
 * the public record, once for the money.
 *
 * That is deliberate. Sharing one signature would tie the key that writes
 * cosmetic game logs to the key that moves funds, and they need different
 * protection — records can stay on a hot key, payouts should not. Point
 * ESCROW_PRIVATE_KEY at the same value as ATTESTOR_PRIVATE_KEY on day one if you
 * like; the separation exists so you can stop.
 */
const ESCROW_DOMAIN_NAME = 'LootGridEscrow';
const ESCROW_DOMAIN_VERSION = '1';

/**
 * How long an attestation stays valid. Long enough to survive a slow wallet
 * round trip and a congested block or two; short enough that a leaked one is
 * near-worthless. The contract compares against `block.timestamp`, so this is
 * wall-clock seconds and tolerates only mild clock skew.
 */
export const DEADLINE_SECONDS = 300;

/**
 * Field order is consensus with the contract's type hashes. Reordering silently
 * invalidates every signature this produces — treat as append-only, in step
 * with `LootGridActions.sol`.
 */
export const TYPES = {
  Entry: [
    {name: 'player', type: 'address'},
    {name: 'huntId', type: 'bytes32'},
    {name: 'gameType', type: 'uint8'},
    {name: 'deadline', type: 'uint256'},
  ],
  Resolution: [
    {name: 'winner', type: 'address'},
    {name: 'huntId', type: 'bytes32'},
    {name: 'elapsedMs', type: 'uint32'},
    {name: 'racers', type: 'uint16'},
    {name: 'deadline', type: 'uint256'},
  ],
  /**
   * Vouches for a hint being offered for sale.
   *
   * What it asserts: this hash is a hint the GAME issued, for this zone, at this
   * precision tier, drawn from a pool advertised at this reliability.
   *
   * What it deliberately does NOT assert: that the hint is correct. Hints lie on
   * purpose and the referee cannot certify accuracy without handing over the
   * answer. A buyer learns the odds, never the outcome — which is exactly what
   * makes the market work, because it prices information rather than truth.
   *
   * This is the fix for the lemon market: without it a seller can offer
   * fabricated hints and a buyer cannot tell, so bad hints drive out good and
   * the market dies. With it, the worst a seller can do is sell you a genuine
   * hint that happens to be one of the false ones — which is the game.
   */
  Hint: [
    {name: 'hintHash', type: 'bytes32'},
    {name: 'zoneId', type: 'bytes32'},
    {name: 'tier', type: 'uint8'},
    {name: 'reliabilityBps', type: 'uint16'},
    {name: 'deadline', type: 'uint256'},
  ],
} as const;

const CHAIN_IDS = {celo: 42_220, celoSepolia: 11_142_220} as const;

export const SUBMIT_ABI = parseAbi([
  'function submitEntry(address player, bytes32 huntId, uint8 gameType, uint256 deadline, bytes signature)',
  'function submitResolution(address winner, bytes32 huntId, uint32 elapsedMs, uint16 racers, uint256 deadline, bytes signature)',
]);

/**
 * Transaction the caller should send, encoded here rather than in the browser.
 *
 * The client has no web3 dependency and no ABI, and hand-rolling the encoding
 * for a dynamic `bytes` argument in a wallet webview is exactly the sort of
 * thing that fails silently. Nothing is trusted to the client by doing this —
 * every field is already inside the signature.
 */
export interface SubmitCall {
  /** Contract address. */
  to: Address;
  /** ABI-encoded calldata, ready for `eth_sendTransaction`. */
  data: Hex;
  /** Suggested gas limit, generous against the measured ~75k. */
  gas: string;
}

export interface EntryAttestation {
  kind: 'entry';
  player: Address;
  huntId: Hex;
  gameType: number;
  deadline: number;
  signature: Hex;
  /** Everything the client needs to build the transaction without guessing. */
  contract: Address;
  chainId: number;
  call: SubmitCall;
}

export interface ResolutionAttestation {
  kind: 'resolution';
  winner: Address;
  huntId: Hex;
  elapsedMs: number;
  racers: number;
  deadline: number;
  signature: Hex;
  contract: Address;
  chainId: number;
  call: SubmitCall;
}

export type Attestation = EntryAttestation | ResolutionAttestation;

/** Headroom over the ~73-75k these calls actually measure at in the test suite. */
const SUBMIT_GAS = 150_000n;

/** Whether attestation issuing is configured. Absent key => feature is simply off. */
export function enabled(): boolean {
  return Boolean(env.ATTESTOR_PRIVATE_KEY && env.LOOTGRID_ACTIONS_ADDRESS);
}

let account: ReturnType<typeof privateKeyToAccount> | null = null;

function signer() {
  if (!account) {
    if (!env.ATTESTOR_PRIVATE_KEY) {
      throw new Error('attestor misconfigured — check enabled() before signing');
    }
    account = privateKeyToAccount(env.ATTESTOR_PRIVATE_KEY as Hex);
    logger.info({attestor: account.address}, 'attestor key loaded');
  }
  return account;
}

/** The attestor's public address, for wiring `ACTIONS_ATTESTOR` at deploy time. */
export function address(): Address {
  return signer().address;
}

// ─────────────────────────── escrow (payouts) ───────────────────────────

let escrowAccount: ReturnType<typeof privateKeyToAccount> | null = null;

/** Whether payout signing is configured. Absent key => escrow claims are off. */
export function escrowEnabled(): boolean {
  return Boolean(env.ESCROW_PRIVATE_KEY && env.LOOTGRID_ESCROW_ADDRESS);
}

function escrowSigner() {
  if (!escrowAccount) {
    if (!env.ESCROW_PRIVATE_KEY) {
      throw new Error('escrow attestor misconfigured — check escrowEnabled() before signing');
    }
    escrowAccount = privateKeyToAccount(env.ESCROW_PRIVATE_KEY as Hex);
    logger.info({ escrowAttestor: escrowAccount.address }, 'escrow payout key loaded');
  }
  return escrowAccount;
}

/** The payout signer's address, for wiring ESCROW_ATTESTOR at deploy time. */
export function escrowAddress(): Address {
  return escrowSigner().address;
}

function escrowDomain() {
  return {
    name: ESCROW_DOMAIN_NAME,
    version: ESCROW_DOMAIN_VERSION,
    chainId: CHAIN_IDS[env.CHAIN],
    verifyingContract: env.LOOTGRID_ESCROW_ADDRESS as Address,
  } as const;
}

export interface PayoutAttestation {
  kind: 'payout';
  winner: Address;
  huntId: Hex;
  elapsedMs: number;
  racers: number;
  deadline: number;
  signature: Hex;
  contract: Address;
  chainId: number;
}

/**
 * Sign a payout claim against LootGridEscrow.
 *
 * Same fields as {@link signResolution} — the escrow deliberately verifies the
 * identical struct — but under the escrow's domain and with the escrow's key.
 * The amount is NOT signed: it comes from the pot the treasury funded, so the
 * referee never has to know or agree about how much a hunt is worth.
 */
export async function signPayout(
  winner: Address,
  huntId: Hex,
  elapsedMs: number,
  racers: number,
  now: number = Date.now(),
): Promise<PayoutAttestation> {
  const deadline = deadlineFrom(now);
  const clampedElapsed = Math.max(0, Math.min(Math.trunc(elapsedMs), 4_294_967_295));
  const clampedRacers = Math.max(0, Math.min(Math.trunc(racers), 65_535));

  const signature = await escrowSigner().signTypedData({
    domain: escrowDomain(),
    types: TYPES,
    primaryType: 'Resolution',
    message: {
      winner,
      huntId,
      elapsedMs: clampedElapsed,
      racers: clampedRacers,
      deadline: BigInt(deadline),
    },
  });

  return {
    kind: 'payout',
    winner,
    huntId,
    elapsedMs: clampedElapsed,
    racers: clampedRacers,
    deadline,
    signature,
    contract: env.LOOTGRID_ESCROW_ADDRESS as Address,
    chainId: CHAIN_IDS[env.CHAIN],
  };
}

function domain() {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_IDS[env.CHAIN],
    verifyingContract: env.LOOTGRID_ACTIONS_ADDRESS as Address,
  } as const;
}

function deadlineFrom(now: number): number {
  return Math.floor(now / 1000) + DEADLINE_SECONDS;
}

/**
 * Packs a server-side string id into bytes32, identically to the relayer.
 *
 * Kept as its own copy rather than imported so that requiring the attestor does
 * not pull in the relayer's database and worker. The two MUST agree — a
 * divergence would put the same hunt under two different ids on chain.
 */
export function toBytes32Id(id: string): Hex {
  const bytes = Buffer.byteLength(id, 'utf8');
  return bytes <= 31 ? stringToHex(id, {size: 32}) : keccak256(toHex(id));
}

export async function signEntry(
  player: Address,
  huntId: Hex,
  gameType: number,
  now: number = Date.now(),
): Promise<EntryAttestation> {
  const deadline = deadlineFrom(now);
  const signature = await signer().signTypedData({
    domain: domain(),
    types: TYPES,
    primaryType: 'Entry',
    message: {player, huntId, gameType, deadline: BigInt(deadline)},
  });

  return {
    kind: 'entry',
    player,
    huntId,
    gameType,
    deadline,
    signature,
    contract: env.LOOTGRID_ACTIONS_ADDRESS as Address,
    chainId: CHAIN_IDS[env.CHAIN],
    call: {
      to: env.LOOTGRID_ACTIONS_ADDRESS as Address,
      data: encodeFunctionData({
        abi: SUBMIT_ABI,
        functionName: 'submitEntry',
        args: [player, huntId, gameType, BigInt(deadline), signature],
      }),
      gas: toHex(SUBMIT_GAS),
    },
  };
}

export async function signResolution(
  winner: Address,
  huntId: Hex,
  elapsedMs: number,
  racers: number,
  now: number = Date.now(),
): Promise<ResolutionAttestation> {
  const deadline = deadlineFrom(now);
  // Clamp exactly as the relayer does: these are uint32/uint16 on chain, and a
  // silently truncated value would sign a claim the referee did not make.
  const clampedElapsed = Math.max(0, Math.min(Math.trunc(elapsedMs), 4_294_967_295));
  const clampedRacers = Math.max(0, Math.min(Math.trunc(racers), 65_535));

  const signature = await signer().signTypedData({
    domain: domain(),
    types: TYPES,
    primaryType: 'Resolution',
    message: {
      winner,
      huntId,
      elapsedMs: clampedElapsed,
      racers: clampedRacers,
      deadline: BigInt(deadline),
    },
  });

  return {
    kind: 'resolution',
    winner,
    huntId,
    elapsedMs: clampedElapsed,
    racers: clampedRacers,
    deadline,
    signature,
    contract: env.LOOTGRID_ACTIONS_ADDRESS as Address,
    chainId: CHAIN_IDS[env.CHAIN],
    call: {
      to: env.LOOTGRID_ACTIONS_ADDRESS as Address,
      data: encodeFunctionData({
        abi: SUBMIT_ABI,
        functionName: 'submitResolution',
        args: [
          winner,
          huntId,
          clampedElapsed,
          clampedRacers,
          BigInt(deadline),
          signature,
        ],
      }),
      gas: toHex(SUBMIT_GAS),
    },
  };
}

export interface HintAttestation {
  kind: 'hint';
  hintHash: Hex;
  zoneId: Hex;
  tier: number;
  reliabilityBps: number;
  deadline: number;
  signature: Hex;
  contract: Address;
  chainId: number;
}

/**
 * Vouch for a hint a seller is listing.
 *
 * Signed with the records key rather than the payout key: this authorises
 * nothing financial by itself, it only certifies provenance. The escrow that
 * releases a buyer's money is a separate authority.
 *
 * `hintHash` binds the attestation to one specific hint without disclosing it —
 * the buyer can check afterwards that what they received hashes to what they
 * were promised.
 */
export async function signHint(
  hintHash: Hex,
  zoneId: Hex,
  tier: number,
  reliabilityBps: number,
  now: number = Date.now(),
): Promise<HintAttestation> {
  const deadline = deadlineFrom(now);

  const signature = await signer().signTypedData({
    domain: domain(),
    types: TYPES,
    primaryType: 'Hint',
    message: {
      hintHash,
      zoneId,
      tier,
      reliabilityBps,
      deadline: BigInt(deadline),
    },
  });

  return {
    kind: 'hint',
    hintHash,
    zoneId,
    tier,
    reliabilityBps,
    deadline,
    signature,
    contract: env.LOOTGRID_ACTIONS_ADDRESS as Address,
    chainId: CHAIN_IDS[env.CHAIN],
  };
}

/** Clears the cached accounts. Tests only. */
export function reset(): void {
  account = null;
  escrowAccount = null;
}
