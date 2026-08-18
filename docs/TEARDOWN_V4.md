# LOOTGRID — Teardown v4 (post phase 0–7)

External review. Written against the constants actually shipped in `server/src/`, not
against `docs/GAME_AND_ECONOMY.md` (which reviewed the *pre*-phase build and is now
historical). Where this document contradicts `briefing.md`, this one is newer.
A plain-English version of the same findings is in [`PLAIN_BRIEFING_V4.md`](./PLAIN_BRIEFING_V4.md).

---

## 0. Context, reconstructed from the code

| | |
| --- | --- |
| **Game** | LOOTGRID |
| **Genre** | Grid-search deduction with a real-money prize layer and a P2P information market. No clean genre peer — closest mechanical cousins are Minesweeper (verb economy), Battleship (probing), Wordle (shared board, single daily resolution) |
| **Platform** | MiniPay webview on Celo. Low-end Android, Africa-first, cash-motivated, not crypto-native |
| **Stage** | Pre-launch. Full stack built and tested. **Zero external players, zero behavioural data** |
| **Core loop** | Pick zone → dig 2⚡ / survey 6⚡ on a private-fog 60×60 grid → accrue hints → find a treasure tile → 20-min head start → spend a key → The Crack (6 doors, 15s, simultaneous reveal) → prize |
| **Monetization** | 4 SKUs (5¢ / 20¢ / 50¢ / 10¢), P2P hint market at 250bps rake waived under 5¢, information capped at 25% of prize |
| **Metrics** | Funnel instrumented in phase 0. No data in it |
| **Goal** | Hackathon won. Now: indie income, then scale |
| **Hard constraints** | No rewarded video, $0.05 minimum transaction, no message signing, cheap Android |

**Assumption stated explicitly:** business goal read as *sustainable indie income first,
scale second*. Every recommendation below is sequenced against that. If the real goal is
VC-scale growth this quarter, §7 changes materially and you should say so.

---

## 1. Verdict

**Maybe — and it hangs on one line of sort order.**

Phases 1–7 fixed almost everything the last review found. The map rotates, the fog is
private, the tiles do things, the hints aggregate, energy is a real gate, the shop exists,
the funnel is wired, the first sixty seconds hand over a real find. That is an unusually
complete response to a teardown and it should be said plainly.

But the redesign introduced three arithmetic faults that the phases could not have caught
without players, and one of them is fatal in the specific sense that it makes the entire
economy worthless:

1. **The Crack's tiebreak means information has *negative* expected value at scale.** A
   player who buys three hints, narrows six doors to two, and picks correctly *loses* to any
   player who bought nothing and guessed right — because `referee.ts:353` ranks correct
   picks by fewest hints used. At ten uninformed entrants the informed player's win rate is
   **8.1%** against the guesser's **8.4%**, having paid up to 25% of the prize for the
   privilege. Every product you sell — the Compass, the hint market, the bonded listings,
   ten phases of market engineering — prices a good that reduces the buyer's chance of
   winning.
2. **Twenty-four treasures per zone, one of which pays money.** 95.8% of every find,
   every hint, every survey reading and every triangulation points at a 50-XP puzzle. You
   cannot sell energy to accelerate finding something that pays nothing.
3. **Survey — the keystone of the redesign — returns one of two answers 99% of the time.**
   At 24 hunts on 3,600 cells, a reading is `burning` 56% of the time and `hot` 43%. The
   bands were calibrated as though the map held one treasure.

None of the three is a rewrite. Two are config changes and one is a sort comparator. But
until they land, the honest description of the current build is: *an exceptionally well-engineered
system for selling a product that makes its buyer worse off.*

---

## 2. KPI snapshot

Benchmarks are emerging-market casual Android with IAP-only monetization — not global
averages, which would flatter you into the wrong plan.

