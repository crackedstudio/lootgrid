import type { Address } from 'viem';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { MILLS_PER_CENT } from '../market/fees';
import { toTokenUnits } from '../prizes';
import type { Player } from '../types';
import * as budget from './budget';
import { parseUpdate, type AgentConfig } from './config';
import * as driver from './driver';
import * as identity from './identity';
import * as inference from './inference';
import * as vaultChain from '../chain/agentVault';
import * as store from '../store';

/**
 * The agent service: what the HTTP layer talks to.
 *
 * ─────────────────────────── what the house can and cannot do ───────────────
 *
 * Every state change that matters is a transaction the PLAYER signs. The server
 * derives the agent key, proves it consents to being bound, encodes calldata,
 * and reads results back — but binding, funding, capping, revoking and
 * withdrawing are all the player's own transactions. That is not ceremony: it
 * is what makes "the house cannot spend your money" a property of the system
 * rather than a promise in a document.
 *
 * What the server does own is the off-chain half — the config, the ledger, the
 * inference pool — and none of it can move funds on its own.
 */

export function enabled(): boolean {
  return env.AGENTS_ENABLED && identity.enabled();
}

function requireEnabled(): void {
  if (!enabled()) throw notFound('agents_disabled');
}

export interface AgentView {
  id: string;
  playerId: string;
  vault: string | null;
  status: string;
  config: AgentConfig;
  /** Mills left today, across hints and inference together. */
  remainingMills: number;
  /** Whether the pool can actually think right now. */
  inferenceLive: boolean;
}

function view(agentId: string, playerId: string): AgentView {
  const agent = agentRepo.get(agentId)!;
  const config = agentRepo.getConfig(agentId);
  return {
    id: agent.id,
    playerId,
    vault: agent.vault,
    status: agent.status,
    config,
    remainingMills: budget.remainingToday(agentId, config),
    inferenceLive: inference.enabled(),
  };
}

/**
 * The player's agent, creating the record if this is the first time they asked.
 *
 * Creating a row is not creating an agent in any meaningful sense — there is no
 * vault, no binding and no money. It exists so the config has somewhere to live
 * before the player has committed to anything on chain.
 */
export function ensure(player: Player): AgentView {
  requireEnabled();

  const existing = agentRepo.ofPlayer(player.id);
  if (existing) return view(existing.id, player.id);

  const agentId = identity.addressFor(player.id);
  if (!identity.isDistinct(player.id)) {
    // Unreachable via derivation; loud rather than silent, because what it
    // guards against is an agent that can withdraw.
    throw conflict('agent_equals_player');
  }

  agentRepo.create(agentId, player.id);
  return view(agentId, player.id);
}

export function forPlayer(player: Player): AgentView {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');
  return view(agent.id, player.id);
}

/**
 * Everything the player must sign to bring an agent to life.
 *
 * Two transactions, in order, and both theirs: bind the agent as a session key,
 * then create the vault that names it as spender. Handed over together so the
 * UI can show the whole commitment before any of it is made.
 */
export async function setupOffer(player: Player) {
  requireEnabled();
  const agent = ensure(player);
  const config = agentRepo.getConfig(agent.id);

  const perTx = toTokenUnits(config.maxHintPriceCents, env.ESCROW_TOKEN_DECIMALS);
  const perDay = toTokenUnits(config.dailyBudgetCents, env.ESCROW_TOKEN_DECIMALS);

  return {
    agent: agent.id,
    /** Proves the agent key agreed to this binding. The player still has to want it. */
    bind: await identity.bindOffer(player.id),
    /** Creates the vault. `msg.sender` is the owner, so it can only be theirs. */
    createVault: identity.createVaultCall(player.id, perTx, perDay),
    caps: { perTxCents: config.maxHintPriceCents, perDayCents: config.dailyBudgetCents },
  };
}

/**
 * Find the player's vault on chain and record it.
 *
 * The address is READ from the factory, never accepted from the request. A
 * vault address a client could supply would be an address the server then lets
 * an agent spend against — and the factory is the only thing that knows, since
 * `vaultOf` is written at creation and by nothing else.
 *
 * Also checks the vault still names this agent as its spender. A player who
 * pressed kill on chain has a vault whose spender is zero, and recording it as
 * live would have the server handing turns to an agent the contract has already
 * revoked.
 */
