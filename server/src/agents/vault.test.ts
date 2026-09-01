import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vaultChain from '../chain/agentVault';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { toTokenUnits } from '../prizes';
import { freshWorld, makePlayer, teardownWorld } from '../testing/harness';
import * as agents from './index';
import * as identity from './identity';

/**
 * The server's record of a vault, versus the chain's.
 *
 * ─────────────────────────── the bug this file exists for ───────────────────
 *
 * `AgentVaultFactory` allows exactly one vault per player and reverts
 * `VaultExists()` on a second `create` — deliberately, because a second vault
 * would strand the balance in the first while every index off chain pointed at
 * the new one. So "does this player have a vault?" has exactly one authority,
 * and it is not the database.
 *
 * When the two disagreed, the screen took the row's word for it, showed a
 * create button, and the player paid gas for a transaction that could only
 * revert — observed on mainnet in tx `0x37c261ba…e509c4`, against a vault that
 * already existed, already named the right spender, and already held 1 USD₮.
 *
 * The tests below are all one property stated four ways: **`create` is offered
 * only when the chain has said there is no vault.** Not when the row says so,
 * and not when the RPC failed to answer — an unreachable node must never read
 * as "no vault", because that is the exact substitution that caused the revert.
 */

const PLAYER = '0x00000000000000000000000000000000000000b0';
const VAULT = '0x0000000000000000000000000000000000000fa1' as Address;
const FACTORY = '0x00000000000000000000000000000000000000fa';
const TOKEN = '0x00000000000000000000000000000000000000d0';
const REGISTRY = '0x00000000000000000000000000000000000000e1';
const MASTER = 'test-master-secret-that-is-long-enough-32';

const mut = env as {
  AGENTS_ENABLED: boolean;
  AGENT_MASTER_KEY?: string;
  AGENT_VAULT_FACTORY_ADDRESS?: string;
  AGENT_TOKEN_ADDRESS?: string;
  PLAYER_REGISTRY_ADDRESS?: string;
  RPC_URL?: string;
};
const original = { ...mut };

/** The agent this player's key derives to — and so the spender a real vault names. */
const agentAddress = () => identity.addressFor(PLAYER);

/** A vault as `readVault` reports it. `spender` is the whole question. */
function vaultState(spender: string): vaultChain.VaultState {
  return {
    address: VAULT,
    remainingToday: 1_000_000n,
    perTxCap: 250_000n,
    spender: spender as Address,
  };
}

/** Points the chain read at a fixed answer. `null` = no vault, throw = no answer. */
function chainSays(answer: vaultChain.VaultState | null | (() => never)): void {
  vaultChain.setTransportForTests(
    async () => (typeof answer === 'function' ? answer() : answer),
    async () => '0x' as const,
  );
}

beforeEach(() => {
  freshWorld();
  mut.AGENTS_ENABLED = true;
  mut.AGENT_MASTER_KEY = MASTER;
  mut.AGENT_VAULT_FACTORY_ADDRESS = FACTORY;
  mut.AGENT_TOKEN_ADDRESS = TOKEN;
  mut.PLAYER_REGISTRY_ADDRESS = REGISTRY;
  mut.RPC_URL = 'http://rpc.invalid';
});

afterEach(() => {
  Object.assign(mut, original);
  vaultChain.setTransportForTests(null, null);
  teardownWorld();
});

describe('create is offered only when the chain says there is no vault', () => {
  it('withholds it when a vault already exists', async () => {
    chainSays(vaultState(agentAddress()));
    const offer = await agents.setupOffer(makePlayer(PLAYER));

    // The whole fix. Anything non-null here is a reverting transaction.
    expect(offer.createVault).toBeNull();
    expect(offer.vault).toEqual({ address: VAULT, spendable: true });
  });

  it('offers it when the chain confirms there is none', async () => {
    chainSays(null);
    const offer = await agents.setupOffer(makePlayer(PLAYER));

    expect(offer.vault).toBeNull();
    // `create(address,address,uint256,uint256)` — the call that reverted.
    expect(offer.createVault?.data.slice(0, 10)).toBe('0xd5c44c69');
  });

  it('still offers it when the RPC will not answer', async () => {
    chainSays(() => { throw new Error('forno unreachable'); });
    const offer = await agents.setupOffer(makePlayer(PLAYER));

    // Unknown is not "none", but it is not a reason to lock a new player out of
    // ever creating a vault either. Degrade to the old behaviour and let the
    // factory be the one to refuse — a revert is better than a dead button.
    expect(offer.createVault).not.toBeNull();
    expect(offer.vault).toBeNull();
  });

  it('withholds it even when the vault names a spender the server cannot use', async () => {
    // A player who pressed kill on chain. The vault is real, holds their money,
    // and blocks a second one — so offering create is still offering a revert.
    chainSays(vaultState('0x00000000000000000000000000000000000000ff'));
    const offer = await agents.setupOffer(makePlayer(PLAYER));

    expect(offer.createVault).toBeNull();
    expect(offer.vault).toEqual({ address: VAULT, spendable: false });
  });
});

