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
const HINT_SOLIDITY = join(here, '../../../contracts/src/HintEscrow.sol');

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ACTIONS = '0x00000000000000000000000000000000000000ac' as const;
const ALICE = '0x00000000000000000000000000000000000000a1' as const;

const ESCROW = '0x00000000000000000000000000000000000000e5' as const;
const ESCROW_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;

const HINT_ESCROW = '0x00000000000000000000000000000000000000e7' as const;

const mut = env as {
  ATTESTOR_PRIVATE_KEY?: string;
  LOOTGRID_ACTIONS_ADDRESS?: string;
  ESCROW_PRIVATE_KEY?: string;
  LOOTGRID_ESCROW_ADDRESS?: string;
  HINT_ESCROW_ADDRESS?: string;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = {
  key: mut.ATTESTOR_PRIVATE_KEY,
  address: mut.LOOTGRID_ACTIONS_ADDRESS,
  escrowKey: mut.ESCROW_PRIVATE_KEY,
  escrowAddress: mut.LOOTGRID_ESCROW_ADDRESS,
  hintEscrowAddress: mut.HINT_ESCROW_ADDRESS,
  chain: mut.CHAIN,
};

beforeEach(() => {
  mut.ATTESTOR_PRIVATE_KEY = KEY;
  mut.LOOTGRID_ACTIONS_ADDRESS = ACTIONS;
  mut.ESCROW_PRIVATE_KEY = ESCROW_KEY;
  mut.LOOTGRID_ESCROW_ADDRESS = ESCROW;
  mut.HINT_ESCROW_ADDRESS = HINT_ESCROW;
  mut.CHAIN = 'celoSepolia';
  attestor.reset();
});

afterEach(() => {
  mut.ATTESTOR_PRIVATE_KEY = original.key;
  mut.LOOTGRID_ACTIONS_ADDRESS = original.address;
  mut.ESCROW_PRIVATE_KEY = original.escrowKey;
  mut.LOOTGRID_ESCROW_ADDRESS = original.escrowAddress;
  mut.HINT_ESCROW_ADDRESS = original.hintEscrowAddress;
  mut.CHAIN = original.chain;
  attestor.reset();
});

/** `[{name,type},…]` → `Entry(address player,bytes32 huntId,…)` */
function encodeType(name: keyof typeof attestor.TYPES): string {
  const fields = attestor.TYPES[name].map(f => `${f.type} ${f.name}`).join(',');
  return `${name}(${fields})`;
}

/** The strings inside a contract's `keccak256("…")` type-hash constants. */
function contractTypeStrings(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  // Tolerates the constant being wrapped across lines by the formatter.
  return [...source.matchAll(/keccak256\(\s*"([A-Z]\w*\([^"]*\))"\s*\)/g)].map(m => m[1]);
}

describe('EIP-712 types match the contract', () => {
  // Each struct is checked against the contract that actually verifies it.
  // `Hint` and `Release` live in HintEscrow — LootGridActions has never heard
  // of them, so checking them there would pass by silently finding nothing.
  const sources = [
    { file: 'LootGridActions.sol', types: ['Entry', 'Resolution'] as const, path: SOLIDITY },
    { file: 'HintEscrow.sol', types: ['Hint', 'Release'] as const, path: HINT_SOLIDITY },
  ];

  for (const { file, types, path } of sources) {
    const onChain = contractTypeStrings(path);

    it(`parses type hashes from ${file}`, () => {
      // Guards the vacuous-pass failure mode: comparing against an empty set.
      expect(onChain.length, `no type hashes parsed from ${file}`).toBeGreaterThan(0);
    });

    it.each(types)('%s encodes identically on both sides', name => {
      // A mismatch here means every signature this server issues recovers to
      // the wrong address, and every submission reverts.
      expect(onChain, `${name} type string drifted from ${file}`).toContain(encodeType(name));
    });
  }
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

  it('encodes claim calldata the escrow can decode', async () => {
    // Without this the attestation is unspendable: the winner holds a signature
    // and no way to present it, which is where phase 3 actually stood.
    const a = await attestor.signPayout(ALICE, attestor.toBytes32Id('hunt-1'), 2105, 4);
    const decoded = decodeFunctionData({ abi: attestor.ESCROW_ABI, data: a.call.data });

    expect(decoded.functionName).toBe('claim');
    expect(decoded.args).toEqual([
      getAddress(ALICE),
      a.huntId,
      2105,
      4,
      BigInt(a.deadline),
      a.signature,
    ]);
    expect(a.call.to).toBe(ESCROW);
  });

  it('encodes a withdraw the winner sends afterwards', async () => {
    // Two transactions because the escrow pays by pull: claim credits, the
    // challenge window elapses, withdraw pays. Collapsing them would remove the
    // guardian's only chance to stop a payout signed by a leaked key.
    const a = await attestor.signPayout(ALICE, attestor.toBytes32Id('hunt-1'), 2105, 4);
    const decoded = decodeFunctionData({ abi: attestor.ESCROW_ABI, data: a.withdraw.data });

    expect(decoded.functionName).toBe('withdraw');
    expect(decoded.args).toEqual([getAddress(ALICE)]);
  });

  it('points both calls at the escrow, never at the records contract', async () => {
    const a = await attestor.signPayout(ALICE, attestor.toBytes32Id('hunt-1'), 2105, 4);
    expect(a.call.to).toBe(ESCROW);
    expect(a.withdraw.to).toBe(ESCROW);
    expect(a.call.to).not.toBe(ACTIONS);
  });
});

describe('hint attestations vouch for provenance, never accuracy', () => {
  const HINT_HASH = '0x' + 'ab'.repeat(32);

  it('recovers to the records key, not the payout key', async () => {
    // A hint vouch authorises nothing financial — it only certifies that the
    // game issued this hint. Money is a separate authority.
    const a = await attestor.signHint(
      HINT_HASH as `0x${string}`,
      attestor.toBytes32Id('ridge'),
      2,
      7_000,
    );

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'HintEscrow',
        version: '1',
        chainId: a.chainId,
        verifyingContract: a.contract,
      },
      types: attestor.TYPES,
      primaryType: 'Hint',
      message: {
        hintHash: a.hintHash,
        zoneId: a.zoneId,
        tier: a.tier,
        reliabilityBps: a.reliabilityBps,
        deadline: BigInt(a.deadline),
      },
      signature: a.signature,
    });

    expect(recovered).toBe(privateKeyToAccount(KEY).address);
    expect(recovered).not.toBe(privateKeyToAccount(ESCROW_KEY).address);
    // Bound to the contract that verifies it, not to the records contract that
    // never will — otherwise every vouch recovers to the wrong address on chain.
    expect(a.contract).toBe(HINT_ESCROW);
  });

  it('is off without an escrow address to bind the domain to', () => {
    mut.HINT_ESCROW_ADDRESS = undefined;
    expect(attestor.hintEnabled()).toBe(false);
    expect(attestor.releaseEnabled()).toBe(false);
  });

  it('binds to one specific hint', async () => {
    const other = '0x' + 'cd'.repeat(32);
    const a = await attestor.signHint(HINT_HASH as `0x${string}`, attestor.toBytes32Id('ridge'), 2, 7_000);
    const b = await attestor.signHint(other as `0x${string}`, attestor.toBytes32Id('ridge'), 2, 7_000);
    expect(a.signature).not.toBe(b.signature);
  });

  it('carries the tier and its advertised reliability, and nothing about truth', async () => {
    const a = await attestor.signHint(HINT_HASH as `0x${string}`, attestor.toBytes32Id('ridge'), 3, 5_000);
    expect(a.tier).toBe(3);
    expect(a.reliabilityBps).toBe(5_000);
    // There is deliberately no field here that could disclose whether the hint
    // is correct. Certifying accuracy would mean handing over the answer.
    expect(Object.keys(a)).not.toContain('isTrue');
  });

  it('changes signature when the advertised reliability changes', async () => {
    // Otherwise a seller could relabel a tier-3 coin flip as a tier-1 near
    // certainty and the vouch would still verify.
    const honest = await attestor.signHint(HINT_HASH as `0x${string}`, attestor.toBytes32Id('ridge'), 3, 5_000);
    const inflated = await attestor.signHint(HINT_HASH as `0x${string}`, attestor.toBytes32Id('ridge'), 3, 9_000);
    expect(honest.signature).not.toBe(inflated.signature);
  });

  it('encodes a fund call the contract can decode', async () => {
    // The buyer's wallet sends this verbatim. A bad encoding of the vouch tuple
    // would only ever surface as a reverted transaction.
    const vouch = await attestor.signHint(
      HINT_HASH as `0x${string}`,
      attestor.toBytes32Id('ridge'),
      2,
      7_000,
    );
    const tradeId = attestor.toBytes32Id('trade-1');
    const call = attestor.fundCall(tradeId, ALICE, 10n ** 18n, 1_700_000_900, vouch);
    const decoded = decodeFunctionData({ abi: attestor.HINT_ESCROW_ABI, data: call.data });

    expect(decoded.functionName).toBe('fund');
    expect(decoded.args).toEqual([
      tradeId,
      getAddress(ALICE),
      10n ** 18n,
      1_700_000_900n,
      {
        hintHash: vouch.hintHash,
        zoneId: vouch.zoneId,
        tier: 2,
        reliabilityBps: 7_000,
        deadline: BigInt(vouch.deadline),
      },
      vouch.signature,
    ]);
    expect(call.to).toBe(HINT_ESCROW);
  });
});