| Metric | Benchmark | Likely today | Driver |
| --- | --- | --- | --- |
| D1 | 30–40% | **15–22%** | Scripted find lands; 93.5% of first sessions contain no *second* find; cash invisible for 48h |
| D7 | 10–15% | **4–7%** | No appointment mechanic. Nothing happens at a time |
| D30 | 4–7% | **<2%** | Rank ladder is the only progression, and it is invisible |
| Session length | 6–12 min | **5–8 min** | 30⚡ start ≈ 15 digs or 5 surveys. Correctly sized |
| Sessions/day | 2–4 | **1–2** | 4h refill implies 2–3; nothing summons the second |
| ARPDAU | $0.005–0.015 | **$0.001–0.003** | Energy has nothing to accelerate toward |
| Conversion | 1–3% | **<1%** | Compass and hints are anti-products until §3.1 lands |
| LTV (90d) | $0.10–0.40 | **~$0.02** | |
| Prize burn | — | **$137–274/mo** | 1 cash hunt/zone × 4 zones, EV $1.14 (`prizes.ts` weights 60/32/8) |

The burn is now inside the stated $100–300 budget. Phase 5 did its job. The problem is no
longer cost; it is that nothing on the revenue side can currently function.

---

## 3. Pillar 1 — Gameplay and core loop

### 3.1 · P0 · The Crack tiebreak inverts the entire economy

**Problem.** `referee.ts:330–356` ranks a crack hunt on correctness, then `hintsUsed`
ascending, then a hash. Everything downstream follows:

```
informed player:   narrows 6 → 2,  P(correct) = 0.50,  hintsUsed = 3
uninformed player: pure guess,     P(correct) = 0.167, hintsUsed = 0

P(informed wins) = 0.50 × (5/6)^F      F = uninformed entrants

F =  5  →  20.1%
F = 10  →   8.1%     each uninformed entrant:  8.4%
F = 20  →   1.3%
F = 50  →   0.005%
```

Past roughly eight uninformed entrants the informed player is *strictly worse off* than
someone who did nothing. The dominant strategy in LOOTGRID today is to find a treasure, buy
no hints, and pick a door at random. The tiebreak was written to make skill beat spend; it
made luck beat both.

**Fix — three changes, all small:**

1. **Scale the candidate set with the crowd.** `CRACK.doors` is a constant 6. Make it
   `clamp(6, 24, ceil(entrants × 0.75))`, derived from the hunt's salt so it stays identical
   for everyone, and published on the preview. Hints eliminate a *fraction* of candidates
   (a tier-1 quadrant hint kills ~75% regardless of count), so the informed player's edge is
   preserved while the guesser's collapses from 1-in-6 to 1-in-24. Raise `limitMs` to 30s at
   the top of the range.
2. **Grade the answer instead of scoring it binary.** Submit an *ordered top three*; score
   3/2/1 by where the true door lands; highest score wins. A player who narrowed 24 → 4 and
   ranked wrong still beats a guesser who missed entirely. This is what removes the cliff
   where flawless deduction loses to a coin flip — the single most common reason skill-cash
   games are perceived as rigged.
3. **Exact ties split the pot.** Delete the hash lottery. A hash tiebreak on a cash prize is
   indefensible the first time a player works out that it exists.

**Why it works.** Information only has value when it changes the outcome distribution more
than it costs. Right now it changes it in the wrong direction. Door scaling makes the
informed player's edge grow with population instead of dissolving in it — the crowd becomes
the reason to buy hints rather than the reason not to.

**Named example.** *Wordle* resolves every board on the same six-guess grid but scores
1–6, so a strong player and a lucky player are visibly different even when both "win." Its
share-grid — the thing that actually drove the growth — is a *graded* result, not a binary
one. Compare *Among Us*, which resolves binary and where a correct deduction that loses the
vote reads as pure noise; it burned through its audience in months.

---

### 3.2 · P0 · 24 treasures, 1 of them real

**Problem.** `HUNTS_PER_ZONE = 24`, `CASH_PER_ZONE = 1`. Every instrument in the game —
survey, hints, the candidate overlay, triangulation — points at the *nearest* treasure, and
`survey.ts` deliberately refuses to say which. So 95.8% of a player's deduction effort,
energy spend and market activity resolves onto something that pays 50 XP.

```
hunt density        = 24 / 3600  = 0.667%
P(find any hunt in one day of digging, 120 digs) = 55%
P(find the cash hunt)                            =  3.3%
P(find anything in first session after tutorial, 10 digs) = 6.5%
```

