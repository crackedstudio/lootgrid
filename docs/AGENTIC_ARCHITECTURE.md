# LOOTGRID — Agentic Architecture

Status: design proposal (v2). Nothing here is implemented. It builds on
[`BACKEND_AND_CONTRACTS.md`](./BACKEND_AND_CONTRACTS.md), which stands unchanged: the chain
owns the money, the server owns the game. This document adds a third party — autonomous
agents — and says exactly what they may and may not touch.

Read v1 first. Everything here assumes its referee, its escrow-against-EIP-712-voucher model,
and its permissionless refund path.

---

## 0. The one decision everything hangs off

In v1 a human races a human. In v2 **both play** — humans race humans, agents race agents,
and the hint market is the bridge between them. A player's skill is direct in human zones and
moves upstream in agent zones, into how they configure, fund and strategise their agent.

Humans and agents must **never race each other.** An agent taps perfectly and computes
instantly, so a mixed reflex hunt is decided before it starts; a mixed deduction hunt is
barely better. Segregation is not a nicety, it is what keeps either side worth playing.

That decision invalidates a load-bearing assumption for the agent half of the game. From
`server/src/games/tap.ts:74`:

```js
// A bot on setInterval produces σ≈0. Humans are inherently jittery.
```

and from `server/src/games/index.ts`:

> Memory is deliberately absent. The client has to be told the sequence in order to play it
> back, so it is the easiest of the four to automate — it guards XP only, never money.

**The v1 cash game rejects players for not being human.** That is correct behaviour in human
zones and exactly wrong in agent zones — so the check becomes zone-scoped rather than global.
Agent zones are a second game sharing v1's infrastructure, not a replacement for it.

| Approach | Verdict |
| --- | --- |
| **Retrofit agents into the existing modules** | Dead on arrival. Tap, math and sequence test reflexes and arithmetic — an agent scores perfectly, and jitter analysis flags the intended player as a cheat. |
| **Keep humans, let agents only advise** | Works, but it is v1 with a helper. It does not produce the agent-to-agent economy. |
| **Agent-native zones alongside human zones, shared infrastructure** | ✅ Recommended. Same referee, same escrow, same hint market, different challenge modules and a longer clock. |

**The model: the chain owns the money, the server owns the truth, the agent owns the
experience.**

---

## 1. Where the money comes from

Settled, because it determines everything else:

> **The house funds prizes.** They are deposited into the escrow contract up front. Agent
> trading fees are revenue, not the prize source.

This matters because the obvious alternative does not work. In a closed agent economy where
the only inflow is prizes:

```
agent inflow   = prizes
agent outflow  = platform fees + inference costs

outflow > inflow  ⇒  agents lose money in aggregate and stop playing
∴  fee revenue ≤ prizes − inference
```

Fees can never fund the prizes they are levied against. At a 2.5% rake a $12 prize would
require **$480 of trading volume per hunt** — roughly $24 per agent across twenty agents,
each chasing an expected return of $0.60. No rational agent plays that. Attempting it is the
GameFi death spiral in different clothes.

### The actual model

| Flow | Direction | Mechanism |
| --- | --- | --- |
| Prize funding | House → escrow | Direct deposit, per hunt |
| Player deposits | Player → agent vault | Funds their agent's hint budget and gas |
| **Hunt entry fee** | **Player/agent → treasury** | **x402, paid to join a rewarded hunt** |
| Hint trades | Agent ↔ agent | x402, rake to treasury |
| Premium access, energy refill | Player → house | x402 |
| Sponsorship | Sponsor → treasury | Zone sponsorship |
| **Prize payout** | **Escrow → winner** | **EIP-712 attestation, never x402** |

### The entry fee is a filter, not a profit centre

This constraint is specific to agents and easy to miss: **a rational agent computes expected
value and refuses a negative-EV hunt.** Humans pay to be entertained; an LLM optimising for
its player's balance simply does not enter.

For an agent to rationally join a hunt with prize `P`, entry fee `F` and `N` expected
entrants:

```
EV = P/N − F − (hint spend + inference)   must be > 0
∴  F  <  P/N − costs
```

A $0.50 prize with 20 entrants supports a fee **below $0.025** before agents stop playing —
and that is before hint and inference costs. Set the fee above that line and the agent
economy does not slow down, it stops.

Which means entry fees on agent hunts are **net-negative for the house by construction**: you
pay `P` and collect `N × F < P`. That is correct and intended. The fee's job is to stop an
agent entering every hunt indiscriminately — a spam and sybil filter with a price, not
revenue.

| Zone type | Fee ceiling | Why |
| --- | --- | --- |
| Human | Higher — tolerates negative EV | People pay for entertainment |
| Agent | Strictly below `P/N − costs` | Rational agents refuse otherwise |

Revenue still comes from deposits, sponsorship and the hint rake (§1 above). Model the entry
fee as a lever on participation rates, and watch the ratio `F ÷ (P/N)` as the health metric
for every agent zone.

x402 is a client-pays-server protocol. It is correct for every inbound flow above and wrong
for payouts — a winner is not buying a resource. Payouts go through escrow.

### What this costs you, stated plainly

Aggregate players are net-negative. Deposits exceed prizes returned, and the difference is
your revenue plus inference costs. That is the standard free-to-play model and it is honest,
but build knowing it: **prizes scale with player count, never with trade volume.**

Prize ceiling: `total prizes ≤ deposits + sponsorship − inference − margin`.

---

## 2. Trust boundaries

Three layers. Each can fail without the ones below it failing.

| Layer | Authority | Decides | Cannot |
| --- | --- | --- | --- |
| **Agent** | None | Which challenge, what difficulty, what to bid for a hint | Grade an input, move funds, mint a winner |
| **Referee** | Server key | Whether an input was correct, who won | Exceed escrowed amount for a hunt |
| **Contract** | Signature + caps | Who may be paid, and the maximum | Be talked out of it |

The rule that makes this hold:

> **Non-determinism lives outside the trust boundary.** Never inside `step()`, never with
> authority over funds.

An agent that is fully compromised — prompt-injected, hijacked, or simply wrong — can make a
hunt unfair. It cannot make itself the winner and cannot move a cent. That is the property
worth protecting above all others.

### The boundary that is thinner than it looks

Layers 2 and 3 are joined by one key. The referee attests; the contract verifies that
attestation. Whoever holds the attestor key can mint winners and therefore payouts.

This is the same trust boundary v1 already documents, and it is not defence in depth. Before
real money, that key needs: threshold or multisig signing, per-hunt and daily caps enforced
**in the contract**, a challenge window before withdrawal, and a pause guardian.

The architecture ensures a compromised *agent* cannot steal. It does not by itself ensure a
compromised *referee* cannot. The caps are what bound that.

---

## 3. Contracts

### Existing

**`LootGridActions.sol`** — append-only public record. Already deployed-ready, holds no
funds. Reveals arrive from the relayer; hunt entries and resolutions may be self-submitted by
anyone presenting an EIP-712 attestation signed by the referee's `attestor` key
(`submitEntry` ≈ 73k gas, `submitResolution` ≈ 74k). Redeemed digests are burned, so an
attestation cannot be replayed.

That contract is the template for everything below: **attestation in, event out, caps
enforced on chain.**

### New

**`LootGridEscrow.sol`** — holds prize funds, releases against the same attestation
`LootGridActions.submitResolution` already verifies.

| Rule | Purpose |
| --- | --- |
| Only the attested winner may claim | No self-declared wins |
| Per-hunt cap, rolling daily cap | Bounds a compromised attestor |
| Challenge window before withdrawal | Time to halt a fraudulent payout |
| Permissionless refund after expiry | Funds are never stranded if the server dies |
| Pause guardian on `claim`, never on `refund` | Incident response without hostage-taking |
| No upgrade key | Redeploy and repoint, per v1 |

Reusing the resolution attestation means no new trust model — the signature that records a
win is the signature that releases the money.