export async function attachVault(player: Player): Promise<AgentView> {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');

  const vault = await vaultChain.readVault(player.id as Address);
  if (!vault) throw conflict('no_vault_on_chain');

  const expected = identity.addressFor(player.id);
  if (vault.spender.toLowerCase() !== expected.toLowerCase()) {
    // Either revoked, or pointed at a different agent entirely. Both mean the
    // server must not treat this vault as spendable.
    agentRepo.setStatus(agent.id, 'killed');
    throw conflict('vault_spender_mismatch');
  }

  agentRepo.setVault(agent.id, vault.address);
  return view(agent.id, player.id);
}

export function configure(player: Player, patch: unknown): AgentView {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');

  const result = parseUpdate(agentRepo.getConfig(agent.id), patch);
  if (!result.ok) throw badRequest('invalid_config', 'config failed validation', result.problems);

  agentRepo.putConfig(agent.id, result.config);
  return view(agent.id, player.id);
}

/**
 * Stop the agent, here and on chain.
 *
 * The row is marked immediately so the runtime refuses the next turn without
 * waiting for a block — but the row is NOT the kill switch. The returned call is,
 * and until the player sends it the agent still holds spending rights the server
 * cannot revoke. The UI must say so rather than implying otherwise.
 */
export function killOffer(player: Player) {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');

  agentRepo.setStatus(agent.id, 'killed');

  return {
    agent: agent.id,
    stoppedHere: true,
    /** Null when there is no vault yet — nothing on chain to revoke. */
    call: agent.vault ? identity.vaultCall(agent.vault as Address, 'kill') : null,
  };
}

/**
 * Pause hunting, without touching the chain.
 *
 * Distinct from {@link killOffer}, and the difference matters. Kill is an
 * incident action: it revokes on-chain spending rights, and only the player can
 * grant them again. Pause is "not right now" — the agent keeps its vault, its
 * caps and its allowance, and starts again on one tap.
 *
 * Offering only kill meant a player who wanted a break had to revoke and then
 * re-authorise on chain, paying gas twice to change their mind.
 */
export function pause(player: Player): AgentView {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');
  if (agent.status === 'killed') throw conflict('agent_killed');

  // `allActive` is what the driver sweeps, and it selects on this column — so
  // the pause takes effect on the next tick with nothing else to coordinate.
  agentRepo.setStatus(agent.id, 'paused');
  return view(agent.id, player.id);
}

/** Re-enable an agent the player stopped. Requires a vault that still names it. */
export function resume(player: Player): AgentView {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');
  if (agent.status === 'active') throw conflict('already_active');
  if (!agent.vault) throw conflict('no_vault');

  // Deliberately does NOT re-grant on-chain rights: if the player used the
  // vault's kill switch, only they can name a spender again.
  agentRepo.setStatus(agent.id, 'active');
  return view(agent.id, player.id);
}

/** The owner-only vault transactions the UI offers. All the player's to send. */
export function vaultCallFor(
  player: Player,
  action: 'withdrawAll' | 'setCaps' | 'setTarget',
  args?: { perTxCents?: number; perDayCents?: number; target?: Address; allowed?: boolean },
) {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent?.vault) throw conflict('no_vault');
  const vault = agent.vault as Address;

  if (action === 'withdrawAll') return identity.vaultCall(vault, 'withdrawAll');

  if (action === 'setCaps') {
    const perTx = args?.perTxCents;
    const perDay = args?.perDayCents;
    if (!Number.isInteger(perTx) || !Number.isInteger(perDay)) throw badRequest('bad_caps');
    return identity.vaultCall(vault, 'setCaps', [
      toTokenUnits(perTx!, env.ESCROW_TOKEN_DECIMALS),
      toTokenUnits(perDay!, env.ESCROW_TOKEN_DECIMALS),
    ]);
  }

  if (!args?.target) throw badRequest('bad_target');
  return identity.vaultCall(vault, 'setTarget', [args.target, args.allowed !== false]);
}

/** Recent spending, for the screen that answers "what has this cost me?". */
/**
 * What the agent has actually been doing — move by move.
 *
 * The ledger next door answers "what did it spend"; this answers "what did it
 * play", which is the question a player watching their agent actually has. Until
 * this existed the only honest answer was "look in the database", and an agent
 * you cannot watch is indistinguishable from one that is broken — which is
 * exactly how a genuinely working agent read for the first hour of testing.
 *
 * Inference spend is joined per hunt so a turn can be told apart from a thought:
 * mills against a hunt means a model decided it, zero means the deterministic
 * fallback did. That distinction is the whole visible difference a seat buys.
 */