The tutorial guarantees find #1. Find #2 is a day away. That gap is the D1 cliff, and it is
*worse* than the 216-cell build the last review condemned — density fell from 1.85% to
0.667%. The scripted find is masking it, not solving it.

**Fix.**
- `HUNTS_PER_ZONE: 24 → 12`, `CASH_PER_ZONE: 1 → 4`. Cash share goes 4% → 33%.
  (An earlier draft of this section said 8/3. Twelve is the right number: at 8 hunts the
  detector calibrates beautifully but a full day of digging finds *anything* only 23% of the
  time, which starves the loop to fix the instrument. Twelve holds density at 0.333% — 33%
  per day — while still being sparse enough for §3.3 to work.)
- Rebalance `DIFFICULTY_WEIGHTS` to `easy 85 / med 13 / hard 2` → EV $0.766/hunt.
- **Cut human zones from four to two** (`store.ts:43–46`). Under private fog, zones no longer
  need to be many — nothing consumes them. Four zones at low DAU is a liquidity disaster:
  it splits an already-tiny population across four separate hint markets and four separate
  Crack races. Keep one human zone until DAU > 2,000.
- **Stop paying XP. Pay energy.** `PUZZLE_HUNT_XP = 50` is a number with no referent. A find
  that pays 20⚡ is worth ~1¢ at shop prices, is a faucet you control exactly, and — this is
  the part that matters — makes non-cash finds *feel* like finds. XP means nothing until
  there is something to spend it on; energy means something on the very next tap.

Burn check: 2 zones × 4 cash hunts, EV $0.766, ~1.5 turnovers/day = **$9.19/day ≈ $276/month**.
Top of the agreed $100–300 budget, and now one find in three pays.

**Why it works.** A treasure map where one in twenty-five chests has anything in it teaches
players to stop opening chests. The strongest predictor of session-2 return in casual
mobile is whether the first session's *second* reward landed.

**Named example.** *Clash Royale* chest slots: every slot pays something, and the variance
lives in *how much*, never in *whether*. Contrast the launch build of *No Man's Sky*, whose
planets were technically full of discoveries that all resolved to the same nothing —
same structural failure, and the same review reaction.

---

### 3.3 · P0 · Survey is a two-outcome instrument sold as a five-outcome one

**Problem.** `SURVEY.bands` are `burning ≤5 / hot ≤12 / warm ≤25 / cool ≤40 / cold`. At 24
hunts on 3,600 cells:

```
P(nearest Chebyshev distance > d) ≈ (1 − (2d+1)²/3600)^24

burning  56%      hot  43%      warm  1%      cool/cold  ≈ 0%
Shannon entropy of a reading = 1.06 bits, for 6⚡ (three digs)
```

`config.ts` reasons that "burning is a 5-cell reach on a 60-wide grid, so a burning reading
leaves ~121 candidate cells." That arithmetic is correct for *one* treasure. With 24 the map
is saturated: `cold` is unreachable, `warm` is a rounding error, and the wide-to-narrow
gradient the loop is built on does not exist — you cannot "survey wide to find a warm
region" when 99% of the map reads warm-or-better.