**`AgentVault.sol`** — per-player custody. This is the contract that makes "the player
deposits into the agent" safe.

The agent must **never hold the keys to player funds**, and its address must differ from the
player's (§4). It is an authorised spender against a vault, bounded by:

- per-transaction and per-day spend caps, set by the player
- an allowlist of what it may pay for (hint escrow, gas, inference)
- instant player withdrawal, not blockable by the agent
- a kill switch that revokes spender rights immediately

A prompt-injected agent then loses one capped trade, not the player's balance.

**`HintEscrow.sol`** — commit-reveal for hint trades, and the reason the market works at all
(§5).

**`Treasury.sol`** — house funds, yield allocation, prize sizing. The treasury agent is a
spender within caps, never the owner.

### Third-party, already deployed on Celo

| Contract | Mainnet (42220) | Sepolia (11142220) |
| --- | --- | --- |
| ERC-8004 Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Payment tokens: USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (6dp), cUSD
`0x765DE816845861e75A25fCA122bb6898B8B1282a` (18dp). cUSD doubles as the `feeCurrency` for
gas abstraction, so an agent holding one stablecoin can both trade and pay gas.

---

## 4. The agents

Three distinct roles. **They must not share a context window** — text reaching one must not be
able to influence another.

| Agent | Owned by | Authority | Sees |
| --- | --- | --- | --- |
| **Director** | House | Emits typed challenge directives | Anonymised aggregate progress only |
| **Player agent** | Player | Spends from their vault, within caps | Its own hints, public market, its budget |
| **Treasury** | House | Proposes allocations within caps | Financial state, no player identities |

### Director

Runs the hunt: picks difficulty, round type and twists. Four constraints:

1. **Typed directives, never free text.** A schema-validated
   `{ difficulty: 1-5, roundType: enum, twist: enum }` means a fully hijacked model still
   emits only a legal directive.
2. **Per-round and broadcast.** Every racer in a hunt gets the identical challenge, or it is
   not a race.
3. **Pipelined.** Chooses round N+1 during round N. A model call never sits in the critical
   path.
4. **Timeout → deterministic fallback.** Past ~200ms the existing `generate(seed, difficulty)`
   supplies the round. Same rule as the relayer: **gameplay never waits.**

**The Director is blind to player identity by construction.** An agent that knows who is
winning and can raise difficulty is a payout-manipulation surface. Blind it rather than
audit it.

### Verifiability: what is traded away

v1 proves fairness by commit-reveal — the salt fixes the game before anyone enters. A live
Director destroys that, so replace it rather than dropping it. Hash-chain every directive:

```
h₀ = keccak(huntId ‖ salt)
hₙ = keccak(hₙ₋₁ ‖ directiveₙ ‖ serverTimestampₙ)
```

Publish `hₙ` with the resolution attestation and the transcript off-chain.

| | Proves |
| --- | --- |
| v1 commit-reveal | The game was not rigged **in advance** |
| v2 hash chain | The game was not rigged **differently per player**, and not rewritten after seeing who led |

A weaker guarantee, honestly stated. The transcript makes an unfair hunt detectable and
refundable after the fact rather than impossible up front.

---

### Player agents: three addresses, not one

An agent is **a session key with a wallet and a budget.** The pattern already exists in
`PlayerRegistry.sol` — `sessionKeyOf` / `playerOfKey`, bound by EIP-712 and revocable — and v2
extends it rather than inventing anything.

| Address | Holds | May | May not |
| --- | --- | --- | --- |
| **Player wallet** (MiniPay) | The player's money | Fund the vault, withdraw, rotate or revoke the agent | — |
| **Agent wallet** | Nothing | Sign trades, pay hint fees, accrue reputation | Exceed vault caps, withdraw to itself |
| **`AgentVault`** | The deposit | Release to allowlisted targets within caps | Be drained by its own spender |

```
PlayerRegistry.sessionKeyOf[player]  →  agent address      (already built)
ERC-8004 ownerOf(agentId)            →  player address
ERC-8004 getAgentWallet(agentId)     →  agent address
AgentVault.owner                     →  player address
AgentVault.spender                   →  agent address
```

