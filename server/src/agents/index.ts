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
import * as earnings from './earnings';
import * as identity from './identity';
import * as inference from './inference';
import * as negotiate from './negotiate';
import { personaFor } from './persona';
import * as voice from './voice';
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
  /**
   * What the FACTORY says, when the chain could be reached.
   *
   * Distinct from `vault` above, which is the one the server has recorded and
   * will let an agent spend from. They come apart in two ways that both matter
   * to whoever is looking at the screen: a vault the server lost track of (a
   * reset database, or an `attachVault` that timed out against a lagging node
   * seconds after creation), and a vault the player revoked on chain, which is
   * real and holds their money but names no spender this server can use.
   *
   * Either way the factory will refuse to make a second one, so the UI needs to
   * know a vault exists even when it cannot be spent from — otherwise it offers
   * "create" to somebody whose only possible outcome is a reverted transaction
   * they paid gas for.
   */
  vaultOnChain: { address: string; spendable: boolean } | null;
}

function view(
  agentId: string,
  playerId: string,
  onChain: { address: string; spendable: boolean } | null = null,
): AgentView {
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
    // A recorded vault is by definition on chain and spendable; saying so keeps
    // callers from having to check two fields to answer one question.
    vaultOnChain: onChain ?? (agent.vault ? { address: agent.vault, spendable: true } : null),
  };
}

/**
 * The vault this player already has, if the chain will tell us.
 *
 * Three outcomes, and collapsing any two of them is a bug: a vault, no vault,
 * or no answer. `AgentVaultFactory.create` reverts `VaultExists()` on a second
 * call, so only a confident "no vault" makes it safe to offer — and treating
 * "the RPC did not respond" as "no vault" is exactly how a player ends up
 * signing a transaction whose single possible outcome is a revert.
 *
 * `undefined` is therefore not the same as `null`. Unknown means we keep the
 * current behaviour and let the chain be the one to refuse; null means we know.
 */
async function vaultOnChain(player: Player): Promise<vaultChain.VaultState | null | undefined> {
  if (!vaultChain.enabled()) return undefined;
  try {
    return await vaultChain.readVault(player.id as Address);
  } catch {
    // readVault already logged it. A read failure must not stop a player
    // reaching their own agent screen.
    return undefined;
  }
}

/**
 * Write a vault the chain told us about into the server's record.
 *
 * Returns null rather than throwing when the vault names a different spender:
 * whether that is an error depends entirely on who asked. A player opening the
 * screen should see the truth and no exception; a player explicitly attaching
 * should be told it failed.
 */
function recordVault(
  agentId: string,
  playerId: string,
  vault: vaultChain.VaultState,
): AgentView | null {
  const expected = identity.addressFor(playerId);
  if (vault.spender.toLowerCase() !== expected.toLowerCase()) {
    // Either revoked, or pointed at a different agent entirely. Both mean the
    // server must not treat this vault as spendable.
    agentRepo.setStatus(agentId, 'killed');
    return null;
  }
  agentRepo.setVault(agentId, vault.address);
  return view(agentId, playerId);
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
 * The player's agent, reconciled against the chain.
 *
 * The row and the factory can disagree, and when they do the factory is right —
 * it is the only thing that can create a vault and it cannot forget one. The
 * server can: a restored backup, or the `attachVault` retry loop giving up
 * against a load-balanced node that had not yet seen the creation block.
 *
 * The cost of not doing this is not cosmetic. A screen driven by a row that
 * says "no vault" shows a create button, and pressing it sends a transaction
 * the factory reverts `VaultExists()` — the player pays gas to be told they
 * already have the thing they were asking for, and the button is still there
 * afterwards. So the read happens here, once, and only when the row has no
 * vault to begin with.
 */
export async function ensureReconciled(player: Player): Promise<AgentView> {
  const agent = ensure(player);
  if (agent.vault) return agent;

  const existing = await vaultOnChain(player);
  if (!existing) return agent;

  const attached = recordVault(agent.id, player.id, existing);
  // Not spendable — revoked, or naming another agent. Still worth reporting:
  // it exists, it may hold money, and it blocks creating another one.
  return attached ?? view(agent.id, player.id, { address: existing.address, spendable: false });
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

  // Ask the chain before offering to deploy. `create` reverts `VaultExists()`
  // for anybody who already has one, so an unconditional offer is an offer of a
  // transaction that can only fail — and the player pays for the attempt.
  const existing = await vaultOnChain(player);
  const attached = existing ? recordVault(agent.id, player.id, existing) : null;

  return {
    agent: agent.id,
    /** Proves the agent key agreed to this binding. The player still has to want it. */
    bind: await identity.bindOffer(player.id),
    /**
     * Creates the vault. `msg.sender` is the owner, so it can only be theirs.
     *
     * Null when the chain says they already have one: there is nothing left to
     * sign, and the client should attach rather than deploy.
     */
    createVault: existing ? null : identity.createVaultCall(player.id, perTx, perDay),
    /** What the factory says, so the client never has to guess. */
    vault: existing ? { address: existing.address, spendable: Boolean(attached) } : null,
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

  const attached = recordVault(agent.id, player.id, vault);
  // Asked for explicitly, so a mismatch is a failure the caller must hear about
  // rather than a state to render.
  if (!attached) throw conflict('vault_spender_mismatch');
  return attached;
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

  // ─────────────────────────── who the owner is watching ───────────────────
  //
  // Derived from the address, so this is not a lookup and cannot drift from the
  // character the driver is actually playing — `driver.driveOne` computes the
  // identical persona from the identical input.
  const persona = personaFor(agent.id);

  return {
    agentId: agent.id,
    status: agent.status,
    /**
     * The agent's character: its house-given callsign and the five traits the
     * driver actually reads. Shown because an owner watching a bot make choices
     * they did not configure deserves to know why it keeps doing that.
     */
    persona,
    /**
     * What it has said lately, rendered from the enums it actually sent.
     *
     * The model never wrote any of this — see `voice.ts`. An agent picks one of
     * six intents on the wire and the words are chosen here, on the way out, so
     * a rival's message can never become text in front of anyone.
     */
    said: negotiate.agreedFor(agent.id).slice(0, 5).map(thread =>
      voice.line(persona, 'accept', thread.id, {
        priceCents: thread.agreedCents ?? undefined,
      }),
    ),
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
    // The owner's money: what they set, and what is left of it. Hints only —
    // house-funded thinking is not billed to a player and must not appear as if
    // it were. See `budget.remainingToday`.
    remainingMills: budget.remainingToday(agent.id, config),
    dailyBudgetMills: config.dailyBudgetCents * MILLS_PER_CENT,
    /**
     * The house's side, shown separately rather than folded in.
     *
     * An owner should be able to tell "I am out of budget" from "the house
     * stopped funding my agent's thinking today" — they have different fixes,
     * and before the ledgers were split they rendered as the same number.
     */
    houseRemainingMills: budget.houseRemainingToday(agent.id),
    houseDailyMills: env.AGENT_HOUSE_DAILY_MILLS,
    /**
     * What it won, and whether it was worth running.
     *
     * The question an owner actually has, and one this endpoint could not answer
     * at all: it counted four kinds of cost and no income. `netMills` is
     * routinely negative — an agent that loses more races than it wins is the
     * normal case, not a bug — and showing that honestly is the point.
     *
     * Awarded, never collected: the server pays nobody, so a win here is a prize
     * the owner may now claim from escrow rather than money in hand.
     */
    position: earnings.positionOf(agent.id),
    wins: agentRepo.recentEarnings(agent.id, 25),
    entries: agentRepo.recentSpend(agent.id, 50),
  };
}
