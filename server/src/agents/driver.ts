import type { Address } from 'viem';
import * as vaultChain from '../chain/agentVault';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { logger } from '../logger';
import * as market from '../market';
import * as metrics from '../metrics';
import * as referee from '../referee';
import * as store from '../store';
import type { Attempt, Hunt, Player } from '../types';
import * as budget from './budget';
import * as identity from './identity';
import { model } from './inference';
import * as reputation from './reputation';
import * as runtime from './runtime';
import { isAgentGame } from './validate';

/**
 * What actually makes an agent play.
 *
 * ─────────────────────────── the loop nothing else closes ───────────────────
 *
 * Every other module in `agents/` is a capability: a vault, a budget, a
 * protocol, a pool that can take a turn. None of them starts anything. This is
 * the thing that does — it enters hunts, asks the pool for moves, feeds them to
 * the referee, and buys hints along the way.
 *
 * Until it existed, phase 7 was a well-tested library with no callers, and the
 * question the phase asks — *do agents trade sensibly?* — had no way to be
 * answered because no agent had ever done anything.
 *
 * ─────────────────────────── the agent plays for its owner ──────────────────
 *
 * An attempt belongs to the PLAYER, not to the agent. They pay the energy, they
 * win the prize, and the `UNIQUE (hunt_id, player_id)` constraint means an agent
 * and its owner cannot both enter the same hunt. The agent is a way of playing,
 * not a second player.
 *
 * ─────────────────────────── it refuses more than it accepts ────────────────
 *
 * Most of this file is reasons not to act: wrong zone, killed on chain, hunt not
 * worth entering, budget spent, hint too dear, reliability too low. That ratio
 * is deliberate. An agent that enters everything is not an agent, it is a
 * subscription to losing money slowly.
 */

/** How often the driver looks for something to do. */
export const TICK_MS = 5_000;

/** Hunts one agent may play at once. Bounds the damage of a bad configuration. */
export const MAX_CONCURRENT = 3;

export function enabled(): boolean {
  return env.AGENTS_ENABLED && vaultChain.enabled();
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Enter hunts and take turns.
 *
 * Never throws: one agent's failure must not stop the others, and a driver that
 * died on a bad configuration would leave every other player's agent frozen
 * with money committed.
 */
export async function tick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;

  try {
    for (const agent of activeAgents()) {
      try {
        await driveOne(agent, now);
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, 'agent tick failed');
      }
    }
  } finally {
    ticking = false;
  }
}

/** Agents with a vault. One without has nothing to spend and nothing to protect. */
const activeAgents = () => agentRepo.allActive();

async function driveOne(agent: agentRepo.Agent, now: number): Promise<void> {
  const player = store.getPlayer(agent.playerId);
  if (!player || !agent.vault) return;

  const config = agentRepo.getConfig(agent.id);

  // The chain is the authority on whether this agent may still spend. A player
  // who pressed kill has a vault whose spender is zero, and the server must
  // stop handing it turns even if its own row still says active.
  const vault = await vaultChain.readVault(player.id as Address);
  if (!vault || vault.spender.toLowerCase() !== agent.id.toLowerCase()) {
    agentRepo.setStatus(agent.id, 'killed');
    logger.info({ agentId: agent.id }, 'agent revoked on chain — stopping');
    return;
  }

  // Turns first: an attempt already in flight is money already committed, and
  // finishing it beats starting another.
  const live = liveAttempts(player);
  for (const attempt of live) await takeTurn(agent, player, attempt, config, now);

  if (live.length >= MAX_CONCURRENT) return;
  await enterSomething(agent, player, config, vault, now);
}

/**
 * Attempts still waiting on a move.
 *
 * `status === 'active'` is not enough, and the difference cost an end-to-end
 * run before it was noticed. An attempt that has completed stays `active` until
 * the hunt resolves — which on an agent zone is fifteen minutes later, because
 * that is how long the settlement window holds a result open for later
 * finishers. Keep submitting into one and the module rejects the extra move as
 * `already_closed`, which is fatal, which turns a won hunt into a failed one.
 *
 * `elapsedMs` is set the moment a module says `complete`, so it is the honest
 * test for "has this already finished playing".
 */
function liveAttempts(player: Player): Attempt[] {
  return store
    .listZones()
    .filter(zone => zone.kind === 'agent')
    .flatMap(zone => store.liveHuntsIn(zone))
    .map(hunt => store.attemptOf(hunt.id, player.id))
    .filter((a): a is Attempt => !!a && a.status === 'active' && a.elapsedMs === null);
}

/**
 * Take one turn of one attempt.
 *
 * The move goes through the referee exactly as a human's would — same
 * validation, same deadline, same anti-cheat path. An agent that could submit
 * moves by a private route would be an agent playing a different game.
 */
async function takeTurn(
  agent: agentRepo.Agent,
  player: Player,
  attempt: Attempt,
  config: ReturnType<typeof agentRepo.getConfig>,
  now: number,
): Promise<void> {
  const hunt = store.getHunt(attempt.huntId);
  if (!hunt) return;

  const game = store.blockGame(hunt);
  if (!isAgentGame(game.type)) return;

  const outcome = await runtime.schedule({
    agentId: agent.id,
    playerId: player.id,
    huntId: hunt.id,
    difficulty: hunt.difficulty,
    gameType: game.type,
    config,
    // The PUBLIC spec. Handing the module's secret to a model would be handing
    // it the answer.
    spec: moduleSpec(hunt),
    state: attempt.state,
    inbox: [],
  });

  // `t` is the server's own elapsed time. A client-derived value here would be
  // an agent choosing its own timestamps, which the referee rejects for humans
  // and should not accept from us either.
  const elapsed = Math.max(0, now - attempt.startedAt);
  referee.submitInputs(
    attempt.id,
    [{ seq: attempt.lastSeq + 1, kind: outcome.move.kind, t: elapsed, ...{ value: outcome.move.value } }],
    now,
  );

  metrics.agentTurns.inc({ source: outcome.source });
}

