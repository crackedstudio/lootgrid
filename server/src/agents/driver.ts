import type { Address } from 'viem';
import * as vaultChain from '../chain/agentVault';
import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { logger } from '../logger';
import * as market from '../market';
import * as metrics from '../metrics';
import * as rooms from '../rooms';
import * as referee from '../referee';
import * as store from '../store';
import type { Attempt, Hunt, Player } from '../types';
import * as budget from './budget';
import * as identity from './identity';
import { model } from './inference';
import * as mailbox from './mailbox';
import * as negotiate from './negotiate';
import { conditionFor, moodFor, type Condition } from '../director/world';
import * as initiative from './initiative';
import { effective, personaFor, readyAt, type Persona } from './persona';
import type { Message } from './protocol';
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
/**
 * When the sweep last ran, and what it found.
 *
 * Exposed so a player can tell "idle" from "broken", which from the outside look
 * identical: 1,087 consecutive idle ticks and a crashed driver both render as a
 * screen that never changes. An agent that is working and has nothing to do
 * should say so.
 */
export interface Heartbeat {
  lastTickAt: number | null;
  /** Agents swept on that pass. Zero means none had a vault. */
  swept: number;
}
let heartbeat: Heartbeat = { lastTickAt: null, swept: 0 };
export const lastTick = (): Heartbeat => heartbeat;

export async function tick(now = Date.now()): Promise<void> {
  if (ticking) {
    // Counted, not silent. An overrun does not queue — it skips, and the only
    // symptom is agents being served less often. That is exactly the shape of
    // degradation nobody notices until someone complains their agent is slow.
    metrics.agentSweepSkipped.inc();
    return;
  }
  ticking = true;
  tickIndex++;

  const startedAt = Date.now();
  try {
    const agents = activeAgents();

    // ─────────────────────────── concurrent, but bounded ───────────────────
    //
    // This loop was `for (…) await driveOne(…)`, which serialised every agent
    // behind every other agent's network calls. One pass over N agents took
    // N x (chain read + whatever else), so at fifty milliseconds of RPC latency
    // a hundred agents needed five seconds — the entire tick budget — and
    // twenty thousand needed a thousand.
    //
    // Bounded rather than unbounded `Promise.all`: an unbounded fan-out would
    // open one socket per agent and trade a slow sweep for a thundering herd
    // against the RPC. The model calls underneath have their own gate
    // (`runtime.MAX_IN_FLIGHT`), so this bounds chain reads and database work,
    // not inference.
    heartbeat = { lastTickAt: now, swept: agents.length };
    await inParallel(agents, SWEEP_CONCURRENCY, async agent => {
      metrics.agentTicksTotal.inc();
      try {
        await driveOne(agent, now);
      } catch (err) {
        // One agent's failure must not stop the others — a driver that died on
        // a bad configuration would freeze every other player's agent with
        // money committed.
        logger.warn({ err, agentId: agent.id }, 'agent tick failed');
      }
    });
  } finally {
    ticking = false;
    metrics.agentSweepSeconds.observe((Date.now() - startedAt) / 1000);
  }
}

/**
 * How many agents are driven at once.
 *
 * Sized against the RPC rather than the model: each slot is mostly waiting on
 * `readVault`, and only the agents that turned out to have work reach the
 * inference queue — which does its own bounding.
 */
export const SWEEP_CONCURRENCY = 16;

/** Run `work` over `items`, at most `limit` at a time. Never rejects. */
async function inParallel<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  });
  await Promise.all(runners);
}

/** Agents with a vault. One without has nothing to spend and nothing to protect. */
const activeAgents = () => agentRepo.allActive();

/**
 * How many sweeps have run. Drives each persona's cadence.
 *
 * A counter rather than a clock: `readyAt` needs to know which tick this is, and
 * deriving that from wall time would make an agent's rhythm depend on how long
 * the previous sweep took. Agents should be irregular relative to each other,
 * not relative to the load on the box.
 */
let tickIndex = 0;

