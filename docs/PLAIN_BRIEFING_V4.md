# LOOTGRID — What's Wrong, What Changes, and What It Feels Like Afterwards

**For:** the team, in plain English.
**Companion to:** [`TEARDOWN_V4.md`](./TEARDOWN_V4.md), which has the arithmetic. This one has none.
**Replaces:** [`briefing.md`](./briefing.md), which described the game *before* phases 1–7.

**One sentence:** the last round of work fixed almost everything we were told to fix, and in
doing so it created three new problems — one of which quietly makes every single thing we
sell bad for the person who buys it.

---

## Part 1 — The major issues

### Issue 1: Buying hints makes you *less* likely to win 🔴 THE BIG ONE

This is the whole problem in one paragraph, so read it twice.

When someone finds treasure, everyone racing for it sees **six doors**. One has the prize
behind it. You pick one. Everyone reveals at once. If several people pick correctly, we
decided the winner should be **whoever used the fewest hints** — the idea being that skill
should beat spending.

It does the opposite.

A player who bought three hints and worked out the answer picks correctly about half the
time. A player who bought nothing and guessed picks correctly one time in six. But when they
*both* pick correctly, **the guesser wins**, because the guesser used zero hints.

Once about eight lazy players are in a race, the person who did the work has a *worse* chance
of winning than the person who did nothing — and they paid us for the privilege.

**Everything we sell is information.** Hints. The Compass. The whole player-to-player market
with its deposits and penalties and reputation scores. Ten rounds of engineering. All of it
sells a thing that lowers your odds. If a player ever works this out and posts the numbers,
we have no answer.

### Issue 2: Twenty-four treasures on the map, one of which has money in it 🔴

Each zone hides 24 treasures. Exactly **one** pays cash. The other 23 pay "XP" — a number
that does nothing, because there is nothing to spend XP on.

Nothing in the game tells you which is which until you've already dug it up. So all the
hints, all the surveying, all the clever deduction — 96% of the time it leads you to a
worthless box.

We are asking players to buy energy so they can dig faster toward nothing.

### Issue 3: The treasure detector says "warm" almost everywhere 🔴

Survey was supposed to be the thinking part of the game — a hot/cold detector you use three
or four times to narrow down where treasure is. It has five readings: **burning, hot, warm,
cool, cold.**

With 24 treasures crammed onto the map, the map is so crowded that:

- **56%** of the time it says **burning**
- **43%** of the time it says **hot**
- **cool** and **cold** essentially never happen

So it's not a detector, it's a coin flip. You can't "survey wide to find a warm area" when
almost the whole map is warm. And it costs 6 energy — three times a dig.

The settings were worked out assuming one treasure on the map. There are 24.

### Issue 4: New players can't touch cash for two days — and cheaters can 🟠

To enter a cash hunt you need to be 48 hours old and have collected six hints that have since
resolved. The intention was to stop one person running fifty fake accounts.

Two things go wrong:

- **For a real new player:** the thing they came for doesn't exist for two days. They install
  a game that promises real prizes, and spend their first session digging holes for a number
  that does nothing. Most of them never come back to find out it gets better.
- **For a cheater:** our check looks at when the *account* was created on our server, not at
  the wallet's real history. So someone makes fifty accounts on Monday, does a few minutes of
  digging on each, and by Wednesday all fifty are cash-eligible. Cost: one boring afternoon.

We built a gate that stops our customers and waves through the attacker.

### Issue 5: Nothing ever happens at a particular time 🟠

There is no reason to open the app at 8pm rather than never. The map quietly resets every
three days and nobody is told. The Weekly Final — the big scheduled event we designed to give
people a reason to come back — was never built.

Games live or die on appointments. We have none.

### Issue 6: There's nothing to get good at after the first few hours 🟠

Six doors, narrow it to two. That's the ceiling. Once you understand how hints work — a
couple of hours — there is nothing further to master.

The one long-term ladder we designed (Prospector rank, based on how accurate your hints turn
out to be) exists on the server but **the app never shows it.** And the leaderboard players
*do* see is fake — a hardcoded list of made-up names. In a game where your rank decides
whether you can play for money, a fake leaderboard is a trust problem waiting to happen.

### Issue 7: The app is built for a phone bigger than our players own 🟡

The screen size is still hardcoded at 390×844. Most of our target audience is on something
smaller, so it clips. Also, the grid draws all 3,600 tiles twice — about 7,200 things on
screen at once — on phones we've specifically chosen to target because they're cheap.

