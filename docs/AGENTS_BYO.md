# Bring Your Own Agent

**Decision:** players run their own agents against a documented API. The house
stops hosting inference and stops polling on their behalf.

**Status:** decided, not built. §5 is the work.

---

## 1. Why, in one table

The question was whether to host agents for up to 20,000 players or let players
plug their own in. The numbers below are from this repo, not estimates — see
`server/src/agents/budget.ts` for the measured model pricing and
`server/src/agents/driver.ts` for the loop.

| | House-hosted | Bring your own |
| --- | --- | --- |
| Who pays to think | **The house.** Metered to the agent's ledger, charged to nobody | The player |
| Cost per hunt-attempt | $0.0013 (flash) / $0.0026 (pro) | same, paid by them |
| Polling cost | 1 on-chain `readVault()` **per agent per 5s tick** | none — they call us |
| Ceiling at 20k agents | **~100 agents**, for throughput reasons | HTTP rate limits |
| Inference vs prize at 20k entrants on one $5 hunt | **$26 spent to give away $5** | $0 to the house |

The important thing this table says: **the LLM bill was never the binding
constraint.** Two other things break first, and they break at a hundred agents
rather than twenty thousand.

### 1.1 The throughput wall

`driver.tick()` iterates agents sequentially with `await`, and `driveOne()` does
an on-chain `readVault()` before doing anything else — correctly, because the
chain is the authority on whether a killed agent may still spend.

At 50ms of RPC latency, one pass over 20,000 agents takes **1,000 seconds**
against a **5-second** tick. The loop would never complete a single sweep. No
budget fixes this; it is a serialisation problem.

    20ms/agent  → one pass 400s   → ceiling ~250 agents
    50ms/agent  → one pass 1,000s → ceiling ~100 agents
    200ms/agent → one pass 4,000s → ceiling ~25 agents

### 1.2 The RPC bill

20,000 agents × 17,280 ticks/day = **345.6M reads/day, 4,000/sec sustained** —
overwhelmingly returning "nothing changed".

### 1.3 The inference cap is on the wrong side of the ledger

`INFERENCE_SHARE_OF_PRIZE = 0.1` bounds what **one** agent may spend thinking
about **one** hunt. Nothing bounds how many agents think about the same hunt.

| Entrants on one $5 hunt | House pays |
| --- | --- |
| 100 | $0.13 |
| 1,000 | $1.30 |
| 5,000 | **$6.50** — exceeds the prize |
| 20,000 | **$26.00** |

The *authorised* ceiling is worse: 20,000 × $0.50 each = **$10,000 of house
money permitted against a single $5 prize.**

`budget.viableFor()` is not a defence here, and the reason is worth stating
precisely. It asks *"is this hunt +EV for the agent"*, and an agent's expected
share is `prize ÷ entrants` — so it divides. The house pays **per** entrant,
with no divisor. The check protects exactly the wrong party.

At 20,000 agents × 5 hunts/day the house pays **$3,900/month of inference**
against a **$100–300/month** prize floor: inference at 13–39× the pool it is
competing for.

### 1.4 And there is nothing for them to play anyway

One agent zone (`lattice`), `HUNTS_PER_ZONE = 24`, `CASH_PER_ZONE = 1`, agent
TTL 72h — **0.33 cash hunts per day.** Twenty thousand agents competing for that
is not a game at any price.

The review already reached this conclusion from the other direction (§8): *"The
agent layer becomes the story, not the product. Keep it, demo it, but don't ask
a regular MiniPay user to configure an AI agent."* Hosting 20,000 agents is
building it as the product.

---

## 2. What BYO actually changes

Three things move, and one thing does not.

