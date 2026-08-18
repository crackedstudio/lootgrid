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

## 5. How to build it

### 5.0 The thing that makes this cheap: authentication is already done

Worth establishing before anything else, because it changes the size of the job.

`auth/verify.ts` recovers the signer from the signature and compares it to
`registry.sessionKeyOf(player)` — **the key bound on chain**. It does not know
or care where that key came from. A third-party agent signing with its own
keypair authenticates today, unchanged, with no new code.

Only six call sites assume the agent key is derived from `AGENT_MASTER_KEY`, and
all six are *setup* rather than *request handling*:

    agents/identity.ts:113  addressFor()        the derivation itself
    agents/identity.ts:125  isDistinct()        agent != player check
    agents/identity.ts:168  bind digest helper
    agents/identity.ts:215  createVaultCall()   vault constructor args
    agents/index.ts:77      setup: which address to bind
    agents/index.ts:141     setup: expected address check

So BYO is not an authentication project. It is a *setup* change plus three
missing doors.

### 5.1 Design decisions, and why

**A. The player binds an address the agent's author controls.**

`PlayerRegistry.bind` is the player's own transaction, so they can already bind
any address. Under BYO the agent generates its own keypair and the player binds
it; the house never sees the private key.

This is the reason BYO is **safer**, not merely cheaper. `identity.ts` calls
`AGENT_MASTER_KEY` "the most dangerous secret on the box after the escrow
treasury", and a leak is every hosted agent's spending rights at once. For BYO
agents that secret does not exist. The blast radius of a compromised third-party
agent is one vault, bounded by `perTxCap`, `perDayCap` and the owner's
allowlist — which is exactly what the vault was designed to bound.

Keep master-derivation for the house's demo agents. Support both; do not migrate.

**B. One state call, not N.**

    GET /agent/state

returning, in a single response: vault state and remaining daily allowance, live
attempts with their public specs and deadlines, the inbox, live hunts in
permitted zones **with `viableFor` already evaluated**, hints held, and budget
remaining.

Three reasons this shape rather than a REST tour:

- A cron-based agent does one read, thinks once, and writes once or twice. Six
  round trips before it can decide anything is what makes a hobbyist give up.
- It collapses rate-limit pressure into a predictable single call.
- **It exports the EV discipline.** The server already computes
  `budget.viableFor()`; putting the verdict in the payload means a naive agent
  inherits "do not enter a hunt that cannot pay" for free instead of
  reimplementing arithmetic it will get wrong. A third-party agent that ignores
  the flag is choosing to, which is a different problem from not knowing.

**C. The inbox read must stop being destructive.**

`mailbox.take()` removes messages as it reads them. That is fine in-process,
where the caller cannot crash between the read and acting on it. It is wrong
over HTTP: a cron agent whose request times out after the server has already
dequeued has silently lost a negotiation.

    GET  /agent/messages        returns messages WITH ids, leaves them queued
    POST /agent/messages/ack    { ids: [...] }
    POST /agent/messages        send one

`PER_SENDER_QUOTA = 4`, `MAX_INBOX = 32` and `TTL_MS = 5min` stay exactly as
they are — the quota is what stops one stranger's agent flooding another's
inbox, and it matters more once senders are strangers rather than our own code.

**D. Idempotency on anything that spends.**

A retrying cron agent will re-send. Some paths are already safe and should be
documented as such rather than re-solved:

    hunt entry     UNIQUE (hunt_id, player_id) — a retry is refused, not doubled
    moves          submitInputs ignores seq <= lastSeq, and fails on a gap
    shop           not protected
    market buys    not protected

The last two need a client-supplied `Idempotency-Key`, stored against the
result, so a repeat returns the first outcome instead of buying twice.

**E. Moves over HTTP, reusing the sequence number.**

    POST /attempts/:id/inputs   { events: [{ seq, kind, t, value }] }

A thin door onto the same `referee.submitInputs` the socket calls. It is already
idempotent by `seq`, so no new semantics. This is what lets an agent be a cron
job rather than a daemon — which is the point of the async clock
(`ASYNC.settlementWindowMs.agent` is fifteen minutes precisely because turns
arrive minutes apart).

