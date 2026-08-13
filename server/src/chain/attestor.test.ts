import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, getAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../env';
import * as attestor from './attestor';
import * as relayer from './relayer';

/**
 * The attestor's signature is the *only* thing authorising a self-submitted
 * record — with no trusted `msg.sender`, nothing else stops a player declaring
 * themselves winner of every hunt. Two ways that can silently break:
 *
 *   1. the EIP-712 type strings drift from the contract's type hashes, so every
 *      signature recovers to the wrong address and every submission reverts;
 *   2. the signed fields stop matching what the referee actually decided.
 *
 * Neither shows up in a unit test of either artifact alone, so this file checks
 * both — the first against the Solidity source, in the same spirit as
 * `auth/abiMatchesContract.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOLIDITY = join(here, '../../../contracts/src/LootGridActions.sol');

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ACTIONS = '0x00000000000000000000000000000000000000ac' as const;
const ALICE = '0x00000000000000000000000000000000000000a1' as const;

const ESCROW = '0x00000000000000000000000000000000000000e5' as const;
const ESCROW_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;

const mut = env as {
  ATTESTOR_PRIVATE_KEY?: string;
  LOOTGRID_ACTIONS_ADDRESS?: string;
  ESCROW_PRIVATE_KEY?: string;
  LOOTGRID_ESCROW_ADDRESS?: string;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = {
  key: mut.ATTESTOR_PRIVATE_KEY,
  address: mut.LOOTGRID_ACTIONS_ADDRESS,
  escrowKey: mut.ESCROW_PRIVATE_KEY,
  escrowAddress: mut.LOOTGRID_ESCROW_ADDRESS,
  chain: mut.CHAIN,
};

beforeEach(() => {
  mut.ATTESTOR_PRIVATE_KEY = KEY;
  mut.LOOTGRID_ACTIONS_ADDRESS = ACTIONS;
  mut.ESCROW_PRIVATE_KEY = ESCROW_KEY;
  mut.LOOTGRID_ESCROW_ADDRESS = ESCROW;
  mut.CHAIN = 'celoSepolia';
  attestor.reset();
});

afterEach(() => {
  mut.ATTESTOR_PRIVATE_KEY = original.key;
  mut.LOOTGRID_ACTIONS_ADDRESS = original.address;
  mut.ESCROW_PRIVATE_KEY = original.escrowKey;
  mut.LOOTGRID_ESCROW_ADDRESS = original.escrowAddress;
  mut.CHAIN = original.chain;
  attestor.reset();
});

/** `[{name,type},…]` → `Entry(address player,bytes32 huntId,…)` */
function encodeType(name: keyof typeof attestor.TYPES): string {
  const fields = attestor.TYPES[name].map(f => `${f.type} ${f.name}`).join(',');
  return `${name}(${fields})`;
}

/** The strings inside the contract's `keccak256("…")` type-hash constants. */
function contractTypeStrings(): string[] {
  const source = readFileSync(SOLIDITY, 'utf8');
  // Tolerates the constant being wrapped across lines by the formatter.
  return [...source.matchAll(/keccak256\(\s*"([A-Z]\w*\([^"]*\))"\s*\)/g)].map(m => m[1]);
}

describe('EIP-712 types match the contract', () => {
  const onChain = contractTypeStrings();

  it('parses type hashes from the Solidity source', () => {
    // Guards the vacuous-pass failure mode: comparing against an empty set.
    expect(onChain.length, 'no type hashes parsed from LootGridActions.sol').toBeGreaterThan(0);
  });

  it.each(['Entry', 'Resolution'] as const)(
    '%s encodes identically on both sides',
    name => {
      // A mismatch here means every signature this server issues recovers to
      // the wrong address, and every player submission reverts BadAttestation.
      expect(onChain, `${name} type string drifted from the contract`).toContain(encodeType(name));
    },
  );
});