/**
 * Whether personas pace themselves.
 *
 * A seam for the same reason `inference.setProviderForTests` is one: cadence is
 * deliberate irregularity, and a test asserting that an agent enters a hunt
 * should not also be asserting which tick that agent's address happens to like.
 * Tests about entering switch it off; the tests about cadence switch it on and
 * are the only place its timing is pinned down.
 */
let cadenceEnabled = true;

/** Test-only. `null` restores the real behaviour. */
export function setCadenceForTests(on: boolean | null): void {
  cadenceEnabled = on ?? true;
}

/** Test-only: puts the sweep counter back to a known tick. */
export function resetCadenceForTests(): void {
  tickIndex = 0;
}

/**
 * The zone's weather, as one agent experiences it.
 *
 * Read for the agent's FIRST configured zone rather than all of them. An agent
 * in two zones is standing in two weathers and there is no honest way to average
 * them — and the alternative, threading a condition down to every per-hunt
 * decision, would put a world lookup inside the entry loop for a mood that
 * changes every ninety seconds. First zone, one lookup, documented.
 *
 * Returns null when the agent has no zones, which is a real state: `config.zones`
 * empty means no zones, never all zones.
 */
function weatherFor(config: ReturnType<typeof agentRepo.getConfig>, now: number): Condition | null {
  const zoneId = config.zones[0];
  if (!zoneId) return null;

  const zone = store.getZone(zoneId);
  if (!zone) return null;

  const hunts = store.liveHuntsIn(zone);
  return conditionFor(
    zoneId,
    {
      population: rooms.roomSize(rooms.zoneRoom(zoneId)),
      openHunts: hunts.length,
      activeChasers: hunts.reduce((n, h) => n + store.chaserCount(h.id), 0),
    },
    now,
  );
}

/**
 * The owner's configuration, as this agent in this weather will play it.
 *
 * Two narrowings, applied in order, and neither may widen anything:
 *
 *   1. The persona spends somewhere inside the owner's ceiling (`persona.ts`).
 *   2. The weather bends the persona — keener in a goldrush, quieter in a hush.
 *
 * The mood is applied to the TRAITS and then re-clamped through `effective`,
 * rather than to the resulting cents. That ordering is what keeps the guarantee
 * intact: `effective` is the only thing that ever writes a spending number, and
 * it cannot emit one above the owner's own. A mood multiplier applied afterwards
 * would be a second writer, and the first weather above 1.0 would quietly lift
 * an owner's budget.
 */
function temperedConfig(
  base: ReturnType<typeof agentRepo.getConfig>,
  persona: Persona,
  condition: Condition | null,
): ReturnType<typeof agentRepo.getConfig> {
  if (!condition) return effective(base, persona);

  const mood = moodFor(condition);
  return effective(base, {
    ...persona,
    boldness: clamp100(persona.boldness * mood.boldness),
    chattiness: clamp100(persona.chattiness * mood.chattiness),
  });
}

const clamp100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