**The separation is load-bearing, not bookkeeping.** The agent key is hot: it signs
constantly and it is the surface every rival's message attacks. Keep it distinct and a
compromised agent costs one capped trade, revoked like any session key. Collapse it into the
player's address and the vault caps become decorative — injection would mean the attacker
holds the player's wallet.

The player *owns*; the agent *operates*.

### Configuration

Typed settings, never free-form instructions carrying authority:

| Setting | Example |
| --- | --- |
| Spend caps | $0.50/hunt, $5/day |
| Hint bid ceiling | ≤ 40% of expected value |
| Zone allowlist | Which zones to hunt |
| Counterparty threshold | Minimum ERC-8004 reputation to trade with |
| Negotiation rounds | Caps inference spend per hunt |
| Strategy preset | Aggressive / patient / contrarian |

A free-text *strategy* field is acceptable and probably good for differentiation, **because
authority is bounded on chain.** A player who jailbreaks their own agent still cannot exceed
their caps; the worst outcome is losing their own budget — a support issue, not a breach.

That tolerance does not extend to the Director or the treasury agent. Free text must never
reach either.

### Hosting: one multi-tenant pool, not one process per player

MiniPay users will not bring their own API keys, so **the house runs inference and meters it
against each player's vault.** "Player agents" are house-hosted, player-configured. This is a
material design point, not an implementation detail — P7 builds an agent *pool*, not an agent.

| Requirement | Why |
| --- | --- |
| Per-tenant context isolation | One player's agent must never see another's hints or budget |
| Per-tenant inference budget, enforced before the call | Runaway loops bill the wrong player |
| Provider key is a house secret | Never exposed to client or agent config |
| Fair scheduling across tenants | One busy agent must not starve a hunt |
| Per-tenant rate limits | Contains both abuse and cost |

**Model choice is an economic decision.** §7 estimates ~200 calls per hunt — roughly $1 at
frontier pricing, untenable against a $0.50 prize. A low-cost provider (DeepSeek at time of
writing) is what makes per-hunt inference fit inside a sub-dollar prize at all. Re-run the
arithmetic against live pricing before fixing the prize range, and treat inference as cost of
goods sold against the same deposits that fund prizes.

**Structured output is a hard requirement, not a preference.** The entire security model rests
on typed agent output (§6). Assume the provider sometimes emits invalid JSON, especially under
adversarial input: validate, reject, retry with a bounded budget, and fall back to
deterministic behaviour on repeated failure — the same discipline as the Director's timeout.
Measure the schema-violation rate per model and treat a regression as an incident.

## 5. The hint market

Hints are directions toward a hunt. Agents buy, sell and deduce them. This is the core loop,
and it maps onto the ERC-8004 stack exactly:

```
Application  — the hint market
Trust        — ERC-8004 identity + reputation
Payment      — x402
Communication— agent-to-agent
```

### 5.0 Hints are issued by the Director, and some of them lie

Hints originate from the game's own Director agent, which knows the hidden grid. Some lead to
the hunt; some mislead. That is the design — certainty would reduce the market to logistics,
while noise makes deduction genuinely skillful and reputation genuinely valuable.

It also creates the sharpest trust problem in this document, because it stacks with two other
facts: **the house issues the information, the house funds the prize, and the house charges
to enter.** A losing player cannot distinguish "I was outplayed" from "the house fed me a
false hint to protect its prize." That suspicion is fatal whether or not it is true.

**The fix: commit to the deception rate before the hunt, prove it after.**

```
before open:  publish  C = keccak(hintSet ‖ truthFlags ‖ salt)
              advertise tier reliability, e.g. "tier 2 = 70% accurate"
after resolve: reveal hintSet, truthFlags, salt
               anyone verifies C, and that observed accuracy matches the advertised tier
```

Per-zone accuracy statistics are published on a rolling basis. Misleading then becomes a
**game mechanic with known parameters** — the house bluffs within published rules, like a
dealt card, not a stacked deck.

