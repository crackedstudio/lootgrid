import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vaultChain from '../chain/agentVault';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import * as store from '../store';
import { GRID } from '../config';
import { freshWorld, makeAgedPlayer, teardownWorld } from '../testing/harness';
import { candidates, type DeductionState } from '../games/deduction';
import * as driver from './driver';
import * as agents from './index';
import * as referee from '../referee';
import * as identity from './identity';
import * as inference from './inference';
import * as runtime from './runtime';
import { isAgentGame } from './validate';

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
/** The real player row, not a stub — `openAttempt` spends energy against it. */
let owner: ReturnType<typeof makeAgedPlayer>;

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

  owner = makeAgedPlayer(PLAYER, '@owner');
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
      // Narrowed at all, against whatever the map currently is. Written as
      // `18 * 12` when that was the grid, which stopped meaning "the whole
      // board" the moment it grew.
      expect(candidates(state.answers).length).toBeLessThan(GRID.rows * GRID.cols);
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
    makeAgedPlayer(other, '@novault');
    agentRepo.create(identity.addressFor(other), other);

    // Nothing to spend and nothing to protect.
    expect(agentRepo.allActive().map(a => a.playerId)).not.toContain(other);
  });
});

describe('it only enters hunts it can actually play', () => {
  /**
   * The mainnet bug.
   *
   * Entry checked the zone, the config and the budget; `takeTurn` additionally
   * checks `isAgentGame` and returns early when it fails. Nothing reconciled
   * the two, so the agent entered puzzle hunts — which draw reflex games in
   * EVERY zone, agent zones included, because puzzle hunts guard XP and not
   * money — then sat at zero moves until the deadline killed them.
   *
   * Observed live: 13 attempts, every one `fail_reason='timeout'` with
   * `last_seq=0`, on tap/math/memory. Each burned an entry and an energy slice
   * to learn nothing, and the loop re-entered forever because a timed-out
   * attempt is not a live one.
   */
  it('never enters a puzzle hunt, which always draws a reflex game', async () => {
    for (let i = 0; i < 6; i++) await driver.tick();

    const entered = attemptsOf();
    expect(entered.length).toBeGreaterThan(0);
    for (const a of entered) {
      const hunt = store.getHunt(a.huntId)!;
      expect(hunt.kind).toBe('cash');
    }
  });

  it('every hunt it enters yields a game it can move in', async () => {
    for (let i = 0; i < 6; i++) await driver.tick();

    for (const a of attemptsOf()) {
      const hunt = store.getHunt(a.huntId)!;
      // The property that actually matters: whatever it entered, `takeTurn`
      // must not bounce it. This is the assertion the old code failed.
      expect(isAgentGame(store.blockGame(hunt).type)).toBe(true);
    }
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

describe('what the owner is shown', () => {
  /**
   * An agent plays AS its owner, so attempts carry the owner's `player_id` and
   * nothing in the row says who chose the move.
   *
   * The activity feed therefore has to discriminate some other way, and zone
   * kind is the honest one: the driver only ever enters agent zones. Before this
   * filter existed, the card headed "what it is doing" listed the player's own
   * abandoned tutorial CRACK attempts — in human zones, in a game agents cannot
   * play at all — as though the agent had made them.
   */
  it('shows only hunts the agent could have entered', async () => {
    // The human plays a tutorial hunt by hand, in a human zone.
    const humanZone = store.listZones().find(z => z.kind === 'human')!;
    // A PUZZLE hunt: cash hunts on human zones need Prospector rank, which a
    // fresh player does not have. Agent zones exempt rank; human ones do not.
    const humanHunt = store.liveHuntsIn(humanZone).find(h => h.kind === 'puzzle')!;
    const opened = referee.openAttempt(owner, humanHunt);
    // Guard the setup: a silently refused entry would make this test pass for
    // the wrong reason, which is exactly how it first passed without the filter.
    expect(opened.ok, JSON.stringify(opened)).toBe(true);

    // The agent plays its own.
    await driver.tick();

    const { attempts } = agents.activity(owner);

    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      const hunt = store.getHunt(a.huntId)!;
      expect(store.getZone(hunt.zoneId)!.kind).toBe('agent');
    }
    // The hand-played hunt must not be attributed to the agent.
    expect(attempts.some(a => a.huntId === humanHunt.id)).toBe(false);
  });
});