Keep the WebSocket. It is better for the house demo and for anyone who wants
live progress.

**F. Ship a reference client, not only prose.**

The signing scheme is exact and fiddly: domain prefix, lowercased identity,
method, path *including query string*, timestamp, single-use nonce, sha256 of
the body, joined by newlines. A hobbyist will get one field wrong, see 401, and
conclude the API is broken.

About a hundred lines of TypeScript and the same in Python, doing nothing but
sign-and-send. It is the highest-leverage adoption work in this document and the
cheapest.

**G. A place to fail safely.**

An external developer needs a zone where being wrong costs nothing: no cash
hunts, generous rate limits, and a stable seed so a run is reproducible. Without
it their first experiment is against real money and real rivals, which is both
unkind and a support burden.

**H. Version the surface explicitly.**

Once strangers integrate, this is a contract. `PROTOCOL_VERSION = 1` already
exists for agent-to-agent messages; the HTTP surface needs the same discipline —
a version in the path or a required header, and a written rule that adding a
field is safe and changing one is not.

**I. Re-tune rate limits for the new shape.**

One state call replaces several reads, so the read budget can fall. But a
polling agent needs a *floor*: a busy loop at 600/min per identity is a denial
of service we invited. A minimum poll interval, and `429` with `Retry-After`
rather than a bare refusal.

### 5.2 Stages, smallest useful thing first

Each stage ends at something demonstrable, so the project can stop between any
two of them and still be coherent.

**Stage 0 — fix the driver loop.** Parallelise the sweep; cache the vault read
behind a short TTL. Needed whether or not BYO ships: the house demo caps at ~100
agents today for no good reason. Nothing external depends on this, so it can go
first and alone.

**Stage 1 — an outside agent can authenticate and dig.** Accept a
caller-supplied agent address at setup (§5.1-A); ship the reference client
(§5.1-F); stand up the sandbox (§5.1-G). *Demonstrable:* a script outside this
repo signs a request and opens a tile.

**Stage 2 — an outside agent can play a hunt.** `GET /agent/state` (§5.1-B) and
`POST /attempts/:id/inputs` (§5.1-E), plus idempotency keys (§5.1-D).
*Demonstrable:* an external agent enters a deduction hunt and commits an answer
without holding a socket.

**Stage 3 — an outside agent can negotiate.** The mailbox endpoints (§5.1-C).
*Demonstrable:* two agents from different codebases agree a hint price and
settle it through the vault. This is the stage that makes the agent layer
interesting rather than merely reachable.

**Stage 4 — it is worth doing.** Agent-zone supply (§4.4). Until this, everything
above is a working integration with nothing to play.

### 5.3 What must not be lost on the way

Three properties that currently hold and are easy to break while opening things
up.

**The vault read before acting.** `driveOne` reads the chain to confirm the agent
is still the vault's spender, because a player who pressed `kill()` must stop
being served even if our own row still says active. Under BYO the equivalent is
that any *spending* endpoint re-checks it. Caching it (Stage 0) is fine; dropping
it is not.

**The zone split stays structural.** Reflex modules carry bot checks and agent
zones never draw them, so the protection is unreachable by construction rather
than switched off by a flag. An external agent that reaches a human puzzle hunt
will be failed for having inhuman timing — correctly. Do not add an
`isAgent` bypass; that turns an impossibility into a permission check.

**No free-text field, ever.** `protocol.ts` has no string a rival can fill,
because a message from another agent is attacker-controlled input arriving at a
model that can spend money. Opening the mailbox to strangers makes this stricter,
not looser: if a future intent seems to need prose, it needs an enum.

### 5.4 How we will know it worked

One acceptance test, and it is deliberately harsh: **an agent written by someone
with no access to this repository, working only from the published guide, enters
a hunt and wins it.** Anything less — an example we wrote, a script that imports
our types — proves the API works for people who already know the answer.

Phase 0's funnel does not measure agents. Add, at minimum: distinct agent
identities seen, requests per agent, and hunts entered by external versus house
agents. Otherwise "did anyone use it" is an anecdote.

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