| Without the commitment | With it |
| --- | --- |
| "The house lied to me" is unfalsifiable | Deception rate is a checkable number |
| Accuracy can be tuned per player | Truth flags fixed before anyone enters |
| Trust rests on reputation alone | Trust rests on arithmetic |

**This is not optional once entry fees exist.** Charging admission to a contest whose
information you control and may falsify, without a public commitment to how often you
falsify, is the configuration that draws both player distrust and regulatory attention. The
commitment costs one hash and removes the entire class of accusation.

A further constraint: the Director must fix truth flags **before knowing who enters** — same
blinding requirement as difficulty (§4). It must never be able to make *your* hint the false
one.

### Three problems, and why each is solvable here

**Lemon market.** A buyer cannot evaluate a hint before purchase, so bad hints drive out
good and the market dies. Standard, and usually fatal.

You have a capability nobody else does: **the referee knows the truth.** But hints are
deliberately unreliable (§5.0), so it cannot attest accuracy. It attests **authenticity and
declared reliability tier** instead:

```
seller commits keccak(hint)
referee attests  "this hash is a GAME-ISSUED hint, zone R, tier 2 (70% accurate pool)"
buyer funds HintEscrow → seller reveals → hash checked → funds release
```

The distinction matters:

| Attested | Not attested |
| --- | --- |
| This hint was issued by the game, not fabricated by the seller | That it is correct |
| Which reliability pool it came from | Which side of that pool it fell on |
| Which zone and precision tier it addresses | Where the treasure actually is |

The buyer learns the *odds*, never the answer. That is better for the market than certainty
would be: it creates genuine price discovery, and it makes reputation load-bearing — whose
hints have historically panned out is now a question worth paying to answer. ERC-8004's
Reputation Registry carries exactly that signal, and its Validation Registry adds staking and
slashing for high-value hints.

**Zero marginal cost.** Information can be resold infinitely. Not fully solvable — design
around it:

- **Hints are partial.** No single hint locates a hunt; value is in aggregation, so one leak
  does not end the round.
- **Hints decay.** Bound to a hunt with a TTL; the resale window is short by construction.
- **Price decay is expected.** First buyer pays most. That is a working market, not a broken
  one.

**Exclusivity becomes purchased victory.** If one agent holds the only hint, it runs the hunt
uncontested and money bought the prize.

> **Hints govern discovery. The challenge governs victory.**

Hint exclusivity must be **time-bounded** — a head start, not a monopoly. Broadcast the hunt
publicly after N minutes. Hints then buy tempo, which is legitimate to sell.

### What makes it an economy rather than a resale racket

Pure resale is a wash. **Deduction creates value:** buy three weak hints, combine them into a
stronger inference, sell that. Derived information is worth more than its inputs, so agents
compete on reasoning rather than on who bought first. This is the mechanic worth building the
game around.

### Fees

The rake meters player deposits; it does not fund prizes (§1).

| Problem | Fix |
| --- | --- |
| Dust — 2.5% of a $0.01 hint is below gas | Minimum trade size; accrue off-chain, settle in batches |
| Fee waiver threshold | Keeps small trades liquid |
| Circumvention — agents settle off-platform | See below |

Rational agents will batch, pool, or trade off-platform to dodge the rake. The defence is
that **the referee's attestation only exists on-platform.** Off-platform, a buyer has no proof
the hint is real — straight back to the lemon market. The fee is not a toll; it is the price
of verification and escrow. Keep that value clearly above the cost of routing around it.

---

## 6. Security model

### Prompt injection

It is not solved and cannot be filtered reliably. Contain it instead. Agent-to-agent hint
trading means **attacker-controlled text flowing into a model**, so this is the central
security concern, not a peripheral one.

