# The Agent Tier — 100 paid seats

**Proposal:** cap agent participation at 100 players. They pay for a seat before
taking part. Their agent plays the challenges for them. The rest of the game
stays free.

**Decided:** the house holds the DeepSeek account and buys the tokens. Players
pay for a seat, and that fee is what funds them.

**The cap is right and the number is right.** One requirement travels with the
decision, and §2 is about why it is not optional: the fee has to be structured
and described as **buying compute**, with a free path for anyone who brings
their own inference. Get that wrong and the same money flow becomes an entry fee
for a prize contest.

**Companion:** `AGENTS_BYO.md` — the cost analysis this builds on.

---

## 1. Why 100 is a good number

Not a guess. Three independent ceilings land in the same place, which is rare
enough to be worth trusting.

| Constraint | Where it caps out | Source |
| --- | --- | --- |
| Serial driver loop | ~100–250 agents | `driver.tick()` sweeps sequentially with an on-chain read per agent |
| Affordable house inference | ~100–200 agents at $50–100/mo | `AGENTS_BYO.md` §7.2 |
| RPC volume | 20 reads/sec at 100 agents, vs 4,000/sec at 20k | 17,280 ticks/day/agent |

At 100 seats none of these is an emergency. The engineering that `AGENTS_BYO.md`
§5.2 calls "Stage 0" becomes an optimisation rather than a prerequisite, which
is the main thing a cap buys: **it converts three blocking problems into three
things you can do later.**

It also matches the review's own conclusion (§8): *the agent layer becomes the
story, not the product.* A hundred seats is a showcase. Twenty thousand is a
product nobody asked for.

---

## 2. Why the fee must buy compute, not a place

The decision is sound and the money flow is honest: we buy tokens, players fund
them. What matters is that the *structure* matches that description, because a
fee for a seat at a table with cash on it is a different thing in law from a fee
for the electricity.

The review's §7b, rule 1:

> **Money never buys a key, an entry, or a retry.** Five shots a day, for
> everyone alive.

And §7c, on why:

> Selling energy that a player *needs* in order to compete for a cash prize is
> **an entry fee with extra steps.** That's a gambling-adjacent problem.