describe('releases move money, and are a separate authority from vouches', () => {
  const HINT_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

  const release = () =>
    attestor.signRelease(attestor.toBytes32Id('trade-1'), HINT_HASH, ALICE);

  it('recovers to the payout key, not the records key', async () => {
    const a = await release();

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'HintEscrow',
        version: '1',
        chainId: a.chainId,
        verifyingContract: a.contract,
      },
      types: attestor.TYPES,
      primaryType: 'Release',
      message: {
        tradeId: a.tradeId,
        hintHash: a.hintHash,
        buyer: a.buyer,
        deadline: BigInt(a.deadline),
      },
      signature: a.signature,
    });

    // The whole separation in one assertion: a leaked vouch key can say what is
    // genuine but cannot pay for it.
    expect(recovered).toBe(privateKeyToAccount(ESCROW_KEY).address);
    expect(recovered).not.toBe(privateKeyToAccount(KEY).address);
  });

  it('binds to one trade and one buyer', async () => {
    const mine = await attestor.signRelease(attestor.toBytes32Id('trade-1'), HINT_HASH, ALICE);
    const other = await attestor.signRelease(attestor.toBytes32Id('trade-2'), HINT_HASH, ALICE);
    const someoneElse = await attestor.signRelease(
      attestor.toBytes32Id('trade-1'),
      HINT_HASH,
      '0x00000000000000000000000000000000000000b0',
    );

    expect(mine.signature).not.toBe(other.signature);
    expect(mine.signature).not.toBe(someoneElse.signature);
  });

  it('carries no amount — the escrow already knows what was paid', async () => {
    const a = await release();
    expect(Object.keys(a)).not.toContain('amount');
  });

  it('encodes settle calldata the contract can decode', async () => {
    const a = await release();
    const decoded = decodeFunctionData({ abi: attestor.HINT_ESCROW_ABI, data: a.call.data });

    expect(decoded.functionName).toBe('settle');
    expect(decoded.args).toEqual([
      a.tradeId,
      a.hintHash,
      getAddress(ALICE),
      BigInt(a.deadline),
      a.signature,
    ]);
  });
});