| Control | Effect |
| --- | --- |
| **Typed schemas on every agent I/O** | Strongest control. A hijacked model still emits only legal directives |
| **Blind the Director to identity** | Removes the entire targeting class |
| **Least privilege** | Director has no wallet, no DB writes, no arbitrary HTTP |
| **Separate contexts per agent role** | Text reaching one cannot influence another |
| **Vault caps** | Injection costs one capped trade, not a balance |
| Delimited untrusted data in prompts | Hygiene, **not** a boundary |

What does not work: instructing a model to ignore injected instructions, keyword filters, or
a model policing another model's input.

A hint is `{ "kind": "region", "zone": "ridge", "quadrant": "NE", "confidence": 0.7 }` —
never prose. Price negotiation happens over a structured protocol, never free-form chat.

Today's surface is near zero: `handle` is derived from the wallet address, and inputs are
taps and enums. **Validate at the source** if user-chosen handles or free text are ever added
— length caps, no control characters, no newlines — rather than sanitising at prompt time.

### Key hierarchy

| Key | Blast radius | Protection |
| --- | --- | --- |
| **Attestor** | Mints winners → mints payouts | Multisig/threshold, contract caps, challenge window |
| Treasury owner | Allocation policy | Multisig, timelock |
| Relayer | False game logs | Hot wallet, rotate freely, small float |
| Director | Unfair hunts, detectable in transcript | No wallet at all |

Escrow changes the attestor key's blast radius from cosmetic to financial. It is the crown
jewel; size the protection accordingly.

### Sybil and collusion

ERC-8004 blocks self-feedback, but two agents on two wallets can still wash-trade reputation.
Mitigate with stake-weighted reputation, reputation earned only on *verified* hints, and
cost-to-enter above the value of a fake rating. **Plan to detect and slash rather than
prevent** — this is not fully solvable.

---

## 7. Economics of agent play

**Latency.** An LLM call is 1–3s. Multi-round negotiation cannot fit a 6-second window, so
hunts stretch to minutes or hours.

That reads as a loss and is the opposite: **async play is the retention win.** Your agent
hunts while you sleep; you check in to find it won three hunts and made $2 selling a deduced
hint. Far stronger for mobile than 6-second bursts.

**Inference.** ~20 agents × 5 rounds × 2 calls ≈ 200 calls/hunt. At $0.005 that is ~$1
against a $12 prize — roughly 8% burn. Workable, but chatty agents destroy it. Cap negotiation
rounds and prefer structured protocol over conversation. Inference is a cost of goods sold;
it comes out of the same deposits that fund prizes.

---

## 8. What changes from v1

| Component | Fate |
| --- | --- |
| Referee, attestations, `LootGridActions`, relayer outbox | ✅ Unchanged |
| Zones, grid, commit-reveal on tile secrecy | ✅ Unchanged |
| Escrow design from v1 §0 | ✅ Extended, not replaced |
| Energy (`energy.ts`) | ✅ Becomes a monetised sink |
| `tap` / `math` / `sequence` / `memory` modules | ✅ **Kept** — they run the human zones |
| Jitter analysis, `CASH_GAMES` exclusion | ⚠️ Becomes **zone-scoped**, not global |
| 6-second race rhythm | ⚠️ Human zones keep it; agent zones run async |

Nothing is deleted. The work is **scoping what is currently global to a zone type**, and
adding a parallel set of modules for agent zones.

| Zone type | Modules | Anti-automation | Clock |
| --- | --- | --- | --- |
| Human | tap, math, sequence, memory | Enforced, as today | 6 seconds |
| Agent | deduction, negotiation, search | Disabled | Minutes–hours |

The `GameModule` interface itself is unchanged — `generate` / `publicSpec` / `init` / `step` /
`progress` is the right shape for agent challenges too. New modules, same contract:

| Agent-native challenge | Tests |
| --- | --- |
| Deduction from partial, noisy hints | Inference quality |
| Negotiation under budget | Valuation, strategy |
| Adversarial search over contested tiles | Game theory |
| Allocation across parallel hunts | Portfolio thinking |
| Bluffing — real hint or bait? | Opponent modelling |

Noisy hints are what make deduction interesting and reputation meaningful. Perfect hints
reduce the market to logistics.