describe('signing', () => {
  it('is disabled without a key', () => {
    mut.ATTESTOR_PRIVATE_KEY = undefined;
    expect(attestor.enabled()).toBe(false);
  });

  it('is disabled without a contract address to bind the domain to', () => {
    mut.LOOTGRID_ACTIONS_ADDRESS = undefined;
    expect(attestor.enabled()).toBe(false);
  });

  it('is enabled once both are present', () => {
    expect(attestor.enabled()).toBe(true);
  });

  it('produces an entry signature that recovers to the attestor', async () => {
    const a = await attestor.signEntry(ALICE, attestor.toBytes32Id('hunt-1'), 3);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'LootGridActions',
        version: '1',
        chainId: a.chainId,
        verifyingContract: a.contract,
      },
      types: attestor.TYPES,
      primaryType: 'Entry',
      message: {
        player: a.player,
        huntId: a.huntId,
        gameType: a.gameType,
        deadline: BigInt(a.deadline),
      },
      signature: a.signature,
    });

    expect(recovered).toBe(privateKeyToAccount(KEY).address);
    expect(a.contract).toBe(ACTIONS);
  });

  it('produces a resolution signature that recovers to the attestor', async () => {
    const a = await attestor.signResolution(ALICE, attestor.toBytes32Id('hunt-2'), 2105, 4);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'LootGridActions',
        version: '1',
        chainId: a.chainId,
        verifyingContract: a.contract,
      },
      types: attestor.TYPES,
      primaryType: 'Resolution',
      message: {
        winner: a.winner,
        huntId: a.huntId,
        elapsedMs: a.elapsedMs,
        racers: a.racers,
        deadline: BigInt(a.deadline),
      },
      signature: a.signature,
    });

    expect(recovered).toBe(privateKeyToAccount(KEY).address);
  });

  it('binds the domain to the configured chain', async () => {
    const sepolia = await attestor.signEntry(ALICE, attestor.toBytes32Id('h'), 0);
    expect(sepolia.chainId).toBe(11_142_220);

    mut.CHAIN = 'celo';
    const mainnet = await attestor.signEntry(ALICE, attestor.toBytes32Id('h'), 0);
    expect(mainnet.chainId).toBe(42_220);

    // Same message, different chain — the signatures must not be interchangeable.
    expect(mainnet.signature).not.toBe(sepolia.signature);
  });

  it('expires within the advertised window', async () => {
    const now = 1_700_000_000_000;
    const a = await attestor.signEntry(ALICE, attestor.toBytes32Id('h'), 0, now);
    expect(a.deadline).toBe(now / 1000 + attestor.DEADLINE_SECONDS);
    // Short-lived on purpose: an attestation is a bearer token.
    expect(attestor.DEADLINE_SECONDS).toBeLessThanOrEqual(900);
  });

  it('clamps values that would overflow their on-chain width', async () => {
    // uint16 racers. Signing an unclamped value would put the referee's name to
    // a number the contract would silently truncate to something else.
    const a = await attestor.signResolution(ALICE, attestor.toBytes32Id('h'), 2 ** 33, 70_000);
    expect(a.racers).toBe(65_535);
    expect(a.elapsedMs).toBe(4_294_967_295);
  });

  it('encodes entry calldata the contract can decode', async () => {
    // The browser sends this verbatim and holds no ABI to check it with, so a
    // bad encoding would only ever surface as a reverted transaction.
    const a = await attestor.signEntry(ALICE, attestor.toBytes32Id('hunt-1'), 3);
    const decoded = decodeFunctionData({ abi: attestor.SUBMIT_ABI, data: a.call.data });

    expect(decoded.functionName).toBe('submitEntry');
    expect(decoded.args).toEqual([
      getAddress(ALICE),
      a.huntId,
      3,
      BigInt(a.deadline),
      a.signature,
    ]);
    expect(a.call.to).toBe(ACTIONS);
  });

  it('encodes resolution calldata the contract can decode', async () => {
    const a = await attestor.signResolution(ALICE, attestor.toBytes32Id('hunt-2'), 2105, 4);
    const decoded = decodeFunctionData({ abi: attestor.SUBMIT_ABI, data: a.call.data });

    expect(decoded.functionName).toBe('submitResolution');
    expect(decoded.args).toEqual([
      getAddress(ALICE),
      a.huntId,
      2105,
      4,
      BigInt(a.deadline),
      a.signature,
    ]);
  });

  it('suggests a gas limit above what the calls actually cost', () => {
    // Measured at ~73-75k in the Foundry suite; the hex must clear that with
    // room, or every player submission runs out of gas.
    return attestor.signEntry(ALICE, attestor.toBytes32Id('h'), 0).then(a => {
      expect(BigInt(a.call.gas)).toBeGreaterThan(100_000n);
    });
  });

  it.each(['ridge', 'ridge-1-3x4-a1b2c3', 'x'.repeat(31), 'x'.repeat(32), 'y'.repeat(80)])(
    'encodes %s exactly as the relayer does',
    id => {
      // The attestor keeps its own copy so requiring it does not drag in the
      // relayer's database and worker. They MUST agree, or the same hunt lands
      // on chain under two different ids depending on who published it.
      expect(attestor.toBytes32Id(id)).toBe(relayer.toBytes32Id(id));
    },
  );
});

describe('payout attestations are separated from record attestations', () => {
  it('is disabled without an escrow key or address', () => {
    mut.ESCROW_PRIVATE_KEY = undefined;
    expect(attestor.escrowEnabled()).toBe(false);
    mut.ESCROW_PRIVATE_KEY = ESCROW_KEY;
    mut.LOOTGRID_ESCROW_ADDRESS = undefined;
    expect(attestor.escrowEnabled()).toBe(false);
  });

  it('signs a payout that recovers to the escrow key', async () => {
    const a = await attestor.signPayout(ALICE, attestor.toBytes32Id('hunt-1'), 2105, 4);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'LootGridEscrow',
        version: '1',
        chainId: a.chainId,
        verifyingContract: a.contract,
      },
      types: attestor.TYPES,
      primaryType: 'Resolution',
      message: {
        winner: a.winner,
        huntId: a.huntId,
        elapsedMs: a.elapsedMs,
        racers: a.racers,
        deadline: BigInt(a.deadline),
      },
      signature: a.signature,
    });

    expect(recovered).toBe(privateKeyToAccount(ESCROW_KEY).address);
    expect(a.contract).toBe(ESCROW);
  });

  it('produces a different signature from the record attestation', async () => {
    // The whole point of the separate domain: a signature minted to write a
    // public record must not also be able to move money, and vice versa.
    const huntId = attestor.toBytes32Id('hunt-1');
    const record = await attestor.signResolution(ALICE, huntId, 2105, 4, 1_700_000_000_000);
    const payout = await attestor.signPayout(ALICE, huntId, 2105, 4, 1_700_000_000_000);

    expect(record.deadline).toBe(payout.deadline);
    expect(payout.signature).not.toBe(record.signature);
    expect(payout.contract).not.toBe(record.contract);
  });

  it('uses a key that can be rotated independently', () => {
    expect(attestor.escrowAddress()).not.toBe(privateKeyToAccount(KEY).address);
  });

  it('clamps the same fields the record path does', async () => {
    const a = await attestor.signPayout(ALICE, attestor.toBytes32Id('h'), 2 ** 33, 70_000);
    expect(a.elapsedMs).toBe(4_294_967_295);
    expect(a.racers).toBe(65_535);
  });
});