**Inference moves to the player.** ~$0.0013 per hunt, which is near-free for
them too — and it is cheap for a structural reason worth keeping: the game
modules cap how much thinking a hunt can absorb. `DEDUCTION.budget.hard = 12`
probes, `SEARCH.probes.hard = 5`, `NEGOTIATION.rounds.hard = 5`. A hunt is
about ten to thirteen model calls because the *rules* say so, not because an
agent is being polite. That bound is what makes BYO viable for a hobbyist.

**Polling disappears.** Their agent calls us when it wants to act. The house
pays for HTTP and rate limiting, which it already pays for humans.

**The incentive inverts.** Today the house funds an agent's looping — a badly
written agent costs us money and costs its owner nothing. Under BYO a looping
agent burns its owner's credits. Nobody has to police it.

**What does not change: the vault.** Spending authority stays exactly where it
is, on chain, and that is the reason BYO is safe rather than merely cheaper.

---

## 3. What already exists

Most of the surface is built. This section is an inventory so §5 is honest about
what is left.

### 3.1 Identity and authority

| Piece | Where | What it gives a BYO agent |
| --- | --- | --- |
| Session-key binding | `PlayerRegistry.bind` | The agent signs as itself, never as the player. Reverts `SelfKey` if they are the same address |
| Spending vault | `contracts/src/AgentVault.sol` | `spend()` is the only function the agent can call. Bounded by `perTxCap`, `perDayCap`, and an owner-set allowlist |
| Kill switch | `AgentVault.kill()` | Owner-only, immediate. Sets spender to zero — the safe state |
| Revocation is honoured | `driver.driveOne` reads the vault before acting | Must be preserved: see §5.3 |

The vault cannot withdraw, cannot raise its own limits, cannot change the
allowlist, and cannot survive `kill()` by a block. That is the whole reason a
stranger's code may hold a session key at all.

### 3.2 The request contract

Every authenticated call is signed. `server/src/auth/canonical.ts`:

    lootgrid-http-v1
    <player address, lowercased>
    <METHOD>
    <path, including query string>
    <timestamp>
    <nonce>
    <sha256 of the body>

joined with `\n`, sent as:

    x-player     the acting identity
    x-timestamp  ms epoch
    x-nonce      single-use
    x-signature  secp256k1 over the canonical string

Three properties a BYO integrator needs to know, and all three are deliberate:

- **The identity is inside the signature.** A captured request cannot be
  replayed under a different claimed player.
- **The path includes the query string.** A signature cannot be reused with
  different filters.
- **The domain prefix separates HTTP from WebSocket.** An HTTP signature can
  never be replayed as a socket handshake.

### 3.3 Rate limits, already per-identity

    RATE_GLOBAL_PER_MIN   600   every endpoint, per player
    RATE_PREAUTH_PER_MIN   60   per IP, before any verification work
    RATE_TILE_PER_MIN     120   digs and surveys
    RATE_ATTEMPT_PER_MIN   30   hunt entries and shop
    RATE_MARKET_PER_MIN    60   listings, bids, trades

These already bound a BYO agent's request volume without a single new control.

### 3.4 The zone split is load-bearing

`games/index.ts` draws from different module pools per zone kind, and this is
not cosmetic:

    HUMAN_CASH_GAMES = ['crack']
    AGENT_CASH_GAMES = ['deduction', 'negotiation', 'search']

The reflex modules (`tap`, `math`, `sequence`, `memory`) are absent from both
cash pools now, but `tap` additionally **rejects any player whose intervals are
too regular to be human** (σ≈0 check). A BYO agent that wandered onto a human
puzzle hunt would be failed for being what it is.

That protection is structural rather than a flag: the bot checks live inside
modules that agent zones never select. Keep it that way — a config flag could be
wrong for a human zone, an empty list cannot be.

---

## 4. What is missing

Four things, in the order they block a BYO agent.

### 4.1 The mailbox has no HTTP surface

**The largest gap.** Agent-to-agent negotiation — three phases of work: `a2a`,
`negotiate`, `mailbox`, counterparty trust — runs entirely in-process. The
driver reads its own inbox by calling `mailbox.take()` directly. There is no
endpoint.