---

## 9. Build order

Each step answers one question and is worth stopping at if the answer is no.

| # | Ship | Answers |
| --- | --- | --- |
| 1 | Hints earned by play, no trading, humans only | **Is discovery fun at all?** |
| 2 | `LootGridEscrow` + real stablecoins, prizes at $0.10 | Does the payout path work end to end? |
| 3 | P2P hint trade: `HintEscrow` + referee attestation | Does a market form? |
| 4 | Energy refill and premium zones via x402 | First real revenue |
| 5 | `AgentVault` + player agents, one agent-native zone | Do agents trade sensibly? |
| 6 | ERC-8004 identity and reputation | Does trust scale past regulars? |
| 7 | Director agent with hash-chained transcript | Does live difficulty beat deterministic? |
| 8 | Treasury agent sizing prizes from real inflow | Does the economy self-regulate? |

Step 1 needs no chain, no agent and no market. If hint-driven discovery is not fun on its
own, nothing downstream rescues it.

Step 5 runs **one zone**, beside the human game, sharing referee, escrow and hint market. That
tests the thesis without betting v1 on it, and lets humans sell hints to agents and back.

---

## 10. Decisions

| # | Question | Decision | Consequence |
| --- | --- | --- | --- |
| 1 | Do humans play? | **Yes, alongside agents** | Zone-scoped anti-automation; two module sets; never mixed in one hunt |
| 2 | Hint origin | **Director-issued**, may mislead | Requires the §5.0 commitment scheme |
| 3 | Can hints be wrong? | **Yes, by design** | Attestation covers authenticity, not accuracy |
| 4 | Entry fees? | **Yes, to join a rewarded hunt** | See below — legal review required |
| 5 | Prize range | **$0.01 – $5.00 by difficulty** | Replaces the hardcoded `PRIZE_LABELS` |

Prize sizing is now affordable: at a $0.50 average, 1,000 players depositing $5/month
supports roughly 200 hunts a day with margin, against the ~8/day that $12 prizes allowed.

### Legal review, stated plainly

Decision 4 is the one to take to a lawyer before launch rather than after. Pay-to-enter for a
chance at a cash prize is the gambling definition in many jurisdictions, and three of your
decisions compound it: **the house charges admission, controls the information, and may
deliberately falsify it.**

Factors that reduce exposure, none of which is a substitute for advice:

- Outcomes determined by skill, with the audit trail to demonstrate it (§4 hash chain)
- Published deception rates, verifiable after the fact (§5.0)
- Prizes not scaled to the fee paid
- Free entry paths to rewarded hunts
- Jurisdictional gating at signup

The architecture is built so that each of these is available. Which are required is not an
engineering question.

### Still open

1. **Do humans and agents ever share a hint market?** Assumed yes throughout — it is what
   makes the two halves one game. Confirm that a human selling to an agent is acceptable in
   both directions.
2. **Who sets tier reliability** — fixed per zone, or Director-chosen within published
   bounds? The latter is more dynamic and needs the commitment to cover the choice itself.
3. **Free-entry path.** Energy already gates play without money. Whether energy alone can
   admit a player to a rewarded hunt is both a design and a legal question.

---

## Appendix: the rules, in one place

1. The chain owns the money, the server owns the truth, the agent owns the experience.
2. Non-determinism never enters `step()` and never gains authority over funds.
3. Every agent output is schema-validated before use.
4. Gameplay never waits — model timeout falls back to deterministic generation.
5. The Director is blind to player identity.
6. Agents are spenders against vaults, never holders of keys — and never share the player's
   address.
7. Every cap is enforced by a contract, never by a model.
8. Prizes come from deposits and sponsorship. Fees meter; they do not fund.
9. Hints govern discovery. The challenge governs victory.
10. Humans and agents never race each other.
11. The house may bluff, but only at a rate it committed to before the hunt.
12. On agent zones, the entry fee stays below `P/N` — a rational agent will not play a losing
    game.
13. Assume the model will be compromised, and make that survivable.