Both are written down in the README as known issues. They've been known for three rounds.

---

## Part 2 — The major changes

Seven changes. The first three are the ones that matter; the rest are important but ordinary.

| # | Change | Fixes |
|---|---|---|
| **1** | **Fix how the race is won** — more doors when more people race, score the top *three* picks instead of one, and split the prize on exact ties | Issue 1 |
| **2** | **Fewer treasures, more of them real** — 12 per zone instead of 24, and **4** pay cash instead of 1. Two zones instead of four. Worthless finds pay **energy** instead of XP | Issue 2 |
| **3** | **Retune the detector** for the new treasure count, and add a test that shouts if anyone breaks it again | Issue 3 |
| **4** | **Check the real wallet, not our account row** — and turn the two-day wait into a visible progress bar with the locked prize on screen | Issue 4 |
| **5** | **Build the Weekly Final** and announce the map reset instead of doing it silently | Issue 5 |
| **6** | **Show the rank ladder, build a real leaderboard,** and add the third action — a free public flag saying "I think it's here" | Issue 6 |
| **7** | **Make the app fit the phone,** and only draw the tiles that are on screen | Issue 7 |

### Change 1 in more detail, because it's the one that counts

Three small adjustments to the race:

**a) The number of doors grows with the crowd.** Six doors is fine when three people race. When
twenty race, six doors means three of them guess correctly by pure luck. So: doors go up with
the number of entrants, from 6 up to a maximum of 24, and the number is announced before
anyone commits. Hints knock out a *percentage* of doors, not a fixed count — so a hint that
rules out a quarter of the map still rules out a quarter of the doors, whether there are 6 or
24. The informed player keeps their edge; the guesser's odds fall from 1-in-6 to 1-in-24.

**b) You pick your top three, in order.** Instead of one pick that's either right or wrong, you
rank your three best candidates. If the treasure is behind your first choice you score 3, your
second 2, your third 1. Highest score wins.

This is the part that makes the game feel fair. Right now, a player who brilliantly narrows
six doors to two and then picks the wrong one of the two gets exactly the same result as
someone who wasn't paying attention: nothing. That's the single most common reason skill
games get accused of being rigged. With ranked picks, doing the work always shows up in the
result, even when luck doesn't go your way.

**c) Exact ties split the prize.** At the moment, a perfect tie is broken by a hidden
calculation neither player can see or predict. That is indefensible on a cash prize. Split it.

### Change 2 in more detail

We're changing three numbers and deleting one reward type:

- **24 treasures → 12.** Fewer treasures means the detector works (see Change 3) and the map
  has actual empty space in it, which is what makes finding something feel like finding
  something.
- **1 cash treasure → 4.** One in three finds now pays money instead of one in twenty-four.
- **4 zones → 2.** We have almost no players. Splitting them across four separate maps means
  four empty markets and four empty races. One busy zone beats four ghost towns. Add zones
  back when we have the players to fill them.
- **XP → energy.** A find that pays "50 XP" pays nothing, because XP buys nothing. A find that
  pays 20 energy is worth about a penny at our own shop prices, and — more to the point — it's
  useful on the very next tap. Every find should pay *something*.

We checked the money: with these numbers we'd be giving away roughly **$200–280 a month** in
prizes, which is inside the $100–300 we already agreed to self-fund.

---

## Part 3 — How the system works today

Here's the whole machine as it currently stands, in order.

### The map

- Each zone is a **60 × 60 grid = 3,600 covered tiles.**
- **Your fog is private.** You uncover tiles for yourself; nobody else sees what you've found,
  and their digging doesn't uncover anything for you. (This was a big fix last round and it
  works well.)
- Hidden under the tiles are **24 treasures.** One of them has real money in it. The other 23
  pay XP.
- Every **3 days** the map is torn up and reprinted with treasure in new places. The four zones
  reset on staggered schedules so they're never all empty at once.

### Energy — the thing that limits you

- You hold up to **40 energy.** It refills at **1 point every 6 minutes** — a full bar takes
  **4 hours.** New players start with 30.
- **Dig** a tile: **2 energy.** Uncovers one tile.
- **Survey**: **6 energy.** Tells you roughly how far the nearest treasure is, without
  uncovering anything.
- **Enter a cash hunt**: 3 energy. **Enter an XP hunt**: 2 energy.

So one full bar is about 20 digs, or 6 surveys, or some mix. A whole day's energy is about
120 digs.

### What's under a tile

Five kinds, and since last round they all actually do something:

| Tile | How common | What happens |
|---|---|---|
| empty | 56% | Nothing |
| clue | 17% | Always gives you a hint |
| trap | 12% | Costs double energy, and gives you a hint that's **false** |
| mystery | 9% | Uncovers one neighbouring tile for free |
| puzzle | 6% | A small minigame worth XP |

### Hints — how you work out where treasure is

- **35% of digs** give you a hint. Clue and trap tiles always give one.
- A hint is always about the **treasure nearest to the tile you just dug**. So to aim your
  hints, you dig where you think treasure is — the digging *is* the aiming.
- Each treasure has exactly **6 hints** in existence, decided and locked in before anyone
  played, so we can prove afterwards that we didn't make them up.
- Hints come in three strengths, and **we publish how often each one lies**:
  - **Broad** (e.g. "it's in the north-west") — right 90% of the time
  - **Medium** (e.g. "it's in this band of rows") — right 70%
  - **Sharp** (e.g. "it's within this ring") — right 50%
- Hints can be **sold to other players.** A hint can never be priced above 25% of the prize
  it's about. We take 2.5%, waived on anything under 5¢.

### Survey — the hot/cold detector

Costs 6 energy. Reports one of five readings — **burning / hot / warm / cool / cold** — based
on how far the nearest treasure is. It deliberately won't tell you *which* treasure, and it
won't give you a number, because a number would let you pin the location exactly with two
readings.

### Finding treasure, and the race

1. You dig a tile and there's treasure under it.
2. You get a **20-minute head start** — not to win alone, but to prepare: apply your hints,
   buy more, narrow it down.
3. Then it goes public and anyone in the zone can enter.
4. Entering a cash hunt costs a **key**. You get **5 keys a day** and **there is no way to buy
   one** — not with money, not with referrals. This is deliberate: money buys information and
   digging, never a chance at the prize. It's what keeps us off the gambling line.
5. **The race is "The Crack":** six doors, 15 seconds, everyone picks, everyone reveals at
   once. Phone speed and internet speed don't matter at all.
6. Winner takes the prize: **$0.60, $1.20 or $5.00** depending on difficulty, averaging about
   **$1.14.**

### Who's allowed to play for money

To enter a cash hunt you must be **48 hours old** and hold **Prospector rank** — six hints that
have resolved, spread over at least two active days. Rank above that is earned by **how often
your hints turn out to be true**, not by how much you've won.

### The shop

| Item | Price |
|---|---|
| Energy refill | 5¢ |
| Five refills, banked | 20¢ |
| **Cycle Pass** — 3 days of double refill speed + a full bar each morning | 50¢ |
| **Prospector's Compass** — your next 5 hints all concern one treasure you choose | 10¢ |

When your energy hits zero mid-hunt, the app shows you how warm the nearest treasure is and
offers a refill. That's the only time we ever ask for money, which is right.

### First few minutes

Two onboarding cards in plain language, no crypto words, no promises we break. Then a scripted
tutorial that walks you through dig → survey → enter and **guarantees you find treasure**,
paying 100 XP and 10 energy. That first minute is genuinely good.

---

## Part 4 — What it looks like after the changes

### Side by side

| | **Today** | **After** |
|---|---|---|
| Treasures on a map | 24 | **12** |
| ...that pay money | 1 | **4** |
| Zones | 4 | **2** |
| A find that isn't cash pays | 50 XP (worth nothing) | **20 energy** (worth ~1¢, useful immediately) |
| Detector readings | "burning" 56%, "hot" 43%, rest ~never | **Roughly even across all five** |
| Doors in the race | Always 6 | **6 to 24, based on how many are racing** |
| How you answer | Pick one door. Right or wrong | **Rank your top three. You score for being close** |
| Ties | Fewest hints wins → **the guesser** | **Most accurate ranking wins. Exact ties split the prize** |
| Buying a hint | **Lowers** your chance of winning | **Roughly doubles it** |
| The two-day wait | Invisible. Nothing explains it | **A progress bar with the locked prize on screen** |
| Anti-cheat check | Our account's age (free to fake) | **The wallet's real history (costs real time and money)** |
| Reason to come back at 8pm | None | **The Weekly Final** |
| Leaderboard | Hardcoded fake names | **Real, ranked by hint accuracy** |
| Screen | Fixed 390×844, clips on cheap phones | **Fits whatever phone you have** |

### A player's first day — before and after