async function driveOne(agent: agentRepo.Agent, now: number): Promise<void> {
  const player = store.getPlayer(agent.playerId);
  if (!player || !agent.vault) return;

  // ─────────────────────────── who this agent is ───────────────────────────
  //
  // Derived, not stored: same address, same character, every process, forever.
  // The owner's config is still the ceiling — `temperedConfig` may only narrow
  // it, never widen it — so personality changes how an agent plays and cannot
  // change what it is permitted to spend.
  const persona = personaFor(agent.id);
  const base = agentRepo.getConfig(agent.id);
  // Read once and carried down: the weather is a per-zone lookup, and fetching
  // it again inside the entry loop would turn one call per zone per epoch into
  // one per agent per tick — which is the cost model this whole approach exists
  // to avoid.
  const weather = weatherFor(base, now);
  const config = temperedConfig(base, persona, weather);

  // ─────────────────────────── decide before reading the chain ───────────────
  //
  // This is the whole scaling change, and it is an ordering one.
  //
  // The vault read used to happen first, unconditionally — one RPC call per
  // agent per five-second tick, whether or not that agent had anything to do.
  // At a hundred seats that is 1.7 million reads a day, overwhelmingly to
  // answer "nothing changed" about an agent that was idle anyway. At twenty
  // thousand it was four thousand reads a second, and it was the reason the
  // sweep could not finish.
  //
  // Most ticks, most agents are idle: no attempt in flight, no message waiting,
  // and nothing on the board worth entering. Working that out is local — a few
  // indexed reads and some arithmetic — so it happens first, and an idle agent
  // now costs no network at all.
  //
  // Revocation latency is unaffected, which is why this is better than caching
  // the read. The chain is still consulted immediately before anything that
  // spends; the only agents we stop checking are the ones not about to act, and
  // an agent that does nothing can do no harm. A killed agent is still caught
  // the moment it tries to do something.
  const live = liveAttempts(player);
  const hasMail = mailbox.pending(agent.id, now) > 0;
  const wantsEntry = live.length < MAX_CONCURRENT && hasSomethingToEnter(player, config);

  if (live.length === 0 && !hasMail && !wantsEntry) {
    metrics.agentTicksIdle.inc();
    return;
  }

  // The chain is the authority on whether this agent may still spend. A player
  // who pressed kill has a vault whose spender is zero, and the server must
  // stop handing it turns even if its own row still says active.
  const vault = await vaultChain.readVault(player.id as Address);
  if (!vault || vault.spender.toLowerCase() !== agent.id.toLowerCase()) {
    agentRepo.setStatus(agent.id, 'killed');
    logger.info({ agentId: agent.id }, 'agent revoked on chain — stopping');
    return;
  }

  // Answer the post before doing anything else. A counterparty waiting on a
  // reply is a deal in progress, and threads expire — letting one lapse while
  // this agent went looking for a new hunt would be losing a trade it had.
  const inbox = answerMessages(agent, player, config, now);
  await settleAgreements(agent, player, vault, now);

  // Turns first: an attempt already in flight is money already committed, and
  // finishing it beats starting another.
  for (const attempt of live) await takeTurn(agent, player, attempt, config, inbox, now);

  if (live.length >= MAX_CONCURRENT) return;

  // ─────────────────────────── cadence, and where it may not go ──────────────
  //
  // Temperament gates STARTING something new, and nothing else. It sits here,
  // below the vault read, rather than up with the idle check where it would
  // save an RPC — because an agent pausing for character still has work, and an
  // agent with work must still be checked against the chain. Gating earlier
  // made a revoked agent look idle and left it `active` for up to five ticks,
  // which is a revocation the owner asked for and did not get.
  //
  // The saving was never the point. An attempt in flight and a rival waiting on
  // a reply are both handled above this line: a persona may set the pace at
  // which an agent begins things, never the pace at which it honours them.
  if (cadenceEnabled && !readyAt(agent.id, persona, tickIndex)) {
    metrics.agentTicksHeld.inc();
    return;
  }

  await enterSomething(agent, player, config, vault, persona, weather, now);
}

// ─────────────────────────── talking to rivals ───────────────────────────

/**
 * Read the inbox and reply.
 *
 * Every reply comes from {@link negotiate}, which is arithmetic — no model is
 * consulted about whether to spend money, because a message from a rival is
 * attacker-controlled input and the strongest containment available is that it
 * arrives at a function which cannot be persuaded of anything.
 *
 * The model does still see the conversation: the inbox is passed to
 * `runtime.schedule`, which renders it through the protocol's fixed templates so
 * an agent deciding how to play a hunt knows what rivals are offering. What it
 * does not get is the chequebook.
 */
function answerMessages(
  agent: agentRepo.Agent,
  player: Player,
  config: ReturnType<typeof agentRepo.getConfig>,
  now: number,
): Message[] {
  const inbox = mailbox.take(agent.id, now);

  for (const message of inbox) {
    const thread = negotiate.getThread(message.thread, now);
    // A message naming a thread nobody opened is the cheapest thing a hostile
    // agent can send. It costs a `continue`.
    if (!thread) continue;

    const stance = stanceFor(agent, player, thread, config, now);
    if (!stance) continue;

    const reply = negotiate.respond(agent.id, message, stance, now);
    if (!reply) continue;

    const to = thread.buyerId === agent.id ? thread.sellerId : thread.buyerId;
    mailbox.send(agent.id, to, reply, now);
  }

  // Handed on to the turn, where `runtime` renders them through the protocol's
  // fixed templates. The model reads what rivals said; it decided none of it.
  return inbox;
}