A BYO agent therefore **cannot negotiate at all**, which removes the single most
interesting thing the agent layer does. Needs:

    GET  /agent/messages      take the inbox (destructive read, as today)
    POST /agent/messages      send to a counterparty

with `mailbox.PER_SENDER_QUOTA = 4`, `MAX_INBOX = 32` and `TTL_MS = 5min`
enforced as they are now. The quota is what stops a stranger's agent flooding
another's inbox, so it must not be relaxed for an external caller.

### 4.2 Moves go over the WebSocket only

`ws.ts` accepts `join`, `leave`, `input`. An agent whose attempt runs for ten
minutes should not have to hold a socket open — the async clock (`ASYNC`
settlement windows in minutes) exists precisely because agent turns arrive
minutes apart.

Needs `POST /attempts/:id/inputs` mirroring the socket's `input` handler, so a
BYO agent can be a cron job rather than a daemon. `GET /attempts/:id` already
exists for resuming.

### 4.3 The driver has to be demoted, not deleted

`driver.ts` currently *is* the agent: it decides what to enter, what to buy, and
calls the model. Under BYO it becomes a **reference implementation** — the
thing a hobbyist reads to see what a competent agent does, and the thing that
runs the handful of house agents in the demo.

What must move out of it into the API: `enterSomething`, `considerHints`,
`takeTurn`, `answerMessages`. What must stay: the vault read (§5.3).

Cap it. `AGENTS_ENABLED` should gate a house-hosted count in the tens, not a
population.

### 4.4 There is nothing to play

`CASH_PER_ZONE = 1` on one agent zone is 0.33 cash hunts/day. Before inviting
external agents, agent-zone supply has to mean something — more agent zones,
more cash hunts per zone, or an appointment-based event (the review's Vault
Final shape). This is a game-design decision, not an API one, and it is the one
most likely to be the real blocker.

---

## 5. The work, in order

1. **Fix the driver loop first** — parallelise the sweep and cache the vault
   read behind a short TTL. This is needed whether or not BYO happens: the
   house-hosted demo currently caps at ~100 agents for no good reason.
2. **Expose the mailbox** (§4.1). Without it BYO agents cannot do the
   interesting thing.
3. **Expose moves over HTTP** (§4.2), so an agent can be a cron job.
4. **Add a per-hunt entrant cap on house-funded inference.** The existing 10%
   cap bounds one agent, not a crowd. Even under BYO the house-run demo agents
   should be bounded per hunt rather than per agent.
5. **Write the integrator's guide** — the signing scheme (§3.2), the vault
   contract (§3.1), the zone split and why touching a human zone gets you
   rejected (§3.4), and the rate limits (§3.3).
6. **Decide agent-zone supply** (§4.4).

---

## 6. What this costs us

Stated plainly, because "cheaper" is not "free".

**We lose control of agent quality.** A house-run agent can be improved by
deploying; a thousand third-party agents cannot. If the agent zone fills with
agents that enter and time out, the zone looks broken and the fix is not ours to
ship. The `viableFor` refusal helps — a rational agent declines a bad hunt — but
nothing forces a BYO agent to be rational.

**We lose the inference ledger as a signal.** `agent/ledger` currently shows an
owner what their agent cost to run. Under BYO that spend happens somewhere we
cannot see, so the hint-spend half remains visible and the thinking half does
not.

**The demo story gets weaker unless we keep hosting a few.** "Anyone can plug an
agent in" is a worse hackathon demo than "watch these agents negotiate", so the
house agents earn their keep as a showcase even after they stop being the
product. That is the §8 conclusion restated: the agent layer is the story.

**Nothing here is validated by traffic.** Zero external agents have ever
connected. The costs above are arithmetic from measured model pricing and the
loop as written; the demand side is unknown, and the funnel added in phase 0
does not measure agents.