function moduleSpec(hunt: Hunt): unknown {
  const game = store.blockGame(hunt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (store.moduleFor(game.type) as any).publicSpec(game.spec, game.secret);
}

/**
 * Enter a hunt, if any is worth entering.
 *
 * Every refusal below is a reason an agent should not be playing, and each one
 * costs nothing to check compared with what entering costs.
 */
async function enterSomething(
  agent: agentRepo.Agent,
  player: Player,
  config: ReturnType<typeof agentRepo.getConfig>,
  vault: vaultChain.VaultState,
  now: number,
): Promise<void> {
  for (const zone of store.listZones()) {
    if (zone.kind !== 'agent') continue;
    // An empty zone list means no zones, never all zones.
    if (!config.zones.includes(zone.id)) continue;

    for (const hunt of store.liveHuntsIn(zone)) {
      if (store.attemptOf(hunt.id, player.id)) continue;

      // Architecture §1, with inference on the cost side where it belongs. A
      // rational agent refuses a negative-EV hunt, so the house should not have
      // to be asked twice.
      const entrants = Math.max(1, store.chaserCount(hunt.id));
      if (!budget.viableFor(hunt.difficulty, entrants, model())) {
        metrics.agentBudgetRefusals.inc({ reason: 'not_viable' });
        continue;
      }

      const opened = referee.openAttempt(player, store.getHunt(hunt.id)!, now);
      if (!opened.ok) continue;

      logger.info({ agentId: agent.id, huntId: hunt.id }, 'agent entered a hunt');
      metrics.agentEntries.inc();
      await considerHints(agent, player, hunt.id, zone.id, config, vault, now);
      return; // One at a time: a tick that entered four hunts would be a tick
      // that spent four entry costs before learning anything about the first.
    }
  }
}

/**
 * Buy a hint, if one is worth buying.
 *
 * This is the "trade" in *do agents trade sensibly*. The agent reads the same
 * public order book a human sees, applies its owner's limits, and funds through
 * the same escrow — so it is subject to the same vouch, the same rake and the
 * same refund path. It has no private market.
 */
async function considerHints(
  agent: agentRepo.Agent,
  player: Player,
  huntId: string,
  zoneId: string,
  config: ReturnType<typeof agentRepo.getConfig>,
  vault: vaultChain.VaultState,
  now: number,
): Promise<void> {
  if (!market.enabled()) return;

  const listings = market
    .browse(zoneId, 20, now)
    .filter(l => l.huntId === huntId && l.sellerId !== player.id)
    // Cheapest first: with a fixed budget, two weak hints usually beat one
    // strong one — aggregation is what the market is for.
    .sort((a, b) => a.askCents - b.askCents);

  for (const listing of listings) {
    const decision = budget.canBuyHint(agent.id, config, {
      priceCents: listing.askCents,
      reliabilityBps: listing.reliabilityBps,
      zoneId,
    });
    if (!decision.ok) {
      metrics.agentBudgetRefusals.inc({ reason: decision.reason ?? 'unknown' });
      continue;
    }

    // The counterparty threshold, checked before money moves. Against the
    // WEIGHTED trust, never the registry's raw number — a raw score is the
    // first thing a wash farm produces, so acting on it directly would turn
    // reputation into a laundering service.
    if (!(await reputation.acceptable(listing.sellerId, config.minCounterpartyTrust))) {
      continue;
    }

    try {
      const quote = await market.buy(player, listing.id, now);
      const amount = BigInt(quote.amount);

      // The vault's own limits are checked on chain and would revert — but a
      // reverted transaction costs gas to learn what a comparison could have
      // told us for free.
      if (amount > vault.perTxCap || amount > vault.remainingToday) {
        metrics.agentBudgetRefusals.inc({ reason: 'vault_cap' });
        return;
      }

      await vaultChain.sendAsAgent(
        player.id,
        vault.address,
        identity.fundHintTradeCall(quote),
      );

      // The ledger is the server's record of what the agent committed. The
      // chain is the authority on whether it landed; `market.sync` reconciles.
      budget.record(agent.id, 'hint', listing.askCents * 1_000, {
        huntId,
        tradeRef: quote.onChainId,
      });
      metrics.agentHintPurchases.inc();
      logger.info({ agentId: agent.id, listingId: listing.id }, 'agent funded a hint trade');
      return; // One per tick. Hints are worth aggregating, not hoarding.
    } catch (err) {
      logger.warn({ err, agentId: agent.id, listingId: listing.id }, 'agent hint purchase failed');
      return;
    }
  }
}

export function start(): void {
  if (!enabled()) {
    logger.info('agent driver disabled — agents will not play');
    return;
  }
  timer = setInterval(() => {
    void tick().catch(err => logger.error({ err }, 'agent driver tick failed'));
  }, TICK_MS);
  timer.unref?.();
  logger.info({ tickMs: TICK_MS }, 'agent driver started');
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}