export function activity(player: Player, limit = 10) {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');

  const spendByHunt = new Map<string, number>();
  for (const row of agentRepo.recentSpend(agent.id, 200)) {
    if (row.kind !== 'inference' || !row.huntId) continue;
    spendByHunt.set(row.huntId, (spendByHunt.get(row.huntId) ?? 0) + row.amountMills);
  }

  // An agent plays AS its owner, so `player_id` cannot tell their attempts
  // apart — a tutorial CRACK hunt the human played by hand carries the same id.
  //
  // The driver only ever enters AGENT zones (`enterSomething` skips every other
  // kind), so zone kind is the exact discriminator. Without this, the card
  // headed "what it is doing" showed players their own abandoned attempts and
  // attributed them to their agent.
  const isAgentHunt = (huntId: string): boolean => {
    const hunt = store.getHunt(huntId);
    if (!hunt) return false;
    return store.getZone(hunt.zoneId)?.kind === 'agent';
  };

  // Over-fetch before filtering, or a run of human attempts hides every agent
  // one behind them.
  const attempts = store
    .attemptHistory(player.id, limit * 5)
    .filter(a => isAgentHunt(a.huntId))
    .slice(0, limit)
    .map(a => ({
    attemptId: a.id,
    huntId: a.huntId,
    game: a.gameType,
    status: a.status,
    /** Turns taken. Zero on a live attempt means it has not moved yet. */
    moves: a.lastSeq,
    startedAt: a.startedAt,
    deadlineAt: a.deadlineAt,
    failReason: a.failReason,
    /** How far the module thinks it got, 0–100. */
    progress: a.progress,
    elapsedMs: a.elapsedMs,
    /** The module's own state — rounds, offers, candidates narrowed. */
    state: a.state ?? null,
    /** Mills of thinking bought for this hunt. Zero = played its own strategy. */
    thoughtMills: spendByHunt.get(a.huntId) ?? 0,
  }));

  return {
    agentId: agent.id,
    status: agent.status,
    attempts,
    /**
     * Proof of life. Without it, an agent with nothing to play is
     * indistinguishable from one that has stopped — and the honest state of a
     * quiet agent zone is "watching", not "broken".
     */
    heartbeat: driver.lastTick(),
    /**
     * Why it is not playing right now, when it is not. Null while it has a live
     * attempt. This is the sentence the UI could not say before.
     */
    idleReason: idleReasonFor(agent, agentRepo.getConfig(agent.id)),
  };
}

/**
 * The specific reason an idle agent is idle.
 *
 * Ordered from most to least actionable, because a player reading this wants
 * the thing THEY can change first. "No hunt to play" is last on purpose: it is
 * the only one that is not their fault and not their fix.
 */
function idleReasonFor(agent: agentRepo.Agent, config: AgentConfig): string | null {
  if (agent.status === 'paused') return 'Paused — press START HUNTING.';
  if (agent.status === 'killed') return 'Stopped. Its on-chain rights were revoked.';
  if (!agent.vault) return 'No vault yet — create one so it has something to spend.';
  if (config.zones.length === 0) return 'No zone chosen — pick one under WHERE IT PLAYS.';

  for (const zone of store.listZones()) {
    if (zone.kind !== 'agent' || !config.zones.includes(zone.id)) continue;
    for (const hunt of store.liveHuntsIn(zone)) {
      if (hunt.kind !== 'cash') continue;
      if (!store.attemptOf(hunt.id, agent.playerId)) return null; // something to enter
    }
  }
  return 'Watching. Every hunt it can play is already taken — waiting for a new one.';
}

export function ledger(player: Player) {
  requireEnabled();
  const agent = agentRepo.ofPlayer(player.id);
  if (!agent) throw notFound('no_agent');
  if (agent.playerId !== player.id) throw forbidden('not_your_agent');

  const config = agentRepo.getConfig(agent.id);
  return {
    remainingMills: budget.remainingToday(agent.id, config),
    dailyBudgetMills: config.dailyBudgetCents * MILLS_PER_CENT,
    entries: agentRepo.recentSpend(agent.id, 50),
  };
}