/**
 * Which side of a thread this agent is on, and what it knows.
 *
 * Returns null when the listing has gone — sold, cancelled or expired under the
 * conversation. Answering about a listing that no longer exists would be
 * negotiating over nothing.
 */
function stanceFor(
  agent: agentRepo.Agent,
  player: Player,
  thread: negotiate.Thread,
  config: ReturnType<typeof agentRepo.getConfig>,
  now: number,
): negotiate.Stance | null {
  const listing = market.browse(null, 200, now).find(l => l.id === thread.listingId);
  if (!listing) return null;

  const side = thread.sellerId === agent.id ? 'seller' : 'buyer';
  if (side === 'seller' && listing.sellerId !== player.id) return null;

  return {
    side,
    config,
    // The market's own valuation, not one this module invents. A ceiling
    // computed here would be a second opinion about what a hint is worth.
    rationalCeilingCents: side === 'buyer' ? listing.suggestedCents : undefined,
    minTradeCents: side === 'seller' ? market.MIN_TRADE_CENTS : undefined,
    reliabilityBps: listing.reliabilityBps,
    zoneId: listing.zoneId,
  };
}

/**
 * Turn an agreed price into a trade.
 *
 * Deliberately reuses the market's existing bid path rather than inventing a
 * second way for money to move: the buyer bids at the agreed price, the seller
 * accepts, and the buyer funds the resulting quote through the same escrow,
 * vouch and rake as every other trade. The conversation decides; the market
 * still executes.
 */
async function settleAgreements(
  agent: agentRepo.Agent,
  player: Player,
  vault: vaultChain.VaultState,
  now: number,
): Promise<void> {
  if (!market.enabled()) return;

  for (const thread of negotiate.agreedFor(agent.id, now)) {
    try {
      if (thread.buyerId === agent.id) {
        await fundAgreed(agent, player, thread, vault, now);
      } else {
        await acceptAgreed(player, thread, now);
      }
    } catch (err) {
      logger.warn({ err, agentId: agent.id, thread: thread.id }, 'settling an agreed price failed');
      negotiate.close(thread.id);
    }
  }
}

/**
 * Seller side: take the bid that matches what was agreed.
 *
 * Awaited rather than fired off. `acceptBid` is async, so `void`-ing it sends
 * any rejection past the caller's try/catch as an unhandled rejection — and it
 * does reject in the ordinary case where the hunt ended while the two agents
 * were still talking.
 */
async function acceptAgreed(player: Player, thread: negotiate.Thread, now: number): Promise<void> {
  const bid = market
    .bidsFor(player, thread.listingId, now)
    .find(b => b.status === 'open' && b.priceCents === thread.agreedCents);
  if (!bid) return; // The buyer has not placed it yet. Next tick.

  await market.acceptBid(player, bid.id, now);
  negotiate.markSettled(thread.id, bid.id);
}

/** Buyer side: place the bid, then fund it once the seller has accepted. */
async function fundAgreed(
  agent: agentRepo.Agent,
  player: Player,
  thread: negotiate.Thread,
  vault: vaultChain.VaultState,
  now: number,
): Promise<void> {
  const price = thread.agreedCents;
  if (price === null) return;

  if (!thread.bidId) {
    // At or above the ask there is nothing to bid on — the market refuses such a
    // bid, correctly, so take the listing instead.
    const listing = market.browse(null, 200, now).find(l => l.id === thread.listingId);
    if (!listing) return negotiate.close(thread.id);

    const quote =
      price >= listing.askCents
        ? await market.buy(player, thread.listingId, now)
        : null;

    if (quote) {
      await fund(agent, player, thread, quote, vault, now);
      return;
    }

    negotiate.markBid(thread.id, market.bid(player, thread.listingId, price, now).id);
    return; // The seller accepts on their own tick.
  }

  const bid = market.getBidFor(player, thread.bidId);
  if (!bid || bid.status !== 'accepted') return;

  await fund(agent, player, thread, await market.quoteAcceptedBid(player, thread.bidId, now), vault, now);
}

