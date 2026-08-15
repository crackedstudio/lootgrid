import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vaultChain from '../chain/agentVault';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import * as store from '../store';
import { freshWorld, makePlayer, teardownWorld } from '../testing/harness';
import { candidates, type DeductionState } from '../games/deduction';
import * as driver from './driver';
import * as identity from './identity';
import * as inference from './inference';
import * as runtime from './runtime';

/**
 * The loop that makes an agent an agent.
 *
 * Everything else in `agents/` is a capability. This is the only thing that
 * starts something, and until it existed the phase's question — *do agents trade
 * sensibly?* — could not be asked, because no agent had ever entered a hunt,
 * taken a turn or spent a penny.
 *
 * So these tests are about reachability first and judgement second: does an
 * agent actually play, and does it refuse the things it should.
 */

const PLAYER = '0x00000000000000000000000000000000000000a1';
const VAULT = '0x00000000000000000000000000000000000000f0';
const MASTER = 'test-master-secret-that-is-long-enough-32';

const mut = env as {
  AGENTS_ENABLED: boolean;
  AGENT_MASTER_KEY?: string;
  AGENT_VAULT_FACTORY_ADDRESS?: string;
  AGENT_TOKEN_ADDRESS?: string;
  PLAYER_REGISTRY_ADDRESS?: string;
  HINT_ESCROW_ADDRESS?: string;
  DEEPSEEK_API_KEY?: string;
  RPC_URL?: string;
  CHAIN: 'celo' | 'celoSepolia';
};
const original = { ...mut };

let agentId: string;

/** The agent zone seeded in phase 6. */
const lattice = () => store.listZones().find(z => z.kind === 'agent')!;

function setVaultOnChain(over: Partial<vaultChain.VaultState> = {}) {
  vaultChain.setTransportForTests(
    async () => ({
      address: VAULT as `0x${string}`,
      remainingToday: 10n ** 21n,
      perTxCap: 10n ** 20n,
      spender: agentId as `0x${string}`,
      ...over,
    }),
    async () => '0xhash',
  );
}

beforeEach(() => {
  freshWorld();
  runtime.reset();

  mut.AGENTS_ENABLED = true;
  mut.AGENT_MASTER_KEY = MASTER;
  mut.AGENT_VAULT_FACTORY_ADDRESS = '0x00000000000000000000000000000000000000fa';
  mut.AGENT_TOKEN_ADDRESS = '0x00000000000000000000000000000000000000d0';
  mut.PLAYER_REGISTRY_ADDRESS = '0x00000000000000000000000000000000000000e1';
  mut.HINT_ESCROW_ADDRESS = '0x00000000000000000000000000000000000000e7';
  mut.DEEPSEEK_API_KEY = 'test-key';
  mut.RPC_URL = 'http://localhost:0';
  mut.CHAIN = 'celoSepolia';

  makePlayer(PLAYER, '@owner');
  agentId = identity.addressFor(PLAYER);
  agentRepo.create(agentId, PLAYER);
  agentRepo.setVault(agentId, VAULT);
  agentRepo.putConfig(agentId, {
    ...agentRepo.getConfig(agentId),
    zones: [lattice().id],
  });

  setVaultOnChain();
  // A legal deduction probe. Enough to make progress without solving instantly.
  inference.setProviderForTests(async () => ({
    ok: true,
    text: '{"kind":"probe","value":{"kind":"parity","parity":"even"}}',
  }));
});

afterEach(() => {
  Object.assign(mut, original);
  inference.setProviderForTests(null);
  vaultChain.setTransportForTests(null, null);
  runtime.reset();
  teardownWorld();
});

/**
 * The agent's attempts, oldest first.
 *
 * A list rather than the first hit: once `MAX_CONCURRENT` is above one the agent
 * holds several at a time, and "whichever hunt sorts first" is a different
 * attempt from tick to tick. That ambiguity made the turn-taking test read a
 * freshly-entered attempt's `lastSeq` and fail on the seeds where the new hunt
 * happened to sort ahead of the old one.
 */
const attemptsOf = () =>
  store
    .liveHuntsIn(lattice())
    .map(h => store.attemptOf(h.id, PLAYER))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .sort((a, b) => a.startedAt - b.startedAt);

const attemptOf = () => attemptsOf()[0];

/** Follow one specific attempt across ticks, whatever else the agent starts. */
const attemptById = (id: string) => attemptsOf().find(a => a.id === id);