`survey.ts` already documents the failure honestly ("two readings taken far apart are almost
certainly describing two different treasures") without following it to the conclusion: at
this density the instrument does not compose, so triangulation — the stated point of the
whole mechanic — is unavailable.

**Fix.** Land §3.2 first (12 hunts, not 24), which moves median nearest-distance from ~4 to
~7 cells, then recalibrate to roughly equiprobable bands. At 12 hunts, `burning ≤4 / hot ≤6 /
warm ≤9 / cool ≤14 / cold` gives **24% / 20% / 28% / 24% / 4%** — a real gradient. Verify with
a Monte Carlo in `survey.test.ts` asserting each band lands in 15–30% of random readings —
**and make that test the guard**, so the next person who changes `HUNTS_PER_ZONE` finds out
immediately.

**Why it works.** A detector whose readings are equiprobable carries maximum information per
use. That is not aesthetics, it is the definition — and it is the only way three surveys
cost less than nine digs in information terms, which is the exchange rate the 6⚡ price
implies.

**Named example.** *Hot and cold* in *Zelda: Breath of the Wild*'s treasure sensor pulses
faster over a continuous gradient specifically so every step gives feedback. *Battleship*'s
hit/miss is one bit but it is a *calibrated* bit — 17 targets on 100 cells is a deliberately
chosen density, not an accident.

---

### 3.4 · P1 · The anti-sybil gate is set to punish the honest and wave through the attacker

**Problem.** Cash requires `WALLET.minAgeMs` (48h) plus rank (`6 resolved hints, 2 active
days`). Two things follow:

- **For the honest new player:** the product does not exist for 48 hours. A cash-motivated
  MiniPay user is asked to play for two days on 50-XP rewards before the thing they came for
  becomes available. You are spending your entire D1 budget on a promissory note. The
  onboarding correctly declines to mention cash — which means card 1 now sells a game about
  digging holes.
- **For the attacker:** `admission.ts:105` reads `now - player.createdAt`. That is the
  *server row's* creation time, not on-chain wallet age. Register 50 wallets on Monday, dig
  six hinted tiles on each, and by Wednesday all 50 are cash-eligible at a cost of one boring
  afternoon. The briefing's "wallet age + activity check" shipped as an account-age check,
  which is the half that doesn't bind.

**Fix.**
- Replace the age check with a real on-chain signal — `getTransactionCount` on the address
  plus a minimum non-zero stablecoin balance held for N days. A fresh burner is free; a wallet
  with history is not. This is the only axis an attacker cannot cheaply buy.
- Make the 48 hours *legible and rewarding* rather than a silent lockout. Show the locked
  $5 hunt on the home screen with `Prospector 4/6 hints · day 1 of 2` beneath it. A visible
  locked reward with a progress bar is a retention mechanic; an invisible one is a bounce.
- Pay the first 48 hours in something real and non-prize: a guaranteed **airtime or data
  top-up** on tutorial completion. It is a signup bonus, not a prize, so it does not touch
  the gambling line — and in these markets it is often wanted more than the cash equivalent.

**Named example.** *Duolingo* gates almost nothing but renders every lock as a filling
meter. *Clash Royale* gates arenas on trophies and puts the next arena's art on screen from
your first match. The rule is: never hide the locked thing.

---

### 3.5 · P1 · Nothing happens at a time

**Problem.** No appointment mechanic exists. The Vault and the Weekly Final — the briefing's
answer to D7 and D30 — were never built; grep finds no `vault`, `weekly` or `final` outside
comments. Energy regen (6 min/point, 4h to full) implies 2–3 sessions/day, but nothing
*summons* the second one. A 3-day epoch rotates silently.

**Fix.** Build the Weekly Final as specified, and make the epoch rotation an event rather
than a maintenance task: announce the reprint, publish the previous epoch's `seedSecret` at
that moment (the schema already archives it), and run the Final in the last hour of the
cycle. Deliberately elastic — $5 while self-funded, $300 the day a sponsor signs, same
mechanic either way, so the habit forms before the money arrives.

**Named example.** *Wordle*'s midnight reset is the entire product. *Fortnite* live events
move DAU by double digits for a single 10-minute window. The mechanic costs almost nothing;
the *schedule* is the asset.

---

### 3.6 · P1 · The mastery arc ends in week one

**Problem.** Skill expression is capped at 6 → 2 doors. Once a player understands survey
bands and hint tiers — a few hours — there is nothing further to master. Above that:
`RANK` ladder (surveyor at 20 resolved hints / 60% accuracy, cartographer at 60 / 75%) is
the only long arc, and the client never renders it. `BoardScreen.jsx` and `YouScreen.jsx`
still read `BOARD_DATA` and `PROFILE_FINDS` — **hardcoded arrays**. In a game where rank
gates cash, a fake leaderboard is both a wasted retention system and a trust bomb waiting on
the first player who compares it to the audit endpoint.

**Fix.** Derive the board from `attempts` and `hints`; rank by hint accuracy, not winnings
(you already decided this, you just haven't shown it). Add the third verb — **Claim**, free,
3 per cycle, public flags. It is in `GAME_AND_ECONOMY.md` §4.1 and never shipped, and under
private fog it is the *only* social surface left: it shows what rivals believe without
leaking what they know. That is where bluffing, misdirection and the "living map" in the
README actually come from.

**Named example.** *Foldit* and *GeoGuessr* both derive status from accuracy rather than
winnings, and both retain expert players for years on content that never changes.

### 3.7 · P2 · Render cost on the target device

`GridScreen.jsx` mounts 3,600 cells in the overview and 3,600 in the dig view — ~7,200 DOM
nodes on a device you have explicitly targeted as low-end. Also `App.jsx:31` still hardcodes
`390 × 844`, which the last review flagged and phases 1–7 did not touch; MiniPay's webview
on a 360×640 handset will clip it. Virtualize the dig view and make the frame fluid. Both are
listed as known issues in the README, which is the right place for them but not a substitute
for fixing them before a playtest that is supposed to produce trustworthy numbers.

---

## 4. Pillar 2 — Monetization

### 4.1 Model — the choice is right, keep it

F2P with energy as the primary sink, an information market on top, sponsor-funded headline
prizes. Correct for the platform: no rewarded video, $0.05 floor, one-tap stablecoin
payment with no 30% cut and no card requirement. The strategy of *cheap and frequent*
(ten 5¢ buyers per hundred, not one 99¢ buyer) is right and is genuinely unavailable to an
app-store competitor. Nothing below changes the model.

**Comparable that proves it:** *MPL* and *WinZO* in India monetize skill-for-cash on
sub-₹20 transactions with local payment rails — the same structural bet. **And the
cautionary comp is *HQ Trivia***: free entry, real cash, 2.3M concurrent, no sink. LOOTGRID's
sink is energy, which is why it can survive what HQ didn't — but only once energy has
something to accelerate toward (§3.2).

### 4.2 · P0 · Every product you sell is currently an anti-product

**Problem.** Three of your four SKUs and the entire market resolve to information, and
§3.1 makes information reduce the buyer's win rate:

| SKU | Price | What it actually delivers today |
| --- | --- | --- |
| `compass` | 10¢ | Five hints aimed at one treasure — which, at 3 hints used, *lowers* your Crack ranking below every guesser |
| Hint market | 5–25¢ | Same, plus 25% of prize ceiling on a good that has negative value |
| `refill` / `refill5` | 5¢ / 20¢ | Energy → digs → a find that pays nothing 95.8% of the time |
| `cyclepass` | 50¢ | Same, faster |

**Fix.** §3.1 and §3.2, in that order. There is no monetization work worth doing before
them — every price you tune now is priced against a broken good. After they land, the
Compass becomes what the briefing correctly identified: the only item that makes another
item sell more.

### 4.3 · P1 · The catalogue has no anchor and no first-purchase moment

**Problem.** Four SKUs, top price 50¢, no starter offer, no anchor. `shop/index.ts` records
`NOT_YET_SOLD = [hintSlots, reportCard, cosmetics, houseScoutReport]` — the four items that
would give the catalogue a shape.

**Fix.**
- **Starter offer, 5¢, once, first empty-bar moment:** 3 refills + 1 Compass (30¢ of value).
  Not a discount on a subscription — a demonstration that 5¢ buys something real. First
  purchase is the hardest conversion in the funnel and everything after it is 3–5× easier.
- **Anchor above the Pass.** A $1.00 *Cycle Pass + Compass + slots* bundle exists to make
  50¢ read as the sensible choice. Right now 50¢ is the ceiling, so it reads as the expensive
  one.
- **Ship cosmetics.** `Grant.cosmetic` is a no-op case in `applyGrant`. Cosmetics are the
  only category with no economy risk, no gambling exposure, and no cap — and the neo-brutalist
  art direction is strong enough to carry them. The 25¢ winner's mark on the grid is the
  right first one: permanent, public, and it decorates a shared object.
- **Price in local currency, anchored to a data bundle.** Never in dollars.

**Named example.** *Monument Valley*'s single paid expansion vs. *Candy Crush*'s starter
pack: the starter pack converts 4–6× better because it is priced to be a *decision about
nothing*. The anchor logic is straight from *Clash Royale*'s gem tiers, where the top tier
exists almost entirely to sell the middle one.

### 4.4 · P1 · The prize dilutes to zero exactly as you succeed

**Problem.** Prize supply is fixed at 1 cash hunt per zone. Prize *demand* scales with DAU.
At 10,000 DAU the expected prize per player per day is **$0.00046**. Players will describe
this accurately as "nobody ever wins," and they will be right.

**Fix.** Tie the prize budget to a published fraction of revenue — the 70% payout-ratio
claim in the briefing is the right instrument and the on-chain log is what makes it
provable. Then **concentrate**: one $300 weekly final beats a hundred $3 hunts on the same
budget, every time, for reach, for talkability and for sponsor value. The routine hunts pay
airtime and data; the Final pays cash.

### 4.5 · P2 · The rake is correctly deprioritized — say so and stop tuning it

250bps waived under 5¢ on 5–25¢ trades yields ~0.2¢ per trade. Reaching $100/day needs
50,000 trades/day. This is not revenue and should not be measured as revenue. It is a
market-health instrument and a spam tax. Leave it. The line with no ceiling is energy burned
*manufacturing* hints for sale — a competing player is capped at 5 keys, a supplier is capped
at nothing — and that thesis survives everything above.

### 4.6 Segments

| Segment | Share | Lever | Do not |
| --- | --- | --- | --- |
| Non-payer | 92–97% | Referral energy on *friend plays*, not installs. Share-to-WhatsApp on a graded Crack result (§3.1's top-3 scoring makes a shareable grid possible) | Do not interrupt them with popups. `/zones/:id/stuck` is already the right and only surface |
| Minnow (5¢–50¢) | 2–5% | Starter offer, then Cycle Pass. Never raise the price on a repeat buyer | Do not sell them keys. Not ever |
| Dolphin ($1–5/mo) | 0.3–1% | Compass + hint slots + supplying the market | Do not let spend buy entries |
| Whale | ~0 | **There are no whales here and there should not be.** Keys cap extraction at 5/day by design | Do not build a whale product. It would cost the legal position, which is worth more than the revenue |

**Ruled out, explicitly:** loss-framed offers on an empty bar ("your streak is about to
break"), any bundle that includes an entry or a retry, dynamic pricing by spend history, and
personalized odds. The first three raise ARPDAU 10–20% in month one and cost the gambling
argument — which is the entire company.

---

## 5. Supporting lenses

### 5.1 FTUE — the first eight minutes, on a 360×640 Android over 3G

| Time | What happens | Verdict |
| --- | --- | --- |
| 0:00 | Frame is hardcoded `390 × 844` (`App.jsx:31`) | 🔴 Clips on the modal target device |
| 0:10 | Two onboarding cards, plain language, no crypto vocabulary, no promise the game breaks | 🟢 **Genuinely good.** Phase 6 earned this |
| 0:30 | Zone picker: four zones, differentiated only by accent colour and a `kind` label reading `AGENT` | 🟡 A choice with no information. And `AGENT` will read as a mistake to a retail user |
| 0:45 | Tutorial: dig → survey → enter. Scripted find. 100 XP + 10⚡ | 🟢 The fantasy lands inside 60 seconds. This was the biggest single fix in phases 1–7 |
| 1:10 | 3,600 tiles mount, two zoom levels | 🟡 ~7,200 DOM nodes. Measure it on the real device before anything else |
| 1:30 | First self-directed survey. Reads `burning` | 🔴 So does the next one. And the one after (§3.3) |
| 2:00–6:00 | ~10 digs on 20⚡. **P(second find) = 6.5%** | 🔴 **This is the cliff.** The tutorial paid; nothing else does |
| 6:00 | Bar empties. `/zones/:id/stuck` fires with warmth + refill offer | 🟢 Correct moment, correctly built. Phase 7 earned this too |
| — | Cash prizes: invisible for 48h, unmentioned | 🔴 A cash-motivated user has now played eight minutes of a game about digging holes |

**Prescriptions, in order:** fluid frame → second guaranteed find by dig 12 (extend
`tutorial.ts` to place two, the second one *found* rather than walked to) → surveys
recalibrated → locked-cash progress bar on home → airtime top-up on tutorial completion →
zone picker shows treasure count and last-win time, or ships as one zone (§3.2).

### 5.2 SWOT

**Strengths.** Verifiable fairness that no competitor in this category can claim — committed
hint sets, published reliability, hash-chained transcripts, on-chain settlement. Payment rails
that make 5¢ transactions profitable. A design point (deduction-for-cash) with no direct
competitor. Engineering quality and comment discipline well above the category.

**Weaknesses.** Zero player data. Three arithmetic faults that only players would have found.
A fake leaderboard in a game where rank gates money. An agent layer that is a hackathon asset
and a retail-product liability if it stays visible in the zone picker.

**Opportunities.** Sponsor-funded weekly finals are an easy sell against a *provable* payout
ratio. Airtime prizes cost less than face value. The Crack, once graded, produces a shareable
result grid — the single cheapest growth loop in mobile.

**Threats.** Regulators in Kenya and Nigeria; get local counsel before a real prize goes live.
Sybil economics if §3.4 ships as-is. And the reputational risk that the first player to notice
the hint tiebreak posts the arithmetic publicly.

### 5.3 Mock review — **6.5 / 10**

> *"LOOTGRID is the most honest game I've reviewed this year and one of the least
> satisfying. It publishes how often it lies to you, proves its prizes were funded before you
> played, and lets you audit the whole thing on a public ledger — a level of good faith the
> category has never shown. Then it hands you a detector that says 'warm' everywhere, buries
> one real prize under twenty-three fakes, and quietly ranks the player who worked it out
> below the player who guessed. The bones are extraordinary. The game standing on them keeps
> apologising for something it hasn't done yet."*

**Forecast sentiment:** Play Store 3.6–3.9★. Positive reviews cite fairness and the art
direction. Negative reviews cluster on three things, in this order: *"I never win"*,
*"the hints do nothing"*, *"I played three days before I could enter anything."*

**Top three changes that move the score:** §3.1 (tiebreak) → 7.5. §3.2 (real treasure
density) → 8.2. §3.5 (weekly appointment) → 8.5.

---

## 6. Roadmap

**Now — 1 to 2 weeks, and nothing else ships first**
1. Crack: scale doors with entrants, grade the top-3, split exact ties (§3.1)
2. `HUNTS_PER_ZONE 12`, `CASH_PER_ZONE 4`, two zones, XP hunts pay energy (§3.2)
3. Recalibrate survey bands + Monte Carlo guard test (§3.3)
4. Fluid frame; virtualize the dig grid (§3.7)
5. Second guaranteed find by dig 12 (§5.1)

**Next — 3 to 6 weeks**
6. Weekly Final + epoch rotation as an announced event (§3.5)
7. Real leaderboard and profile from the DB; render Prospector rank (§3.6)
8. On-chain wallet signal replaces account-age; locked-cash progress bar (§3.4)
9. Starter offer, $1 anchor bundle, cosmetics layer, local-currency pricing (§4.3)
10. **Then run the first instrumented cycle** and answer exactly one question: *does one-tap
    payment convert better than an app store would?* The gap between the pessimistic and
    optimistic answer is 10× and it decides everything after this line.

**Later**
11. Claim verb and the public-flag social layer (§3.6)
12. Sponsor surface and the published payout ratio (§4.4)
13. Legal opinion in Kenya and Nigeria before real money moves
14. Agent layer moves behind a separate entry point — keep it as the story, not the product

---

## 7. The two highest-leverage changes

**Gameplay — fix the Crack tiebreak.** It is a sort comparator in `referee.ts:353` and it
currently makes every purchasable and tradeable good in the game reduce its buyer's chance of
winning. Ten phases of market engineering — bonds, slashing, reputation, commit-reveal,
negotiated A2A pricing — are all pricing a product with negative expected value. One
comparator plus a scaling door count converts all of that work from decoration into the
engine. Nothing else in this document has that ratio of effort to consequence.

**Monetization — make finding a treasure pay something 100% of the time.** Not more cash;
more *non-zero*. Energy on every non-cash find, cash on three in eight, airtime on the rest.
Energy is only worth buying if a find is worth reaching, and today 95.8% of finds are worth
nothing at all. This is the change that makes the shop a shop.

> The last review closed by saying the honest version and the profitable version were the
> same version, and that you were building the other one. Phases 1–7 built the honest one
> properly. What is left is one sort order and one density constant standing between it and
> the profitable one.