async function fund(
  agent: agentRepo.Agent,
  player: Player,
  thread: negotiate.Thread,
  quote: market.Quote,
  vault: vaultChain.VaultState,
  now: number,
): Promise<void> {
  const amount = BigInt(quote.amount);
  if (amount > vault.perTxCap || amount > vault.remainingToday) {
    metrics.agentBudgetRefusals.inc({ reason: 'vault_cap' });
    return negotiate.close(thread.id);
  }

  await vaultChain.sendAsAgent(player.id, vault.address, identity.fundHintTradeCall(quote));
  budget.record(agent.id, 'hint', quote.priceCents * 1_000, {
    huntId: quote.listingId,
    tradeRef: quote.onChainId,
  });
  metrics.agentHintPurchases.inc();
  logger.info(
    { agentId: agent.id, thread: thread.id, priceCents: quote.priceCents },
    'agent funded a negotiated hint trade',
  );
  negotiate.close(thread.id);
  void now;
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
/**
 * Is there any hunt this agent would actually enter?
 *
 * Deliberately the same predicate `enterSomething` applies, minus the side
 * effects — zone permitted, not already attempted, and viable at the current
 * entrant count. Cheap: indexed reads and arithmetic, no chain and no model.
 *
 * Kept beside `enterSomething` on purpose. If the two drift, an agent either
 * wakes for nothing or sleeps through a hunt it wanted, and the second is the
 * expensive direction.
 */
/**
 * Whether this agent could actually take a turn in this hunt.
 *
 * `takeTurn` refuses anything `isAgentGame` rejects, and entry used to not check
 * — so the agent entered hunts it could never play, sat through them at zero
 * moves, and lost every one to the deadline. Observed on mainnet: thirteen
 * attempts, all `fail_reason='timeout'`, all `last_seq=0`, on tap/math/memory.
 * Each cost an entry and an energy slice to learn nothing.
 *
 * Only CASH hunts qualify, and that is a fact about the pools rather than a
 * shortcut: `gameTypeForBlock` returns from PUZZLE_GAMES for every puzzle hunt
 * regardless of zone kind — deliberately, since puzzle hunts guard XP and not
 * money — while `cashGamesFor('agent')` is exactly ['deduction','negotiation',
 * 'search'], which is exactly what `isAgentGame` admits.
 *
 * Deliberately NOT `isAgentGame(store.blockGame(hunt).type)`: `blockGame` picks,
 * persists and commits the block's game on first call, so asking it "could I
 * play this?" would materialise a game for every hunt merely by looking.
 */
function playable(hunt: { kind: string }): boolean {
  return hunt.kind === 'cash';
}

function hasSomethingToEnter(
  player: Player,
  config: ReturnType<typeof agentRepo.getConfig>,
): boolean {
  for (const zone of store.listZones()) {
    if (zone.kind !== 'agent') continue;
    if (!config.zones.includes(zone.id)) continue;

    for (const hunt of store.liveHuntsIn(zone)) {
      if (store.attemptOf(hunt.id, player.id)) continue;
      if (!playable(hunt)) continue;
      const entrants = Math.max(1, store.chaserCount(hunt.id));
      if (budget.viableFor(hunt.difficulty, entrants, model())) return true;
    }
  }
  return false;
}

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
  inbox: Message[],
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
    inbox,
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

  // Every move, as it happens. `source` is the honest part: 'model' means a seat
  // paid for the decision, 'fallback' means the deterministic line played it.
  rooms.toPlayer(player.id, {
    t: 'agent:move',
    huntId: hunt.id,
    game: game.type,
    move: outcome.move.kind,
    source: outcome.source,
    seq: attempt.lastSeq + 1,
    at: now,
  });
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
  persona: Persona,
  weather: Condition | null,
  now: number,
): Promise<void> {
  // ─────────────────────────── choose, rather than take the first ───────────
  //
  // This loop used to enter the first viable hunt in whatever order the zone
  // listed them. Every agent shares that order, so every agent made the same
  // choice at the same moment for the same reason — the most mechanical thing a
  // watching player could notice.
  //
  // Now every viable hunt is gathered and `initiative.choose` picks the one this
  // particular agent wants most, or none. It costs no inference: persona and EV
  // are free, and the model's only influence is the zone's weather, which was
  // already fetched once for the whole zone.
  const candidates: Array<initiative.Candidate & { zoneId: string }> = [];

  for (const zone of store.listZones()) {
    if (zone.kind !== 'agent') continue;
    // An empty zone list means no zones, never all zones.
    if (!config.zones.includes(zone.id)) continue;

    for (const hunt of store.liveHuntsIn(zone)) {
      if (store.attemptOf(hunt.id, player.id)) continue;
      if (!playable(hunt)) continue;

      // Architecture §1, with inference on the cost side where it belongs. A
      // rational agent refuses a negative-EV hunt, so the house should not have
      // to be asked twice.
      const entrants = Math.max(1, store.chaserCount(hunt.id));
      if (!budget.viableFor(hunt.difficulty, entrants, model())) {
        metrics.agentBudgetRefusals.inc({ reason: 'not_viable' });
        continue;
      }

      candidates.push({ huntId: hunt.id, difficulty: hunt.difficulty, entrants, zoneId: zone.id });
    }
  }

  const picked = initiative.choose(candidates, persona, weather, model(), agent.id);
  if (!picked) {
    // A real answer, not a failure: nothing on this board was worth taking, so
    // the agent waits for a better one. An agent that entered everything would
    // be a subscription to losing money slowly.
    if (candidates.length > 0) metrics.agentEntriesDeclined.inc();
    return;
  }

  {
      const choice = candidates.find(c => c.huntId === picked.candidate.huntId)!;
      const hunt = store.getHunt(choice.huntId)!;
      const zone = { id: choice.zoneId };

      const opened = referee.openAttempt(player, hunt, now);
      if (!opened.ok) return;

      logger.info(
        { agentId: agent.id, huntId: hunt.id, score: picked.score },
        'agent entered a hunt',
      );
      metrics.agentEntries.inc();
      // Tell the owner. An agent that plays invisibly is indistinguishable from
      // one that is broken — which is how a working one read for an hour of
      // testing, because the only evidence was a log line on the server.
      rooms.toPlayer(player.id, {
        t: 'agent:entered',
        huntId: hunt.id,
        zoneId: zone.id,
        at: now,
      });
      await considerHints(agent, player, hunt.id, zone.id, config, vault, now);
      // One at a time: a tick that entered four hunts would be a tick that
      // spent four entry costs before learning anything about the first.
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
      // Too dear at the asking price is not the same as not worth having. If the
      // seller is an agent, ask — that is the whole point of a negotiation
      // protocol, and before this the agent simply walked past every listing
      // priced above its limit without ever finding out whether it had to be.
      if (decision.reason === 'hint_price') {
        openNegotiation(agent, listing, config, now);
      }
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

/**
 * Open a thread with the agent behind a listing.
 *
 * Returns quietly when the seller is a person: a human has no inbox, and a
 * thread nobody can answer would sit until it expired while the buyer believed
 * it had a negotiation running. Agent-to-agent only, by construction.
 */
function openNegotiation(
  agent: agentRepo.Agent,
  listing: market.ListingView,
  config: ReturnType<typeof agentRepo.getConfig>,
  now: number,
): void {
  const seller = agentRepo.ofPlayer(listing.sellerId);
  if (!seller || seller.status !== 'active' || seller.id === agent.id) return;
  if (negotiate.hasThreadFor(agent.id, listing.id, now)) return;

  const threadId = `th_${listing.id}_${agent.id.slice(2, 10)}`;
  negotiate.openThread(threadId, listing.id, agent.id, seller.id, listing.askCents, now);

  mailbox.send(
    agent.id,
    seller.id,
    negotiate.open(agent.id, threadId, listing.zoneId, config.maxHintPriceCents, config.minReliabilityBps),
    now,
  );
  logger.info(
    { agentId: agent.id, listingId: listing.id, askCents: listing.askCents },
    'agent opened a negotiation',
  );
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