"Pay for a seat, then search for rewards" — taken literally — is money buying
access to a prize contest. That is the thing the two-currency split was built to
prevent, and the sentence handed to a lawyer ("money buys information and
exploration, never a chance at a prize") stops being true the day it ships that
way.

The good news is that the decision as stated is already the safe version: **the
house buys tokens and the fee funds them.** That is a compute purchase. §3 is
about making the structure say so as clearly as the sentence does.

### 2.1 It is worse than it looks, because agent zones have no key cap

`server/src/admission.ts`:

```ts
if (zoneKind === 'agent') return ALLOWED;   // before the keys check
```

Agent zones return early, **above** the five-keys-a-day check. So today an agent
has *unlimited* cash-hunt entries. Sell a seat on top of that and the product is
literally: pay us, and unlike everyone else you get unbounded chances at cash.

Whatever else is decided, this line needs revisiting. See §4.

---

## 3. How the decision is implemented safely

No change to the money flow — only to what the fee is attached to.

> **The fee buys the tokens we spend on your behalf. It does not buy entry.**
> Anyone may play the agent tier for free by bringing their own inference.

The second sentence is the load-bearing one, and it costs almost nothing to
honour — `AGENTS_BYO.md` §5.0 establishes that a third-party agent signing with
its own key authenticates today with no new code. Without it, the first sentence
is a description rather than a fact.

That single distinction does all the work:

- **Money buys convenience, not chance.** Identical to how the shop already
  works — energy buys attempts at *finding*, never at *winning*.
- **It creates a genuine free path**, which is what the review calls an AMOE and
  lists as a legal requirement. A player who runs their own model reaches the
  same hunts and the same prizes for nothing.
- **It is honest about the actual cost.** We are paying for DeepSeek tokens on
  their behalf. Charging for that is a service, not a wager.
- **It aligns with `AGENTS_BYO.md` §7.4**, where house-provided inference is
  described as a starter tier that good agents should be expected to leave.

So the tier has two doors into the same room:

| | Funded seat | Bring your own inference |
| --- | --- | --- |
| Who pays to think | The house, from the seat fee | The player |
| Cap | **100 seats** (bounded by our budget) | Bounded only by rate limits |
| Prizes | Same hunts, same prizes | Same hunts, same prizes |
| Entry cost | None beyond the standard energy | None beyond the standard energy |

The 100 is then honestly what it is: **a cap on how many agents the house is
willing to fund**, not a cap on how many may play.

### 3.1 What to call it

Not "entry", "ticket", "pass to the agent game", or anything with *access* in it.
The naming is part of the legal argument, not decoration. Something like
**Agent Compute — 100 funded seats**, described as what it is: we run the model,
you write the agent.

---

## 4. Keys have to apply to agent zones

Independent of pricing, and arguably the more urgent finding.

The early return in `admission.ts` predates the money gate — it was written when
the concern was that rank is unsatisfiable for an agent, which remains true and
correct (an agent cannot dig, so it can never earn hint-accuracy rank). But
skipping the *rank* check is not a reason to skip the *key* check.

The distinction matters:

| Check | Should it apply to agents? | Why |
| --- | --- | --- |
| Rank | **No** | Unsatisfiable — agents do not dig, so they would sit at `unranked` forever and the zone would close silently |
| Wallet age | **Yes** | A burner agent wallet is exactly as cheap as a burner human one |
| Keys | **Yes** | Otherwise money buys unlimited chances, which is the whole problem |
| Shadow ban | Already applies | — |

Suggested: agent zones get the key cap and the wallet-age check, and keep the
rank exemption with its existing comment intact. That is a small change to one
function and it closes the asymmetry before anyone can point at it.

---

## 5. What a seat costs us, and what to charge

House cost per seat, at corrected inference prices (`AGENTS_BYO.md` §7.1):

| Model | 5 hunts/day | 20 hunts/day | 50 hunts/day |
| --- | --- | --- | --- |
| flash | $0.52/mo | $2.08/mo | $5.19/mo |
| pro | $1.61/mo | $6.45/mo | $16.13/mo |

At 100 seats that is **$52–$519/month** on flash, depending entirely on how hard
people play. Which means the seat price is not really a pricing question — it is
a question about the **per-seat daily cap**, because that is what makes the cost
knowable in advance.

### 5.1 Price it against a cap, not against usage

Set a per-seat daily inference allowance and price the seat to cover it with
margin. `budget.ts` already has the machinery — `canInfer` checks a per-hunt cap
and a daily cap, and running out is **not fatal**: `runtime.ts` falls back to a
deterministic move, for free. An agent that exhausts its allowance plays on,
worse.

That property is what makes a cap safe to sell against. Nobody forfeits; they
degrade.

A defensible starting point, in the shop's existing idiom (5c–50c, "cheap and
frequent", never raised on repeat buyers):

    Agent Compute, one cycle (3 days)      50c
      -> covers ~20 funded turns/day at flash
      -> house cost ~$0.21/seat/cycle, ~58% margin
      -> beyond the allowance: deterministic play, free, forever

Three days rather than a month, to match the cycle everything else runs on — a
seat that straddled a map reset would be selling compute for a board that no
longer exists, the same reasoning that fixed the Cycle Pass at three days.

### 5.2 Do not sell the cap away

The temptation will be a second SKU that raises the daily allowance. Resist it
while agent zones pay cash: "pay more, think more, win more" is pay-to-win
wearing a lab coat. If it is ever sold, the ceiling has to stay well below the
point where thinking harder changes outcomes — and nothing currently measures
whether it does (see §8).

---

## 6. The thing a cap does not fix: there is nothing to play

100 agents chasing today's supply is worse than it sounds.

    1 agent zone x 1 cash hunt / 72h = 0.33 cash hunts/day
    100 agents  ->  one cash hunt each every 10 MONTHS

A paid seat that delivers a cash hunt twice a year is not a product; it is a
complaint with a subscription attached. Supply has to move before seats are
sold:

| Configuration | Cash hunts/day | One per agent every |
| --- | --- | --- |
| today: 1 zone, 1 cash, 72h | 0.33 | 10 months |
| 1 zone, 4 cash, 24h | 4.0 | 25 days |
| 2 zones, 4 cash, 24h | 8.0 | 12.5 days |
| 4 zones, 6 cash, 12h | 48.0 | 2.1 days |

Note what this collides with: `CASH_PER_ZONE = 1` exists because 24 funded hunts
per zone would burn ~$168/day against a $100–300/**month** prize floor. Raising
agent-zone cash supply spends the same budget. So the real question underneath
this proposal is:

> How much of the prize budget goes to 100 agents rather than to the human game?

That is a business decision, not an engineering one, and it should be made
explicitly rather than by tuning a constant. The XP hunts are free to multiply —
the constraint is entirely on the cash ones.

### 6.1 A cheaper answer: make the agent tier mostly XP

If the agent tier's appeal is *watching agents compete* rather than *agents
winning money*, then XP-only agent hunts cost nothing and can be plentiful. Cash
becomes an occasional headline event — which is exactly the shape the review
recommends for the human game (§4f: concentrate the prize into one announced
event rather than scattering it).

This also dissolves §2 entirely: if the agent tier pays no cash, a paid seat is
unambiguously buying a service and no gambling question arises at all. It is the
cleanest version of this proposal, and worth considering before the more
complicated one.

---

## 7. What the agent must never be allowed to do

One line in the proposal needs pinning down: *"the agent handles the game
challenges."*

If that means **agents play agent zones on your behalf** — correct, and that is
what exists.

If it means **agents play the human game on your behalf** — that breaks the
design in three places at once, and none of them is a config change:

- `games/index.ts` scopes module pools by zone kind. Human cash hunts run The
  Crack; agent zones run deduction, negotiation and search. The split is
  structural.
- `tap` rejects any player whose intervals are too regular to be human (σ≈0).
  An agent on a human puzzle hunt gets failed for being what it is — correctly.
- The human money gate (rank, keys, wallet age) exists to make one person with
  fifty wallets expensive. An agent that plays human zones is an automation of
  exactly that.

The zone split must stay structural — the bot checks live inside modules agent
zones never select, so the protection is unreachable by construction rather than
switched off by a flag. **Do not add an `isAgent` bypass.** That converts an
impossibility into a permission check, and permission checks get flipped.

---

## 8. What is not known

Recorded so the plan is not mistaken for a forecast.

**Nobody has asked for this.** Zero external agents have ever connected. A cap of
100 is a bet that demand exists at all, and the cheapest way to test it is a
waitlist before a single line is written.

**Nothing measures whether better thinking wins.** There is no win-rate-by-model
metric, so "pro plays better than flash" is a preference, not a finding — and the
entire premise that a funded seat is worth paying for rests on it. Instrument
before pricing.

**Phase 0's funnel does not measure agents.** Distinct agent identities, requests
per agent, hunts entered by funded versus BYO seats — none of it exists. Without
those, "did the tier work" is an anecdote.

**The 13-calls-per-hunt figure is an assumption.** `inference.ts` never reads
`usage` off the response. Real token counts might be materially cheaper or dearer
than §5's table, and a fixed estimate cannot notice a prompt that grew.

---

## 9. Operating a house-held DeepSeek account

The decision moves the provider relationship onto us, and that brings problems a
BYO design would not have had. None is hard; all of them are easy to discover in
production instead.

### 9.1 One key, one account, one blast radius

`env.DEEPSEEK_API_KEY` is a single credential, and `inference.ts` calls it "the
only place the key appears" — correct, and worth keeping true. But it is now a
**revenue-linked** secret: leaking it does not expose player data, it exposes a
balance someone else can spend.

It belongs wherever `AGENT_MASTER_KEY` and the escrow treasury live, not in a
`.env` on the box, and it should be rotatable without a redeploy.

### 9.2 One hundred seats share one rate limit

Everything goes through one account, so the provider's per-account limits are
shared. One agent bursting degrades the other ninety-nine.

Two things already help and should be kept:

- `runtime.MAX_IN_FLIGHT = 4` bounds concurrent provider calls globally.
- Turns are queued **per tenant** (`queues` is a map of queues, not one queue),
  so a busy agent waits behind itself rather than in front of everyone.

What is missing is a per-seat *rate*, as distinct from a per-seat *budget*. A
seat that has spent nothing all day can still monopolise the four in-flight
slots.

### 9.3 Running dry is safe, and that is a feature to protect

If the account empties or the provider errors, `enabled()` goes false and every
agent falls back to `fallbackFor(ctx)` — a deterministic move, billed zero. The
tier degrades to free deterministic play rather than stopping.

That is the most important operational property here: **an outage costs quality,
not forfeits.** Nobody loses a hunt because a balance ran out. Any change to the
fallback path should be read as a change to that guarantee.

It does need an alarm. A prepaid balance that quietly empties looks, from
outside, exactly like agents that got worse for no reason.

### 9.4 The model is global, so there is no "pro seat" yet

`model()` returns `env.DEEPSEEK_MODEL` for everybody. `CALL_MILLS` is keyed by
model and `canInfer` takes one as a parameter, so the *billing* already
anticipates per-seat models — the *selection* does not exist.

If a premium seat is ever sold on "thinks with the better model", that is a
config change plus a per-seat field. It should not be sold at all until §8's
missing measurement exists: nothing currently shows pro wins more than flash for
its 3.1x price.

### 9.5 Bill what was spent, not what was assumed

Repeated from `AGENTS_BYO.md` §7.5 because a house-held account makes it
sharper: `inference.ts` never reads `usage` off the response. Every figure in §5
rests on an assumed 1,500 input / 200 output tokens that nobody has checked.

Under BYO that inaccuracy was the player's problem. With house-held tokens it is
ours, and it is the difference between a seat that is profitable and one that is
quietly subsidised. Record `prompt_tokens` and `completion_tokens`, bill those,
and reconcile against the provider's invoice monthly.

### 9.6 Refunds, lapses, and leftovers

Small, but they arrive on day one.

- A seat is three days. **Do not pro-rate against tokens already spent** — that
  turns a support request into an accounting exercise. Refund whole cycles or
  not at all, and say so at purchase.
- A seat lapsing mid-hunt must not abandon the attempt. The agent falls back to
  deterministic play and finishes, which is §9.3 and needs no special case.
- Unused allowance does not carry over. Anything that banks turns creates a
  stockpile that lands at once, and §9.2 is why that matters.

---

## 10. Order of work

1. **Decide §6.1 first** — does the agent tier pay cash at all? Everything else
   is shaped by that answer, and the XP-only version is dramatically simpler.
2. **Close the keys hole** (§4). Small, and independently correct.
3. **Waitlist.** Test that 100 people want this before building for them.
4. **Fix agent-zone supply** (§6) to whatever the §1 answer allows.
5. **Meter and cap** — the per-seat daily allowance, billed on measured usage.
6. **Then sell seats**, named as compute (§3.1), with the BYO-inference free
   path live at the same time so the AMOE is real on day one rather than
   promised.
7. **Before the first paid seat**, the operational floor from §9: the key out of
   `.env`, a low-balance alarm, and billing on measured usage. Selling compute we
   cannot meter accurately is how a tier ends up subsidised without anyone
   noticing.
