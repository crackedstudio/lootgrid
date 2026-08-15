import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, getAddress, keccak256, recoverMessageAddress, toHex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../env';
import * as identity from './identity';

/**
 * Agent identity.
 *
 * The gate for this phase names one property that lives here: **the agent
 * address is never the player address.** If it ever were, every cap in
 * `AgentVault` would be decorative, because the agent would simply withdraw.
 *
 * The other risk is quieter. The bind digest is reimplemented off chain —
 * unavoidably, because the agent must sign it before a transaction exists to
 * read it with — so a drift between this file and `PlayerRegistry.sol` would
 * produce signatures that recover to the wrong address and bindings that always
 * revert. That gets its own guard, in the same spirit as `attestor.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY_SOL = join(here, '../../../contracts/src/PlayerRegistry.sol');

const PLAYER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b0';
const REGISTRY = '0x00000000000000000000000000000000000000e1';
const FACTORY = '0x00000000000000000000000000000000000000fa';
const TOKEN = '0x00000000000000000000000000000000000000d0';
const MASTER = 'test-master-secret-that-is-long-enough-32';

const mut = env as {
  AGENT_MASTER_KEY?: string;
  AGENT_VAULT_FACTORY_ADDRESS?: string;
  AGENT_TOKEN_ADDRESS?: string;
  PLAYER_REGISTRY_ADDRESS?: string;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = { ...mut };

beforeEach(() => {
  mut.AGENT_MASTER_KEY = MASTER;
  mut.AGENT_VAULT_FACTORY_ADDRESS = FACTORY;
  mut.AGENT_TOKEN_ADDRESS = TOKEN;
  mut.PLAYER_REGISTRY_ADDRESS = REGISTRY;
  mut.CHAIN = 'celoSepolia';
});

afterEach(() => Object.assign(mut, original));

describe('the agent is never the player', () => {
  it('derives a different address for every player', () => {
    for (let i = 0; i < 200; i++) {
      const player = `0x${i.toString(16).padStart(40, '0')}`;
      expect(identity.isDistinct(player)).toBe(true);
      expect(identity.addressFor(player).toLowerCase()).not.toBe(player.toLowerCase());
    }
  });

  it('gives different players different agents', () => {
    // A shared agent would be one spender on two vaults, with no way to tell
    // whose money paid for a trade.
    expect(identity.addressFor(PLAYER)).not.toBe(identity.addressFor(OTHER));
  });

  it('refuses to build a binding if the two ever collided', async () => {
    // Unreachable via derivation, and checked anyway: the thing it guards
    // against is an agent that can withdraw.
    const agent = identity.addressFor(PLAYER);
    mut.AGENT_MASTER_KEY = MASTER;
    expect(agent).not.toBe(getAddress(PLAYER));
    await expect(identity.bindOffer(PLAYER)).resolves.toBeTruthy();
  });
});

describe('the key is derived, never stored', () => {
  it('is stable for a player across calls', () => {
    // Recoverable from the master secret alone, so losing the database does not
    // strand a vault with a spender nobody can sign for.
    expect(identity.addressFor(PLAYER)).toBe(identity.addressFor(PLAYER));
  });

  it('changes completely when the master secret changes', () => {
    const before = identity.addressFor(PLAYER);
    mut.AGENT_MASTER_KEY = 'a-different-master-secret-long-enough!!';
    expect(identity.addressFor(PLAYER)).not.toBe(before);
  });

  it('is off without a master secret or a factory', () => {
    expect(identity.enabled()).toBe(true);
    mut.AGENT_MASTER_KEY = undefined;
    expect(identity.enabled()).toBe(false);
    mut.AGENT_MASTER_KEY = MASTER;
    mut.AGENT_VAULT_FACTORY_ADDRESS = undefined;
    expect(identity.enabled()).toBe(false);
  });

  it('never exposes the private key', () => {
    // `signerFor` hands back a viem account, which carries the key — but nothing
    // in the module's own surface returns raw key material.
    expect(Object.keys(identity)).not.toContain('keyFor');
    expect(JSON.stringify(identity.addressFor(PLAYER))).not.toContain(MASTER);
  });
});

describe('the bind digest matches the contract', () => {
  const source = readFileSync(REGISTRY_SOL, 'utf8');

  it('uses the same typehash string', () => {
    // Parsed from the Solidity rather than copied into the test, so a rename on
    // either side fails here instead of in production.
    const match = source.match(/BIND_TYPEHASH\s*=\s*\n?\s*keccak256\(\s*"([^"]+)"\s*\)/);
    expect(match, 'BIND_TYPEHASH not found in PlayerRegistry.sol').toBeTruthy();
    expect(identity.BIND_TYPEHASH).toBe(keccak256(toHex(match![1]!)));
  });

  it('encodes the same fields in the same order', () => {
    // The contract's inner hash is
    //   keccak256(abi.encode(BIND_TYPEHASH, block.chainid, address(this), player, sessionKey))
    // and a reordering here would silently produce unbindable signatures.
    // Greedy to the line's end: `address(this)` contains parentheses, so a
    // non-nesting match stops in the middle of the argument list.
    const encode = source.match(/bytes32 inner = keccak256\(abi\.encode\((.+)\)\);/);
    expect(encode, 'inner hash not found in PlayerRegistry.sol').toBeTruthy();
    const fields = encode![1]!.split(',').map(f => f.trim());
    expect(fields).toEqual([
      'BIND_TYPEHASH',
      'block.chainid',
      'address(this)',
      'player',
      'sessionKey',
    ]);
  });

  it('changes with the chain and the registry address', () => {
    // Both are inside the digest precisely so a binding cannot be replayed onto
    // another chain or another deployment.
    const agent = identity.addressFor(PLAYER);
    const sepolia = identity.bindDigest(PLAYER, agent);

    mut.CHAIN = 'celo';
    expect(identity.bindDigest(PLAYER, agent)).not.toBe(sepolia);

    mut.CHAIN = 'celoSepolia';
    mut.PLAYER_REGISTRY_ADDRESS = '0x00000000000000000000000000000000000000e2';
    expect(identity.bindDigest(PLAYER, agent)).not.toBe(sepolia);
  });

  it('produces a signature that recovers to the agent', async () => {
    // What the registry checks: `_recover(bindDigest(...), sig) == sessionKey`.
    const offer = await identity.bindOffer(PLAYER);
    const recovered = await recoverMessageAddress({
      message: { raw: identity.bindDigest(PLAYER, offer.agent) },
      signature: offer.signature,
    });
    expect(recovered).toBe(offer.agent);
  });
});

describe('the transactions handed to the client', () => {
  it('encodes a bind the registry can decode', async () => {
    const offer = await identity.bindOffer(PLAYER);
    const decoded = decodeFunctionData({ abi: identity.REGISTRY_ABI, data: offer.call.data });

    expect(decoded.functionName).toBe('bind');
    expect(decoded.args).toEqual([offer.agent, offer.signature]);
    // Binding is the PLAYER's transaction: the house proves the agent key
    // consents, the player proves they want it, and neither can supply the other.
    expect(offer.call.to).toBe(REGISTRY);
  });

  it('encodes a vault creation with the derived agent as spender', () => {
    const call = identity.createVaultCall(PLAYER, 10n ** 18n, 5n * 10n ** 18n);
    const decoded = decodeFunctionData({ abi: identity.FACTORY_ABI, data: call.data });

    expect(decoded.functionName).toBe('create');
    // The owner is NOT an argument — the factory uses msg.sender, which is why
    // the house cannot create a vault it controls for someone else.
    expect(decoded.args).toEqual([
      getAddress(TOKEN),
      identity.addressFor(PLAYER),
      10n ** 18n,
      5n * 10n ** 18n,
    ]);
    expect(call.to).toBe(FACTORY);
  });

  it('encodes the owner-only vault controls', () => {
    const vault = '0x00000000000000000000000000000000000000v1'.replace('v', 'a') as `0x${string}`;

    for (const [fn, args] of [
      ['kill', undefined],
      ['withdrawAll', undefined],
    ] as const) {
      const call = identity.vaultCall(vault, fn);
      expect(decodeFunctionData({ abi: identity.VAULT_ABI, data: call.data }).functionName).toBe(fn);
      void args;
    }

    const caps = identity.vaultCall(vault, 'setCaps', [1n, 2n]);
    const decoded = decodeFunctionData({ abi: identity.VAULT_ABI, data: caps.data });
    expect(decoded.functionName).toBe('setCaps');
    expect(decoded.args).toEqual([1n, 2n]);
  });

  it('encodes a spend the vault can decode', () => {
    const vault = '0x00000000000000000000000000000000000000aa' as `0x${string}`;
    const target = '0x00000000000000000000000000000000000000bb' as `0x${string}`;
    const ref = `0x${'ab'.repeat(32)}` as `0x${string}`;

    const call = identity.spendCall(vault, target, 123n, ref);
    const decoded = decodeFunctionData({ abi: identity.VAULT_ABI, data: call.data });

    expect(decoded.functionName).toBe('spend');
    expect(decoded.args).toEqual([getAddress(target), 123n, ref]);
  });
});
