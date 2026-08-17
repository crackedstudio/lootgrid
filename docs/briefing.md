# LOOTGRID — Plain English Briefing

**For:** team discussion
**What this is:** an outside review of our game. Not a to-do list yet — a set of findings and choices we need to agree on.
**One-line summary:** the machinery we built is excellent. The game sitting on top of it isn't fun or profitable yet. Almost nothing gets thrown away — most of it just finally gets used.

---

## 1. What LOOTGRID actually is (so we're all starting in the same place)

A grid of covered tiles on your phone. Treasure is hidden under some of them. You spend **energy** to uncover tiles. Along the way you pick up **hints** about where treasure is. Find it, win a prize. You can also **sell your hints** to other players.

Three ways we make money: players buy energy, players trade hints (we take a small cut), sponsors fund the big prizes.

---

## 2. The verdict in one paragraph

We built a vault, an armoured truck, and a receipt system that anyone can audit. Then we put a scratch card inside it. The review found that the current game:

- **4 out of 5 new players never find a single treasure in their first session**
- pays a **typical prize of one cent**
- has **almost half the tiles doing literally nothing**, despite having names like "trap" and "clue"
- makes the detective work we designed the whole game around **mathematically impossible to actually do**
- and runs on a map that **one player permanently destroys in about 31 minutes**

We wrote down the right question a while ago — *"is hint-hunting actually fun?"* — and then built nine more things without ever answering it.

---

## 3. The eight problems, in plain language

| # | Problem | What it means in real terms |
|---|---|---|
| 1 | **The map never resets** | Think of a scratch card that never gets reprinted. Once tiles are uncovered they stay uncovered forever. One person playing normally strips a whole map in half an hour. One person can end the *entire game world* in an afternoon. The fix already exists half-built in our system — we just never turned it on. |
| 2 | **The detective work is impossible** | You need about three hints about the *same* treasure to figure out where it is. But hints arrive randomly about four different treasures at once. Getting three about one treasure takes ~34 tile-uncoverings — about three full energy bars — for a treasure that might pay a cent and might expire before you get there. |
| 3 | **Most new players never see the point** | Only 1.85% of tiles have treasure. A new player's first energy bar gives them 12 taps. Chance of hitting treasure: **20%**. Our onboarding literally promises "first to crack it wins" and 80% of people never reach a race. |
| 4 | **The skill we built isn't the skill that wins** | All our design effort went into clever deduction. Then the winner is decided by **who taps fastest** — 14 taps in 6 seconds. Someone who brilliantly worked out the location and someone who wandered onto the tile by luck compete identically, on thumb speed. And for our audience the *feeling* is worse than the reality: **"I lost because my phone is slow"** kills trust, and no server-side fairness fixes a feeling. |
| 5 | **Half the grid is fake** | Tiles are labelled empty / clue / trap / mystery / puzzle. **None of them do anything.** A trap costs you nothing. A clue gives no clue. Our own tutorial says "clues run warm when treasure is near" — that mechanic doesn't exist anywhere in the game. So a new player's very first tap teaches them our words mean nothing. |
| 6 | **Finding treasure is charity** | Everyone shares one map. You burn ~54 taps locating treasure; the instant you find it, everyone in the zone is told, and someone who spent nothing joins on equal terms. The smart move is to let other people do the work. Worse for the business: **a shared map is a free hint.** Every tile someone uncovers tells everyone else where treasure *isn't* — which is a direct tax on the hints we want to sell. |
| 7 | **Energy isn't a real limit** | It refills completely in **108 seconds**. Nobody pays money to skip under two minutes. So the thing we planned to sell can't be sold. And nothing at all carries over between sessions — there's no reason to come back tomorrow. |
| 8 | **The money doesn't add up** | We give away about **$9/day in prizes** and earn roughly **0.2 of a cent per hint trade**. To make $100/day we'd need **50,000 trades a day**. Just to cover the prizes we're giving away we'd need each hint resold 47 times while its price drops 35% per copy. It doesn't reach. Not at scale, not ever, at these numbers. |

---

## 4. The proposed game

### 4a. Give the player three things to do, not one

Right now there is exactly one action: uncover a tile. That's the poverty.