describe('an agent actually plays', () => {
  it('enters a hunt on its owner’s behalf', async () => {
    expect(attemptOf()).toBeUndefined();

    await driver.tick();

    const attempt = attemptOf();
    expect(attempt).toBeDefined();
    // The attempt belongs to the PLAYER: they pay the energy and win the prize.
    // The agent is a way of playing, not a second player.
    expect(attempt!.playerId).toBe(PLAYER);
  });

  it('takes turns through the referee, like a human', async () => {
    await driver.tick();
    const first = attemptOf()!;
    const before = first.lastSeq;

    await driver.tick();

    // Same validation, same deadline, same anti-cheat path. An agent with a
    // private route into the referee would be playing a different game.
    //
    // Followed by id: the second tick also ENTERS a hunt, so "the agent's
    // attempt" is ambiguous by the time it is read.
    expect(attemptById(first.id)!.lastSeq).toBeGreaterThan(before);
  });

  it('makes real progress rather than flailing', async () => {
    await driver.tick();
    const first = attemptOf()!;
    for (let i = 0; i < 3; i++) await driver.tick();

    // The attempt it opened first, not whichever it opened most recently — a
    // hunt entered on the last tick has had no turn yet and never will have.
    const attempt = attemptById(first.id)!;
    expect(attempt).toBeDefined();
    // Unconditional: whatever module the block drew, the moves have to have
    // moved something. A guarded assertion here would pass vacuously on two
    // thirds of the seeds.
    expect(attempt.lastSeq).toBeGreaterThan(0);

    // And where the module makes it measurable, measure it. Deduction narrows:
    // a smaller candidate set is the only evidence that turns are being *used*
    // rather than merely spent.
    if (store.blockGame(store.getHunt(attempt.huntId)!).type === 'deduction') {
      const state = attempt.state as DeductionState;
      expect(state.used).toBeGreaterThan(0);
      expect(candidates(state.answers).length).toBeLessThan(18 * 12);
    }
  });

  it('stops submitting once an attempt has finished playing', async () => {
    // Found by an end-to-end run, not by a unit test. An attempt that has
    // completed stays `active` until the hunt resolves — fifteen minutes later
    // on an agent zone, because that is how long the settlement window holds a
    // result open. Keep submitting into one and the module rejects the extra
    // move as `already_closed`, which is fatal: a won hunt becomes a failed one.
    await driver.tick();
    const attempt = attemptOf()!;

    // Mark it finished the way a module's `complete` does.
    attempt.elapsedMs = 1_234;
    const seqAtCompletion = attempt.lastSeq;

    await driver.tick();
    await driver.tick();

    expect(attempt.lastSeq).toBe(seqAtCompletion);
    expect(attempt.status).toBe('active');
    expect(attempt.failReason).toBeNull();
  });

  it('never enters the same hunt twice', async () => {
    await driver.tick();
    await driver.tick();
    await driver.tick();

    const entered = store
      .liveHuntsIn(lattice())
      .filter(h => store.attemptOf(h.id, PLAYER));
    // One shot per block, enforced by the UNIQUE constraint and respected here
    // so the driver does not burn energy discovering it.
    expect(new Set(entered.map(h => h.id)).size).toBe(entered.length);
  });
});

describe('the chain is the authority on whether it may act', () => {
  it('stops an agent the owner revoked on chain', async () => {
    // A player who pressed kill has a vault whose spender is zero. The server's
    // own row still says active, and must not be believed.
    setVaultOnChain({ spender: '0x0000000000000000000000000000000000000000' });

    await driver.tick();

    expect(agentRepo.get(agentId)!.status).toBe('killed');
    expect(attemptOf()).toBeUndefined();
  });

  it('stops when the vault has gone entirely', async () => {
    vaultChain.setTransportForTests(async () => null, async () => '0xhash');
    await driver.tick();
    expect(agentRepo.get(agentId)!.status).toBe('killed');
  });

  it('does not wake an agent without a vault', async () => {
    const other = '0x00000000000000000000000000000000000000b0';
    makePlayer(other, '@novault');
    agentRepo.create(identity.addressFor(other), other);

    // Nothing to spend and nothing to protect.
    expect(agentRepo.allActive().map(a => a.playerId)).not.toContain(other);
  });
});

describe('it refuses more than it accepts', () => {
  it('stays out of zones its owner did not choose', async () => {
    agentRepo.putConfig(agentId, { ...agentRepo.getConfig(agentId), zones: [] });

    await driver.tick();

    // An empty list means no zones, never all zones.
    expect(attemptOf()).toBeUndefined();
  });

  it('never touches a human zone', async () => {
    agentRepo.putConfig(agentId, {
      ...agentRepo.getConfig(agentId),
      zones: store.listZones().map(z => z.id),
    });

    await driver.tick();

    for (const zone of store.listZones().filter(z => z.kind === 'human')) {
      for (const hunt of store.liveHuntsIn(zone)) {
        // The reflex modules reject anything that plays them too regularly —
        // an agent entering one would be rejected for being what it is.
        expect(store.attemptOf(hunt.id, PLAYER)).toBeUndefined();
      }
    }
  });

  it('keeps going when one agent fails', async () => {
    // A driver that died on a bad configuration would freeze every other
    // player's agent with money committed.
    vaultChain.setTransportForTests(
      async () => {
        throw new Error('rpc down');
      },
      async () => '0xhash',
    );

    await expect(driver.tick()).resolves.toBeUndefined();
  });

  it('is off unless it is switched on', () => {
    mut.AGENTS_ENABLED = false;
    expect(driver.enabled()).toBe(false);
  });
});
