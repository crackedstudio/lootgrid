import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from '../env';
import type { SubmitCall } from '../chain/attestor';

/**
 * Who an agent is, and how it comes to be allowed to act.
 *
 * ─────────────────────────── the key is derived, not stored ─────────────────
 *
 * There is no private key column in `009_agents.sql` and there must never be
 * one. An agent's key is derived from a single server secret and the player's
 * own address:
 *
 *     agentKey = keccak256(AGENT_MASTER_KEY ‖ playerId)
 *
 * Three things follow. The database — which is backed up by copying a file —
 * never contains anything that can move money. An agent is recoverable from the
 * master secret alone, so losing the database does not strand a player's vault
 * with a spender nobody can sign for. And there is exactly one secret to
 * protect rather than one per player.
 *
 * ─────────────────────────── blast radius, stated plainly ───────────────────
 *
 * A leaked `AGENT_MASTER_KEY` is every agent's spending rights at once. That
 * sounds worse than it is, and the bound is the whole point of the vault: the
 * attacker gets, per player, one `perTxCap` at a time, up to `perDayCap` a day,
 * to addresses that player already allowlisted, until they press kill. It
 * cannot withdraw, cannot raise a limit, and cannot stop an owner leaving.
 *
 * It is still the most dangerous secret on the box after the escrow treasury.
 * Keep it out of the game database, out of backups, and rotate by re-binding —
 * which every player must then approve, because binding is their transaction.
 *
 * ─────────────────────────── the agent is never the player ──────────────────
 *
 * Checked in three places, and that is not redundancy for its own sake: they
 * fail at different times. `PlayerRegistry.bind` reverts `SelfKey`, the vault's
 * constructor reverts `SpenderIsOwner`, and {isDistinct} below refuses before
 * either transaction is built. Derivation makes collision practically
 * impossible anyway, but "practically impossible" is not a control.
 */

/** Must match `PlayerRegistry.BIND_TYPEHASH` exactly. */
export const BIND_TYPEHASH = keccak256(
  toHex('LootGridBindSessionKey(address player,address sessionKey)'),
);

const CHAIN_IDS = { celo: 42_220, celoSepolia: 11_142_220 } as const;

export const REGISTRY_ABI = parseAbi([
  'function bind(address sessionKey, bytes sig)',
  'function sessionKeyOf(address player) view returns (address)',
]);

export const FACTORY_ABI = parseAbi([
  'function create(address token, address spender, uint256 perTxCap, uint256 perDayCap) returns (address)',
  'function vaultOf(address player) view returns (address)',
]);

export const VAULT_ABI = parseAbi([
  'function spend(address target, uint256 amount, bytes32 tradeRef)',
  'function kill()',
  'function setCaps(uint256 perTx, uint256 perDay)',
  'function setTarget(address target, bool value)',
  'function withdrawAll()',
  'function deposit(uint256 amount)',
  'function remainingToday() view returns (uint256)',
]);

/** Generous against the ~120k these measure at. */
const AGENT_GAS = 250_000n;

export function enabled(): boolean {
  return Boolean(env.AGENT_MASTER_KEY && env.AGENT_VAULT_FACTORY_ADDRESS);
}

/**
 * The agent's private key for a player.
 *
 * Deliberately not exported. Nothing outside this module needs the key — the
 * only thing anyone needs is a signature or an address, and both are available
 * above without the caller ever holding the secret.
 */
function keyFor(playerId: string): Hex {
  if (!env.AGENT_MASTER_KEY) {
    throw new Error('agent identity misconfigured — check enabled() first');
  }
  // Domain-separated so this key can never coincide with anything else derived
  // from the same master secret later.
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'address' }],
      ['lootgrid:agent:v1', env.AGENT_MASTER_KEY, playerId as Address],
    ),
  );
}

function accountFor(playerId: string) {
  return privateKeyToAccount(keyFor(playerId));
}

/** The agent's address. Safe to publish — it is a session key, not a wallet. */
export function addressFor(playerId: string): Address {
  return accountFor(playerId).address;
}

/**
 * Whether the agent and the player are different addresses.
 *
 * Derivation makes a collision astronomically unlikely, which is exactly why it
 * would never be noticed. The chain refuses it twice; this refuses it before
 * anything is built.
 */