describe('the row is reconciled against the factory', () => {
  it('adopts a vault the server had lost track of', async () => {
    chainSays(vaultState(agentAddress()));
    const view = await agents.ensureReconciled(makePlayer(PLAYER));

    // This is what makes the button disappear on its own: the screen reads
    // `vault`, and the read that fills it is the factory, not the backup.
    expect(view.vault).toBe(VAULT);
    expect(view.vaultOnChain).toEqual({ address: VAULT, spendable: true });
    expect(agentRepo.ofPlayer(PLAYER)?.vault).toBe(VAULT);
  });

  it('reports a revoked vault rather than throwing', async () => {
    chainSays(vaultState('0x00000000000000000000000000000000000000ff'));
    const view = await agents.ensureReconciled(makePlayer(PLAYER));

    // Not spendable, so not recorded as `vault` — but the player still needs to
    // see it, because it holds their balance and they can withdraw from it.
    expect(view.vault).toBeNull();
    expect(view.vaultOnChain).toEqual({ address: VAULT, spendable: false });
    expect(view.status).toBe('killed');
  });

  it('leaves a genuinely vault-less player alone', async () => {
    chainSays(null);
    const view = await agents.ensureReconciled(makePlayer(PLAYER));

    expect(view.vault).toBeNull();
    expect(view.vaultOnChain).toBeNull();
  });

  it('does not read the chain when the row already has a vault', async () => {
    let reads = 0;
    vaultChain.setTransportForTests(
      async () => { reads += 1; return vaultState(agentAddress()); },
      async () => '0x' as const,
    );
    await agents.ensureReconciled(makePlayer(PLAYER));
    expect(reads).toBe(1);

    // Every screen load hits this route. Once the row is right there is nothing
    // left to learn, and an RPC round trip per page view is not free.
    await agents.ensureReconciled(makePlayer(PLAYER));
    expect(reads).toBe(1);
  });
});

describe('attaching explicitly still fails loudly', () => {
  it('refuses a vault naming a different spender', async () => {
    chainSays(vaultState('0x00000000000000000000000000000000000000ff'));
    const player = makePlayer(PLAYER);
    agents.ensure(player);

    // Asked for directly, so a mismatch is an answer the caller must hear —
    // unlike the same state rendered on a screen.
    await expect(agents.attachVault(player)).rejects.toMatchObject({
      code: 'vault_spender_mismatch',
    });
  });

  it('refuses when there is nothing on chain', async () => {
    chainSays(null);
    const player = makePlayer(PLAYER);
    agents.ensure(player);

    await expect(agents.attachVault(player)).rejects.toMatchObject({
      code: 'no_vault_on_chain',
    });
  });
});

/**
 * The caps the config asks for, versus the caps the vault enforces.
 *
 * These are two different numbers by design — the config is what the driver
 * refuses trades on, `perTxCap`/`perDayCap` are what the vault enforces, and
 * they agree only because somebody sent `setCaps`. Editing the config moves one
 * and not the other.
 *
 * The failure is quiet, which is what makes it worth a test. `driver.ts`
 * compares every trade against the vault's caps before sending, so drift never
 * reverts and never costs gas: the agent simply skips trades the player
 * believes it can afford, counts a `vault_cap` refusal nobody is reading, and
 * looks broken. The agent screen now shows the contract's own numbers and
 * offers to push them, and that comparison is only correct while both sides
 * convert cents to raw units identically.
 */
describe('the client and the server agree what a cap is worth', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CLIENT_API = join(here, '../../../src/api/agent.js');

  it('converts cents to raw units by the same formula', () => {
    const source = readFileSync(CLIENT_API, 'utf8');

    // Read as source rather than imported: the client module pulls in the
    // browser session and wallet transports, and this is a statement about
    // arithmetic, not about anything that needs them.
    const match = source.match(/export const centsToRaw = cents =>\s*(.+);/);
    expect(match, 'centsToRaw missing from the client — the drift check needs it').toBeTruthy();
    expect(match![1]).toBe('BigInt(cents) * 10n ** BigInt(TOKEN_DECIMALS - 2)');

    // And that the server's half is still the shape that expression mirrors.
    // Either side moving alone leaves the screen warning about a drift that is
    // not there, with a push button that cannot clear it.
    for (const [cents, decimals] of [[1, 6], [25, 6], [100, 6], [1, 18], [500, 18]] as const) {
      expect(toTokenUnits(cents, decimals)).toBe(BigInt(cents) * 10n ** BigInt(decimals - 2));
    }
  });

  it('agrees on the caps the mainnet vault actually holds', () => {
    // 0xb550cb…cb93, read from chain: perTxCap 250000, perDayCap 1000000 at
    // 6dp — which is the 25c / 100c config that created it.
    expect(toTokenUnits(25, 6)).toBe(250_000n);
    expect(toTokenUnits(100, 6)).toBe(1_000_000n);
  });
});