**Today.** You install. Two nice cards. The tutorial hands you a treasure — that feels good.
Then you're on your own. You survey: "burning." You survey somewhere else: "burning." You dig
ten tiles on the rest of your energy and find nothing — there's a **93% chance** you find
nothing else all session. Somewhere in there you notice everything you found pays "XP," and
that XP buys nothing. You never see a cash prize because you're not allowed near one for two
days, and nothing on screen tells you that. You close the app. Most people don't open it
again.

**After.** You install. Same two cards. The tutorial hands you a treasure. **A second treasure
is guaranteed within your first dozen digs**, and it pays 20 energy — so finding it
immediately buys you more digging. Your surveys now actually differ from each other: "warm"
here, "hot" over there, "cold" in that corner — so you have somewhere to go. On the home
screen there's a $5 prize with a lock on it and a bar reading **"4 of 6 hints · day 1 of 2"**,
so you know exactly what you're working toward and when it opens. You come back tomorrow to
move the bar.

### A player's first race — before and after

**Today.** You've spent two days' energy. You bought three hints for 20¢. You've narrowed six
doors down to two, and you pick right — a genuinely good piece of work. You lose, because
someone who joined ten seconds ago picked at random, got lucky, and used no hints. You have no
way of knowing that's what happened. You just know you did everything right and lost.

**After.** Fifteen people are racing, so there are 15 doors, announced up front. Your three
hints knock it down to about three candidates and you rank them. The true door is your second
choice — you score 2. The lucky guesser has a 1-in-5 chance of even having it in their top
three, and if they do, it's probably ranked third. **You win.** And on the rare occasion you
lose, you can see the scores and know it was close — which is the difference between "unlucky"
and "rigged."

### What it means for the money

**Today:** we sell energy so people can dig faster toward a treasure that pays nothing 96% of
the time, and we sell hints that make them lose. There is no honest reason to buy anything.

**After:**
- Energy is worth buying, because one find in three pays cash and the rest pay energy back.
- The Compass is worth buying, because aiming your hints at a specific treasure now genuinely
  wins races.
- The hint market has a reason to exist, which turns ten rounds of market engineering —
  deposits, penalties, reputation, the audit trail — from decoration into the actual engine.
- We can honestly say **"70% of everything spent on this grid goes into the pot"** and anyone
  can check it against public records. Nobody else in this space can say that.
- Prizes cost us roughly **$200–280 a month**, which we've already agreed to fund.

### What does *not* change

Worth saying clearly, because these are the things we got right and they stay exactly as they
are:

- **Money never buys a chance at the prize.** Five keys a day, for everyone, unpurchasable.
  This is the sentence we hand a lawyer and it does not move.
- **Information is capped at a quarter of the prize.** Buy everything and you still have to
  win.
- **Your map is yours.** Private fog stays.
- **We publish how often our hints lie**, and the hint sets are locked before anyone plays.
- **Phone speed and internet speed never decide a race.**
- **We never interrupt anyone with a popup to sell them something.** The only sales moment is
  an empty energy bar mid-hunt.

---

## Part 5 — The order to do it in

**First, and nothing else ships before them:**

1. Fix the race — scaling doors, ranked top-three picks, split ties
2. 12 treasures, 4 cash, 2 zones, finds pay energy
3. Retune the detector, with a test that guards it
4. Make the app fit the phone; only draw visible tiles
5. Guarantee a second find in the first session

**Then:**

6. The Weekly Final, and announce the map reset
7. Real leaderboard, visible rank ladder, on-chain wallet check, progress bar on the lock
8. Starter offer, a bigger bundle to make the Cycle Pass look sensible, cosmetics
9. **Run one instrumented cycle with real players and answer exactly one question:** does
   one-tap payment get more people to pay than an app store would? The honest answer is
   somewhere in a 10× range, and it decides everything after this point.

**Later:** the public flag ("I think it's here"), the sponsor pitch, a lawyer in Kenya and
Nigeria before real money moves, and the AI-agent layer moved behind its own door — it's a
great story, but it is not something to put in front of someone who opened MiniPay to check
their balance.

---

## In one paragraph

The last round of work was good. The map resets, the fog is private, the tiles do what they
say, the hints add up, energy is a real limit, the first minute hands you a treasure. What's
left is smaller than what's been done: **one line that decides who wins a race, and one number
that decides how much treasure is real.** Fix those two and everything else we've built —
the market, the deposits, the reputation, the audit trail, all of it — starts working for the
first time. Leave them, and we have a beautifully engineered machine for selling people
something that makes them worse off.