| Action | Cost | What it does |
|---|---|---|
| **Dig** | 2 energy | Uncover one tile. Might give a hint |
| **Survey** | 6 energy | A **hot / cold detector**. Tells you roughly how far the nearest treasure is. Uncovers nothing |
| **Claim** | Free, 3 per cycle | Publicly plant a flag saying "I think it's here." Correct guesses pay a bonus |

**Survey is the big idea.** Three surveys from different spots and you can triangulate a location — the way three people saying "the sound is coming from over there" lets you find the source. It does four jobs at once:

1. It's the actual thinking part of the game — a real puzzle instead of a slot machine.
2. It burns energy **without eating the map** (important — see 4c).
3. It makes our tutorial copy *true*. "Clues run warm when treasure is near" — Survey **is** warmth.
4. It always tells you something useful. There's no wasted spend.

**Claim is free depth.** Public flags let people see where rivals *think* treasure is — which instantly makes bluffing a strategy, and gives us the "living map of what everyone believes" we already advertise.

### 4b. Make the fake tiles real (or delete them)

| Tile | Share of grid | New behaviour |
|---|---|---|
| empty | 56% | Nothing, as today |
| clue | 17% | **Guaranteed** hint about location |
| trap | 12% | Costs double energy **and** gives you a **false** hint |
| mystery | 9% | Uncovers one neighbouring tile free |
| puzzle | 6% | A minigame worth XP, not cash |

### 4c. The single most important change: **your map is yours**

Everyone hunts **the same treasure** in the same zone. But **the fog is private** — what you uncover, only you see.

This one change fixes **four separate problems**:

| Problem it fixes | How |
|---|---|
| Map gets destroyed (#1) | Map size no longer depends on how many players show up. A zone lasts indefinitely |
| Free-riding (#6) | You can't ride on someone else's spending. Discovery is private |
| Shared map killing hint value (#6) | The map stops solving itself for free |
| One person with 50 fake accounts (see §7) | Every fake account now has to pay its own exploration cost. 50 accounts = 50× the energy, not one shared solved map |

And the finder's reward becomes built-in rather than bolted on:

> **You find treasure → you get 20 minutes alone with it.** Not to win it — to *prepare*. Apply your hints, buy a report, narrow it down. **Then it goes public and everyone races.** You just arrive better prepared.

That distinction matters. If the 20 minutes were an exclusive *attempt*, the finder would just win alone every time and multiplayer racing would quietly disappear.

### 4d. One way to win, and it isn't tapping speed

> **"The Crack."** Six candidate tiles. **The same six for everybody.** Your hints eliminate candidates — three good hints might get you from 6 down to 2; no hints and it's a 1-in-6 guess. Everyone gets the same **15 seconds**. Everyone locks in a pick. All reveal at once. Right pick wins.
> **Tiebreak: whoever used FEWER hints.**

Why this is right:
- Winning is decided by **how well you narrowed it down** — exactly the skill the whole game builds.
- **Phone speed and internet speed stop mattering entirely.**
- The tiebreak means **skill beats spending**: the player who got there on fewer purchased hints beats the one who bought their way to the same answer.

Our four existing minigames stay, but as **XP-only side content**. They add flavour; they don't decide cash. Every deep competitive game has exactly one way to win (poker: best hand; chess: checkmate) and all its variety upstream of that.

Also: **tell players what they're walking into.** Right now the game type is hidden until you've already committed. Show type, difficulty and prize up front. Hide the answer, not the shape.

### 4e. The recommended settings

| Setting | Now | Proposed |
|---|---|---|
| Grid size | 216 tiles | **3,600 tiles (60×60)** |
| Energy cap | 12 | **40** |
| Energy refill time | 108 seconds | **4 hours** |
| Treasures live at once | 4 | **24** (2–4 of them cash per day) |
| Map reset | never | **every 3 days** |
| Cheapest prize tier | $0.01 | **deleted** |
| Fog | shared | **private** |

**Why a huge grid is now the point, not showing off.** With a full cycle's energy you can personally uncover about **4% of the map**. Brute force becomes hopeless. **Deduction stops being a flavour and becomes the only way to play** — which is the game we set out to build. And hints finally have an obvious, priceable job: *they reduce how much digging you need.*

### 4f. The rhythm of a cycle

| When | What happens |
|---|---|
| Days 1–2 | Explore, stockpile hints, XP hunts resolve, hint trading |
| Day 3 | **The Vault** — the headline hunt of the cycle, at an announced time |
| Weekly | **The Vault Final** — top-ranked players qualify for one big pot |
| Cycle end | Map resets, new treasure hidden |

**The finale does four jobs:** it's the reason to come back on a schedule, the drama worth talking about, the reason to hoard hints all week, and — importantly — it's **fake-account defence**, because one human being cannot play fifty accounts in a live 90-second window.

### 4g. Something to climb: **Prospector rank**

Ranked by **how accurate your hints turn out to be** — not by how much you've won. Rank **gates entry to cash hunts** and to the weekly final.

This turns a clever hour-one novelty into hour-one-hundred status, and it makes the reputation system we already built onto the blockchain visible to players for the first time.

---

## 5. The money

### 5a. Two currencies. This is the whole trick.

| | **Energy** ⚡ | **Keys** 🔑 |
|---|---|---|
| Buys you | Digging and surveying — exploration and information | Entry into one cash hunt |
| Can you buy it? | **Yes. This is the product** | **Never.** Not with money, not with referrals |
| Supply | Refills over time, daily free top-up, referrals, purchase | **5 per day, flat, per verified wallet** |

**Say this out loud, because it's the most important sentence in the document:**

> Someone who spends $20 does not get more chances to win our money. They get a **better-informed five.**

That one boundary does four things at once: it kills pay-to-win, it kills fake-account farming, it gives the hint market a supply side, and — critically — **it moves us off the gambling line**, because money never buys a chance at a prize. That's the sentence we hand a lawyer.

The 5-key cap will be invisible to normal players (most people won't find 5 treasures in a day anyway). **That's the point.** A good cap is invisible to normal players and painful to abusers.

### 5b. What we're allowed to sell

| Category | Sell it? |
|---|---|
| **Speed and tempo** — energy, faster refills | ✅ Freely — buys attempts at *finding*, not *winning* |
| **Storage** — more hint slots | ✅ Freely |
| **Targeting** — choosing which treasure your hints are about | ✅ Freely |
| **Cosmetics, status, stats** | ✅ Freely |
| **Information** — hints, scout reports | ⚠️ Yes, but **capped at 25% of the prize** |
| **Keys, extra entries, retries, revives** | ❌ **Never.** Cross this line and money is buying chances at cash |

### 5c. The shop

| Item | Price | What it is |
|---|---|---|
| Energy refill | $0.05 | The volume driver |
| 5-pack of refills | $0.20 | Teaches people to buy bundles |
| **Cycle Pass** (3 days) | $0.50 | Double refill speed + daily auto-top-up. **The revenue backbone** |
| **Prospector's Compass** | $0.10 | Your next 5 hints all concern **a treasure you choose** |
| **Scout Report** | 5¢–25¢ | A bundle of hints about one treasure, sold player-to-player |
| **House Scout Report** | 10¢–50¢ | Same, sold by us |
| More hint slots | $0.05 | Lets hint-diggers stockpile inventory to sell |
| Post-game report card | $0.10 | How accurate your hints were vs. everyone else |
| Skins and themes | $0.10–$0.50 | Pure cosmetic |
| Winner's mark on the grid | $0.25 | Permanent, public bragging rights |

**The Compass is the sleeper hit.** It sells the scarce thing (targeting) while *requiring* you to spend energy to cash in on it. It's the only item that makes another item sell more.

### 5d. "Why would anyone buy a hint they could just dig up?"

Fair question. Digging a hint costs about **0.7 cents** of energy. Buying one costs **5 cents** — seven times more.

People still buy, because they're not the same product:

| | Digging | Buying |
|---|---|---|
| Cost | ~0.7¢ | 5¢ |
| **Which treasure it's about** | Whatever's nearest | **The one you chose** |
| When | Eventually | **Right now** |

Digging is cheap and random. Buying is expensive and aimed. **That gap is the entire market**, and it's why both sell without killing each other.

### 5e. Fixed prices, not haggling

Because production is so cheap, sellers would all race to the minimum price anyway. So just set prices:

| Hint quality | How often it's right | Price |
|---|---|---|
| Broad | 90% | **5¢** |
| Medium | 70% | **12¢** |
| Sharp | 50% | **25¢** |

Sellers then compete on **reputation and freshness**, not price. Much better on a small phone screen. (Keep free haggling for the **agent** side of the game, where negotiating *is* the game.)

Related, and important: **the cheapest prize tier has to die.** A 1-cent prize means a hint about it can legally be worth a quarter of a cent — there's no market there. The hint market only works on prizes of **60 cents and up**.

### 5f. Where the money actually comes from — ranked

| Rank | Source | Verdict |
|---|---|---|
| 3 | Our cut of player-to-player hint trades | **Not revenue.** It's a market-health tool. 8,000 trades to make $10 |
| 2 | Hints we sell ourselves | **Real money.** 10–50¢ at nearly pure margin |
| 1 | **Energy players burn manufacturing hints to sell** | **This is the actual business** |

Number 1 is the thesis, and it's worth understanding clearly:

> A player buying energy **to compete** is capped — they only get 5 keys a day. A player buying energy **to supply the market** has **no ceiling at all.**

**One non-negotiable condition on selling our own hints:** we may only sell hints from a set that was **locked in before anyone entered**, and revealed as true or false after. Without that, we're a house that funds the prize, controls the information, sells the information, and could be lying. With it, we're a dealer selling a card from a published deck anyone can audit. The system for this is already built.

### 5g. What losing video ads costs us

MiniPay won't allow rewarded video. So:

- Revenue per player roughly **halves** (~6¢ → ~3¢ per event)
- **Non-paying players now never generate revenue directly.** Ever.
- We have exactly **two** revenue sources: **payers and sponsors**

**But we have a compensating advantage almost nobody in mobile has.** Normally, charging small amounts in emerging markets fails on the *rails*, not on willingness — app store billing needs a card, has a practical floor near $0.99, and takes 30%. MiniPay users already hold digital dollars and pay in one tap. **We can charge five cents and keep five cents.**

So the strategy is **cheap and frequent**: not one 99-cent buyer in a hundred, but **ten five-cent buyers in a hundred**. Show prices in local currency, anchored to a **data bundle or a bus fare** — never to dollars. And **never raise prices on repeat buyers** — a spender's third purchase costs the same as their first, or it reads as punishment.

**Free players pay in distribution instead of attention:**

| What they do | What they get |
|---|---|
| Invite a friend who **completes a hunt** | +80 energy |
| That friend still playing on day 3 | +40 energy |
| Share a result to WhatsApp | +15 energy, max twice a day |
| 5-day login streak | Escalating energy, resets if you miss |

Note: reward the friend **playing**, not installing. And referrals pay **energy only, never keys.**

**And never sell energy from a pop-up.** Only offer it when someone's bar hits empty *while they're mid-hunt on a grid they've been narrowing down.* That's the highest-intent moment in the session and it's currently 108 seconds of dead air.

### 5h. What it takes to break even

Decision already taken: **we self-fund a small prize floor of $100–300/month**, and sponsors scale the headline prize.

| Monthly prize budget | Break-even monthly active players (realistic case) |
|---|---|
| **$100/month** | **~950 players** |
| **$200/month** | **~1,900 players** |
| **$300/month** | **~2,900 players** |

**That's a genuinely reachable first milestone.** And money tied up at any moment is tiny — about **$24** plus the weekly pot.

**The Weekly Final is deliberately elastic, and that's the design.** Same mechanic, same appointment, same qualification — **$5 while we're self-funding, $300–1,000 the moment a sponsor signs.** We never rebuild it, and the habit is already formed by the time the money arrives.

**Concentration is the lever:** one $300 weekly final is a far better headline than a hundred $3 prizes for the same money.

### 5i. The prize doesn't have to be cash

**Airtime and data bundles are often wanted more than the equivalent cash** in our markets — and bulk top-up sells below face value, so it's cheaper for us.

| Prize | Form |
|---|---|
| Routine hunts | Data / airtime |
| **Weekly Final** | **Real cash.** The headline must be real money |
| Runners-up (2nd–10th) | Airtime + rank |

### 5j. Publish the payout ratio

*"70% of everything spent on this grid goes into the pot"* — and anyone can verify it against our public blockchain records.

This is the **single highest-value use of all the infrastructure we already built.** Three phases of engineering turn into a trust claim no competitor in this space can make. Players will work out our take from public data anyway — so pick a number we're happy to defend and put it in the marketing.

---

## 6. The first eight minutes (this is where players quit)

Here's what happens today on a cheap Android over 3G:

| Time | What happens | How bad |
|---|---|---|
| 0:00 | App is built for a **bigger screen than most of our audience owns** | 🔴 Clips or letterboxes on most target phones |
| 0:25 | Onboarding says *"pre-funded and locked on-chain"* | 🔴 Jargon. These people use MiniPay as a money app, not a crypto app |
| 0:40 | *"Clues run warm when treasure is near"* | 🔴 **That mechanic doesn't exist** |
| 0:55 | Pick one of 4 zones, with no stated difference between them | 🟡 A choice with no information isn't a choice |
| 1:12 | First tile is a "trap." **Nothing happens** | 🔴 Tap one teaches: our words mean nothing |
| 1:15–2:30 | Nine more taps, a few useless hints, **no treasure found (80% likely)** | 🔴 **This is where they leave** |
| 2:30 | Energy empty. 108 seconds of nothing. No offer, no prompt | 🔴 Highest-intent moment in the session, completely wasted |
| ~5:10 | If they win at all: **one cent** | 🔴 We promised cash |

**What it should be instead:**

1. Onboarding down to **two cards**, plain language, no crypto words, no promises the game can't keep
2. **A scripted treasure on tap 3** — tutorial zone, calibrated bots, **impossible to lose**, pays a **real** prize
3. **A second guaranteed find by tap 15.** Only go random after two completed races
4. Hints tell you about location from the very first tap
5. The empty-energy screen offers a refill **and** shows how close the nearest treasure is
6. Weight a new player's first five hunts toward **good prizes** — never the cheap tier

For reference: **Clash Royale**'s tutorial battle cannot be lost. **Candy Crush** level 1 cannot be failed. Every top-grossing mobile game hands you the fantasy inside 60 seconds.

---

## 7. Cheating and the law

### 7a. One person, fifty accounts

This is the biggest threat to a prize pot with real money in it. Free energy means hundreds of free digs per account per day. Fifty burner wallets means hundreds of cash entries a day, draining a pot funded for real people. Anti-bot detection catches *scripts*; it does not catch *one human with fifty wallets*.

Our defences, strongest first:

| Defence | Why it works |
|---|---|
| **Private maps** | Every fake account must pay its own exploration cost. 50 accounts cost 50× the energy instead of sharing one solved map |
| **Rank gate on cash hunts** | Rank is earned by hint accuracy **over time** and can't be bought or rushed. A fresh burner can't reach it |
| **5 keys/day, unpurchasable** | Hard ceiling on how much any one identity can extract |
| **Wallet age + activity check** | An empty new wallet is free to create; one with real history isn't |
| **Everyone finishes at the same moment** | One human cannot play 50 accounts in a live 90-second window |
| Win cap per wallet per cycle | Backstop if everything above fails |
| Skill-based winning | Fifty accounts don't make you better at deduction |

**Bottom line for the team: do not put real money into a zone until private maps, the rank gate and the wallet check are all live and tested.**

### 7b. The four rules that keep this from becoming pay-to-win

Every future money-making idea gets tested against these:

1. **Money never buys a key, an entry, or a retry.** Five shots a day, for everyone alive.
2. **Information is capped at 25% of the prize.** Buy every hint and you still have to win.
3. **The tiebreak rewards using fewer hints** — so spending actively costs you the close ones.
4. **The finale is skill-decided and hint sales are closed by then.** The last act can't be bought.

### 7c. Legal

Selling energy that a player *needs* in order to compete for a cash prize is **an entry fee with extra steps.** That's a gambling-adjacent problem.

The two-currency split is what gets us off that line: **money buys information and exploration; it never buys a chance at the prize.**

We reinforce it with a genuine free path to every prize, prizes that don't scale with spending, publishing how often our hints are false, a public audit trail showing outcomes were skill-based, and country gating at signup.

**We need local lawyers in the actual launch market. Kenya and Nigeria both have active gaming regulators with their own licensing regimes.**

---

## 8. What we should do about the four goals

We've said we want all four: win the hackathon, earn indie income, be VC-scale, and gain prestige. Those conflict and can't all be chased this quarter. The sequence that works:

1. **The hackathon build is already won.** The agent story is complete and defensible today.
2. **Next cycle makes the human game good.** That's the only path to the other three — and it's where **zero** of the last ten phases went.
3. **The agent layer becomes the story, not the product.** Keep it, demo it, but don't ask a regular MiniPay user to configure an AI agent.

---

## 9. The two highest-leverage changes, if we only do two things

**On gameplay: make maps private and reset the map every cycle.** Private maps alone fix four problems at once — map destruction, free-riding, the shared-map-undercuts-hints problem, and the worst of the fake-account economics. Map resets make a zone last forever. Everything else depends on having a world that doesn't die.

Right behind it and inseparable: **Survey plus location-based hints.** Every system we've already built — the market, the deposits, the penalties, the reputation, ten phases of work — is currently pricing something that **can't be used for its stated purpose.** These two changes are what make it usable.

**On money: sell the headline to a sponsor, sell energy to the player.** But understand that the real profit line is neither the prize nor our trade cut — it's **energy burned manufacturing hints for sale**, and that's the line with no ceiling.

> It's the rare case where the honest version and the profitable version are the same version. Right now we're building the other one.

---

## 10. What we need to decide in this meeting

### Already decided — for information, not debate

| Question | Decision |
|---|---|
| Big shared zones, or small private lobbies? | **Big shared zones** — with private maps as the consequence |
| Who funds prizes? | **Both.** $100–300/month from us, sponsors scale the headline |
| Does MiniPay allow our shop and cash prizes? | **Yes.** Unblocked |
| How long is the finder's head start? | **20 minutes — to prepare, not to win alone** |
| What do we test on? | **A real phone on MiniPay.** No emulators |

### Open — we need answers or owners

| # | Question | Why it matters | Recommendation |
|---|---|---|---|
| 1 | **Does one-tap payment actually make more people pay than an app store would?** | **This is the single biggest unknown in the business.** The gap between pessimistic and optimistic is **10×** — the difference between break-even at 950 players and 9,500 | Fund the first cycle cheaply and instrument it to answer **only this** |
| 2 | Which five things do we measure first? | We currently measure **nothing** about players | Taps-to-first-treasure, hints-held-at-entry, energy-empty moments, day-1/day-7 return, and % who pay. Nothing else until those five are trustworthy |
| 3 | Is our dev phone anything like our players' phones? | Performance decisions | **Almost certainly not** — dev phones skew expensive. Measure real users and trust that, not the dev device |
| 4 | How vague should the hot/cold detector be? | Whether deduction feels good | Start coarse, tune from real data |
| 5 | If someone guesses wrong, does the treasure reopen? | Player fairness | **Yes.** A wrong guess must not kill a funded prize |
| 6 | Do we add a second, speed-based way to win for people with good phones? | Variety | **Not yet.** Don't add variety before the core is good |
| 7 | How are airtime/data prizes taxed and regulated, market by market? | Prize strategy | Ask the lawyer alongside the gambling question |
| 8 | Do humans and AI agents trade in the same hint market? | Whether the two halves are one game | **Yes** — that's what makes it one game |
| 9 | Is free energy alone a sufficient free entry path, legally? | Gambling exposure | Still open. Lawyer question |

---

## Glossary — words that will come up

| Term | Plain meaning |
|---|---|
| **Fog** | The covering over unopened tiles. "Private fog" = your map is yours |
| **Epoch / cycle** | One round of the game world, proposed at 3 days. "Epoch rotation" = the map resets |
| **Escrow** | Prize money locked up in advance so nobody can run off with it |
| **The Crack** | The proposed way to win: 6 doors, 15 seconds, pick one, everyone reveals at once |
| **Survey** | The proposed hot/cold detector |
| **Sybil attack** | One person pretending to be many players to hoover up prize money |
| **Rake** | Our small cut of a player-to-player trade |
| **D1 / D7 / D30** | What % of players come back after 1, 7, or 30 days |
| **MAU** | Monthly active users — how many distinct people play in a month |
| **Conversion** | What % of players ever spend money |
| **cUSD** | A digital dollar MiniPay users already hold in their wallet |
| **Free-riding** | Benefiting from someone else's spending without spending yourself |
| **Rewarded video** | Watch-an-ad-for-a-reward. **Not allowed to us** |
| **AMOE** | A genuine free way to enter a prize contest — a legal requirement |