export function isDistinct(playerId: string): boolean {
  return addressFor(playerId).toLowerCase() !== playerId.toLowerCase();
}

/**
 * The digest `PlayerRegistry.bind` will check, computed off chain.
 *
 * Reimplemented here rather than read from the contract because the agent has
 * to sign it before any transaction exists to read it with. That makes this a
 * drift risk, so `identity.test.ts` reproduces the contract's `abi.encode`
 * layout against the source — the same guard `attestor.test.ts` applies to the
 * EIP-712 types.
 */
export function bindDigest(playerId: string, agent: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
      [
        BIND_TYPEHASH,
        BigInt(CHAIN_IDS[env.CHAIN]),
        env.PLAYER_REGISTRY_ADDRESS as Address,
        playerId as Address,
        agent,
      ],
    ),
  );
}

export interface BindOffer {
  agent: Address;
  /** EIP-191 signature by the agent over {@link bindDigest}. */
  signature: Hex;
  /** The transaction the PLAYER sends. Binding is their act, never the house's. */
  call: SubmitCall;
}

/**
 * Everything needed to bind an agent, for the player to submit.
 *
 * The house proves the agent key consents; the player proves they want it. Both
 * halves are required by the contract and neither can be supplied by the other,
 * which is what stops the house binding an agent to somebody who never asked.
 */
export async function bindOffer(playerId: string): Promise<BindOffer> {
  const agent = addressFor(playerId);
  if (!isDistinct(playerId)) {
    // Unreachable in practice. Loud rather than silent, because the failure it
    // guards against is an agent that can withdraw.
    throw new Error('derived agent address equals the player address');
  }

  // EIP-191 over the raw 32 bytes: `\x19Ethereum Signed Message:\n32` ‖ inner,
  // which is what the registry's `_recover` expects.
  const signature = await accountFor(playerId).signMessage({
    message: { raw: bindDigest(playerId, agent) },
  });

  return {
    agent,
    signature,
    call: {
      to: env.PLAYER_REGISTRY_ADDRESS as Address,
      data: encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'bind',
        args: [agent, signature],
      }),
      gas: toHex(AGENT_GAS),
    },
  };
}

/**
 * The transaction that creates a player's vault.
 *
 * Sent by the player, so the vault's owner is them rather than anything the
 * house passes — see `AgentVaultFactory`. The agent address is derived, so the
 * player is not being asked to trust an address they cannot check: they can
 * recompute nothing, but they CAN read it back from the registry afterwards and
 * see the same value the vault names as its spender.
 */
export function createVaultCall(
  playerId: string,
  perTxCap: bigint,
  perDayCap: bigint,
): SubmitCall {
  return {
    to: env.AGENT_VAULT_FACTORY_ADDRESS as Address,
    data: encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'create',
      args: [env.AGENT_TOKEN_ADDRESS as Address, addressFor(playerId), perTxCap, perDayCap],
    }),
    gas: toHex(1_500_000n),
  };
}

/** Owner-only vault calls the UI needs, encoded server-side as everywhere else. */
export function vaultCall(
  vault: Address,
  fn: 'kill' | 'withdrawAll',
): SubmitCall;
export function vaultCall(
  vault: Address,
  fn: 'setCaps',
  args: [bigint, bigint],
): SubmitCall;
export function vaultCall(
  vault: Address,
  fn: 'setTarget',
  args: [Address, boolean],
): SubmitCall;
export function vaultCall(vault: Address, fn: string, args?: unknown[]): SubmitCall {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: fn as 'kill',
      args: args as [],
    }),
    gas: toHex(AGENT_GAS),
  };
}

/**
 * Sign a vault spend as the agent.
 *
 * The one place the agent key is used for money, and it produces a signed
 * transaction rather than handing the key anywhere. Note what it cannot do:
 * `AgentVault.spend` is the only function this key can call successfully, so a
 * bug that called something else here would revert rather than misbehave.
 */
export function spendCall(vault: Address, target: Address, amount: bigint, tradeRef: Hex): SubmitCall {
  return {
    to: vault,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: 'spend',
      args: [target, amount, tradeRef],
    }),
    gas: toHex(AGENT_GAS),
  };
}

/** The agent's signer, for the runtime to send transactions with. */
export function signerFor(playerId: string) {
  return accountFor(playerId);
}
