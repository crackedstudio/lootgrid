# LOOTGRID — The Design vs What We Built

**Source of truth:** `LOOTGRID.dc.html` in the Claude Design project
`24b22ef6-cd09-49a1-a689-ace5a256cb59`, read via the DesignSync MCP.
**Compared against:** `src/` as of 2026-08-18.
**Companion to:** [`TEARDOWN_V4.md`](./TEARDOWN_V4.md) (the economy) and
[`PLAIN_BRIEFING_V4.md`](./PLAIN_BRIEFING_V4.md) (the plan). This one is only about
the interface.

---

## Read this first

The design is a **local prototype**. Every number in it is fake, the map is generated in
the browser, and there is no server. Production is **server-authoritative**, and that was
the right call — it is what makes private fog, honest hints and anti-cheat possible.

So this is not a list of things to revert. Almost every difference below happened for a
defensible reason, and a few of them are production being *correct* where the design was
only pretending. The problem is a specific and repeated pattern:

> When a mechanic moved to the server, the **feedback** for that mechanic was deleted
> rather than re-implemented against the server.

The design tells you what a tap cost, where treasure is, what a tile turned out to be, and
what other people are doing — continuously and in plain English. Production knows all of
those things and shows almost none of them.

There is one other theme worth naming up front: **the design's map is 216 tiles and ours is
3,600.** A large share of what follows is downstream of that single number.

---

## Part 1 — The structural divergences

These four are not UI details. Each one changes what the interface has to do.

### 1.1 The map is 16× bigger than the thing that was designed 🔴

| | Design | Production |
|---|---|---|
| Grid | **12 × 18 = 216 tiles** | 60 × 60 = **3,600 tiles** |
| Board pixel size | ~760 × 1,130 (≈2 screens wide) | ~3,720 × 3,720 (≈9 × 9 screens) |
| Navigation | Scroll. That's all it needs. | A two-zoom overview/dig split with no design counterpart |

**Why it matters.** At 216 tiles a map is a *place* — you can hold it in your head, and
"survey wide, then narrow" is a thing a person can actually do. At 3,600 it is a
coordinate space, and we had to invent a whole navigation layer (`view === 'overview'`
vs `'dig'` in [GridScreen.jsx](../src/components/GridScreen.jsx)) to make it usable at all.
That layer is now where the FTUE breaks: a new player's first sight of the core screen is
3,600 six-pixel squares.

It is also the root cause of the survey problem in `TEARDOWN_V4.md` §3 — the detector was
tuned for a map with a handful of treasures on it, and cramming 24 onto a grid this size is
what made "burning" 56% of all readings.

**Change:** bring the grid down toward the design's proportions. `TEARDOWN_V4.md` already
argues for 12 treasures and 2 zones on economic grounds; the same move fixes the map UX and
the survey distribution for free. This is a server change and the biggest single lever here.

### 1.2 `390 × 844` is a design-canvas artifact that shipped ✅ FIXED

The design file declares `"$preview":{"width":390,"height":844}` — that is the **Claude
Design preview viewport**, the size of the little phone frame in the design tool. The
prototype's outer div is styled to match it, complete with `border:4px solid #0C0C10` and
`box-shadow:16px 16px 0 #0C0C10` — a mockup presentation frame.

All of it had been copied into production at [App.jsx](../src/App.jsx).

**Why it mattered.** On a 360 × 640 Android — dead centre of the target market — the bottom
of every screen including the nav bar was off-canvas. This was never a design decision we
were honouring; it was a screenshot border we mistook for a spec.

**Now.** `100dvw × 100dvh` with `env(safe-area-inset-*)`, via `.lg-frame` in
[index.css](../src/index.css). `dvh` rather than `vh` so the Android URL bar collapsing
cannot push the nav off the bottom. The phone mock — border, offset shadow, dotted backdrop
— is restored above 900px, which is the one place it belongs. Verified at 360 × 640, 375 ×
812 and 1280 × 900.

### 1.3 The nav grew from four tabs to six ✅ FIXED

| Design | Production |
|---|---|
| MAP · CREATE · BOARD · YOU | MAP · MARKET · AGENT · CREATE · BOARD · YOU |

`MARKET` and `AGENT` are both post-design additions. `AGENT` is the AI layer that
`PLAIN_BRIEFING_V4.md` itself says "is not something to put in front of someone who opened
MiniPay to check their balance." Six tabs also squeezes every label down to 8px.

**Now.** Back to the design's four. MARKET and AGENT keep their routes and their screens —
nothing was deleted — but they are reached from YouScreen's "MORE" section, where they get a
sentence of explanation each instead of an 8px word on a tab bar. `NAV_VIEWS` keeps the bar
visible on those screens so nobody gets stranded. Labels are 11px now that there is room.

**Still open:** whether `CREATE` deserves a permanent tab for a player who has never
completed a hunt. Probably not, but that is a product call rather than a design gap.

### 1.4 XP was a ladder in the design and is a dead number in production 🟠

The design's profile screen reads **"XP TO LVL 8"** — XP feeds a visible level. Production
kept XP as a reward and never built the ladder, which is exactly `TEARDOWN_V4.md` Issue 2:
23 of 24 treasures pay a number that buys nothing and leads nowhere.

**Change:** either restore the level ladder or take `PLAIN_BRIEFING_V4.md`'s route and pay
energy instead of XP. Both are fine. Paying XP into a void is not. (XP is at least *shown*
now, on YouScreen — but it still buys nothing.)

---

## Part 2 — The map HUD: four bands the design had and we don't

This is the densest cluster of loss in the whole build. The design's map screen carries
four horizontal bands above and below the grid. Production kept a compressed version of one
of them.

### 2.1 The energy legend ✅ FIXED

**Design.** A pip row (one pip per point), a numeric label, and a permanent line of plain
English underneath:

> `1 ⚡ = 1 dig · hunts cost 2–3 · refills 1 every ~9s`

**Production.** A 78 × 12px bar and a 9px `ENERGY 20/40` label in the header corner. **No
legend, and no regen rate anywhere.** The refill countdown appears only on the `stuck`
overlay — i.e. only once you have already run out.

**Why it matters.** Energy gates every action in the game and is the reason for the only
sales moment in it. A player at 4⚡ currently cannot tell whether the next point is 30
seconds or 30 minutes away, so they cannot decide whether to wait or leave — and "leave"
is the safe default. The design answered this question before it was asked, permanently, in
one line of 9px type.

Swapping pips for a bar was correct (a 40-pip row is ~680px and does not fit). Dropping the
legend was not, and the two changes are unrelated.

**Now.** All three. The bar is notched into 2⚡ dig-units so "four digs left" is countable
rather than computed; a `+1 IN 4:12` countdown sits under it; and the legend reads
`2⚡ DIG · 6⚡ SURVEY · 2–3⚡ ENTER · +1 PER 6MIN`, sized to fit one line at 360px.

The countdown needed no new plumbing at all — `nextRegenMs` was already being ticked in
`useGameState` every second and rendered nowhere.

### 2.2 The clue band ✅ FIXED

**Design.** A dedicated band directly under the header: a 40px cyan compass tile, a kicker
(`CLUE 03 · WARMER ↗`), and a full sentence in 13px Space Grotesk —

> "It runs warm near the eastern ridge. Follow the orange."

**Production.** A horizontally-scrolling rail of chips, each `whiteSpace: nowrap`,
`maxWidth: 190`, `textOverflow: ellipsis` — so the actual content of the deduction is
clipped — at 9px in a monospace face.

**Why it matters.** This is the game's central mechanic and the design gave it a headline.
We gave it a truncated tag list. The design's version is also *directional* ("WARMER ↗")
and *legible at a glance*, which is what lets a player act without stopping to read.

The one thing production does better: it shows reliability (`SHARP · 50% RELIABLE`) and lets
you toggle hints on and off to intersect them. That is a genuine improvement and must
survive. The `N LEFT` candidate counter is the best number in the current UI and is set at
9px.

**Now.** Two rows. The band states the conclusion — the candidate count at 22px headline
scale, and what the trusted hints actually say, wrapped and unclipped at 13px. The chips
moved below it and keep what the design never had: published reliability and the ability to
doubt a hint by tapping it off. When nothing is trusted the band says what to do about
that, which is the closest thing this screen has to onboarding.

### 2.3 The live ticker 🟠

**Design.** A marquee pinned under the map: `@maya cracked $4.20 ✕ · @0xKofi found a CLUE ·
@ama beat 38 to $12.00 · new hunt live, eastern ridge …`

**Production.** Gone. The `lg-marquee` keyframe was copied into `index.css` and wired to
nothing.

**Why it matters.** It is the only ambient signal in the design that other people exist.
In a game whose entire premise is racing other players for a prize, production's map is
completely silent — you cannot tell whether the game has 4 players or 40,000.

**Caveat, and it is a real one:** the design's ticker is hardcoded fiction. We must not ship
invented events (see §4.1). Wire it to real server events or show an honest empty state.

### 2.4 The MiniPay balance card 🟡

**Design.** A green-bordered card in the map header showing the wallet balance.
**Production.** Not present anywhere.

Lower priority, and arguably correct to defer — but worth a decision rather than an
accident, since "what am I playing for" and "what do I have" are the two money questions.

---

## Part 3 — Game feel: the tactile layer

**Status: fixed in this session.** Recorded here because it is the clearest example of the
pattern, and because the remaining item (3.4) is still outstanding.

### 3.1 The dig had no feedback until the server replied ✅ FIXED

**Design.** `onTile` is synchronous and does three things in the touch frame: sets
`opened` (which triggers `lg-thwack`), calls `scatterFrom` (characters flee the dig), and
calls `spendFloat` (a `−1 ⚡` rises off the tapped tile). The bar moves immediately.

**Production, before.** `await post(...)`, then nothing at all — no press state, no float,
no energy change — until the response landed. On the connections this game targets that is
400–1200ms of dead air on the single most repeated action in the game.

**Now.** Haptic, cost float and optimistic energy decrement fire on touch and reconcile
against `res.energy`; a trap's double cost throws a correcting float where it was paid;
every failure path restores the optimistic spend.

### 3.2 Four juice animations were authored and never connected ✅ PARTLY FIXED

`lg-costfloat`, `lg-mash`, `lg-marquee` and `lg-blink2` were all copied into
`index.css` and referenced by zero components. `lg-thwack`, `lg-dust`, `lg-winpop`,
`lg-scurry` and `lg-walkA/B` did not make it across at all.

`lg-costfloat` and `lg-thwack` are now wired. `lg-mash` (the tap-game button squash),
`lg-marquee` (§2.3) and the character animations (§3.4) remain unused.

### 3.3 No haptics existed ✅ FIXED

Not in the design either — it is a browser prototype. But the target hardware is cheap
Androids with mushy touchscreens, often used without audio, and `navigator.vibrate` is the
highest feel-per-byte investment available. Now: 10ms on dig, `[15,40,15]` on trap, 25ms on
a reward, `[40,60,120]` on treasure, nothing on empty.

### 3.4 The living world ✅ FIXED

**Design.** A DOM-driven simulation (`simTick`, ~90ms) runs seven pixel-sprite characters
over the map. They **wander** between tiles, drop into a **dig** state with animated dust
puffs (`lg-dust`), **race** toward live treasure, **scatter** when you dig near them
(`scatterFrom`, 165px radius), and **cheer** when somebody wins. `winPop` bubbles float up
over the board. Transforms are written straight to the DOM, not through React state, so
216 tiles and 7 characters stay cheap.

**Production.** Absent. `useCharacterSim.js` existed at one point and is gone from the tree.

**Why it matters.** This is the difference between a map and a spreadsheet, and it is the
single largest remaining visual gap. It is also the answer to §2.3's problem — a living map
communicates "other people are here" without inventing a single fake event, because the
characters are ambient rather than claims about named users.

**Now.** Ported as [useCharacterSim.js](../src/hooks/useCharacterSim.js) +
[MapLife.jsx](../src/components/MapLife.jsx). Five characters wander, dig with dust, race
at live hunts and scatter when you dig near them, driven by a 90ms tick that writes
transforms straight to the DOM. Two departures from the design, both forced by our board
being 16× larger: the crowd is leashed to the scroll viewport and re-anchored when the
player travels, and the sim only runs in the dig view (at overview zoom a 21px sprite would
cover forty tiles). `cheerAll` was not ported — our win screen is a full-screen overlay, so
a cheer behind it can never be seen.

---

## Part 4 — Honesty and trust

### 4.1 Fake data that shipped ✅ FIXED

| Surface | Design | Production |
|---|---|---|
| Leaderboard | Hardcoded fiction (fine — it's a prototype) | **Still hardcoded** — [gameData.js:19](../src/data/gameData.js:19), seven invented names and dollar totals |
| Profile stats | Hardcoded fiction | **Still hardcoded** — [YouScreen.jsx:35](../src/components/YouScreen.jsx:35), every player sees `141 FINDS / $642 WON`, three pixels from their real server handle |
| Recent activity | Hardcoded fiction | **Still hardcoded** — `PROFILE_FINDS` |
| Ticker | Hardcoded fiction | Dropped |

**Why it matters.** In a prototype these are placeholders. In a shipped product where rank
gates access to cash, they are a trust problem — and discovering that one number is invented
retroactively invalidates every other number in the app, including the prize amounts. The
product's pitch is "70% of everything spent goes into the pot, and you can check it."

**Now.** `BOARD_DATA` and `PROFILE_FINDS` are deleted. YouScreen reads `/me` — real handle,
XP, keys, and the Prospector rank ladder with its shortfall line, which had existed on the
server since phase 5 and was only ever surfaced inside a refusal toast. BoardScreen shows
the player's real standing and an honest empty state for everyone else, because no
cross-player aggregate endpoint exists yet. **Still to build:** that endpoint, and an
activity feed.

### 4.2 Onboarding copy — production is *better*, keep it ✅

The design's onboarding is three cards including "First to crack it wins — speed and skill"
and on-chain/escrow jargon. Production cut to two cards, removed every crypto word, and
removed the speed promise — because phase 4 deliberately removed speed from the deciding.
The comment block in [gameData.js](../src/data/gameData.js) explaining why is some of the
best reasoning in the codebase.

**Do not port the design's onboarding copy.** This is production being right.

### 4.3 The win screen 🟠

| | Design | Production |
|---|---|---|
| Prize type size | **66px** | 44px |
| Payout | `PAID · ON-CHAIN {tx} · via MiniPay` receipt | Claim → collect flow with a wait window |
| Share | A **preview card showing the actual text** that will be posted | A bare `SHARE THE WIN` button |
| Attribution | "Pre-funded by @creator's hunt" | Absent |

The payout change is production being correct — the escrow pays by pull, and showing a
receipt for a transaction that has not settled would be a lie. Keep it.

The other three are losses. The share preview in particular is the difference between a
share button people press and one they don't: the design shows you what you are about to
say before asking you to say it.

### 4.4 Losing is still unexplained 🔴

Neither the design nor production explains a loss — the design shows `lostShow` with a name,
production shows `@maya GOT THERE FIRST` and "Better luck on the next hunt." No door reveal,
no scores, no indication of whether you were one square off.

The design cannot help us here, but `PLAIN_BRIEFING_V4.md`'s ranked top-three picks make the
fix nearly free: you now have a *score* to show. Shipping ranked picks without a reveal
screen wastes the entire fairness improvement, because the player cannot see the fairness.

---

## Part 5 — Tile art and accessibility

**Status: fixed in this session**, via [TileArt.jsx](../src/components/TileArt.jsx).

### 5.1 Every tile was a flat rectangle ✅ FIXED

**Design.** Each tile state is a different *object*: undug ground is a hatched dirt mound
with a `?` cut into it; a live hunt is a lit dome wearing a padlock and a prize ribbon,
bobbing; a find is a minted coin in a hole; an emptied tile is pale turned earth. Radial
gradients, specular highlights, inset shading, hard offset shadows.

**Production, before.** Solid-colour rectangles. All of it flattened.

### 5.2 The colour-blind fix was in the design and got dropped ✅ FIXED

The design's `iconFor` gives every tile type a distinct glyph — cross, diamond, divided
square, warning triangle, burst, dash. Production dropped the glyphs along with the domes,
leaving **colour as the only channel**.

That matters more here than in most games: the survey ramp is
`burning`/`hot`/`warm` = red/orange/yellow, which per `TEARDOWN_V4.md` is ~99% of all
readings, and it is the exact triad that collapses for the ~8% of men with a red-green
deficiency. Roughly one in twelve male players could not distinguish the three most common
outputs of the game's core mechanic.

Glyphs are restored, and survey pips now carry a letter as well as a colour.

### 5.3 The palette had a collision ✅ FIXED

Production had `mystery` on `#8A3DFF` — the same purple as an XP hunt dome — and `puzzle`
on lime. The design separates them: puzzle *is* the purple family, mystery gets pink, which
nothing else uses.

### 5.4 Type sizing ✅ FIXED

Both design and production lean on 8–9px letterspaced monospace at 45–55% opacity; production
has **86 instances** of `fontSize: 8` or `9`. That is roughly half the minimum readable size
on a phone at roughly half the required contrast.

This one is *inherited* from the design rather than a divergence — but the design was viewed
at 100% zoom on a desktop monitor, and the product is viewed on a cheap phone in daylight.
Floor everything at 11px, opacity ≥ 0.75, tracking ≤ 0.08em.

---

## Part 6 — Things production added that the design never had

Worth stating plainly so nobody "restores" them away:

- **Private fog.** Uncovered tiles are yours alone. The design had one shared map.
- **Server-held treasure.** The design generated the grid in the browser, so every treasure
  location was readable from devtools.
- **Real hints with published reliability**, toggleable and intersectable, with a
  contradiction banner (`THESE HINTS CONTRADICT — AT LEAST ONE IS LYING`). The best piece of
  signage in the build and it has no design counterpart.
- **The transcript** (`HOW THIS HUNT WAS RUN →`) and the salt reveal.
- **The Coach**, the tutorial pointer, and `lg-flash` for HUD elements.
- **The `stuck` screen** — nearest-treasure band, real countdown, and the single
  correctly-placed sales moment in the product.
- **Keys, the market, anti-cheat, the connection gate.**

---

## Part 7 — What to do, in order

**Done in this pass:**

- Tile art, glyphs and the tactile layer (§3.1, §3.2, §3.3, §5.1, §5.2, §5.3)
- Energy legend, notched bar and regen countdown (§2.1)
- The clue band (§2.2)
- Fake leaderboard and profile stats deleted; rank ladder surfaced (§4.1)
- Type floored at 11px (§5.4)
- The app fits the phone (§1.2)
- Four tabs (§1.3)
- The living world (§3.4)

**Next, and the biggest lever left:**

1. **Shrink the grid** (§1.1). Server-side, coupled to the economy, and it pays out in map
   UX, survey distribution and prize density at once. `TEARDOWN_V4.md` already argues for it
   on money grounds.
2. **Loss-reveal screen** (§4.4) — nearly free once ranked top-three picks land, and wasted
   if they land without it.
3. **A leaderboard endpoint** and an activity feed, so §4.1's honest empty states can become
   honest full ones.

**Then:**

4. Share-card preview and creator attribution on the win screen (§4.3).
5. Live ticker, wired to real events (§2.3) — the living map now covers some of what this
   was for.
6. Resolve XP: ladder, or pay energy (§1.4).
7. MiniPay balance on the map (§2.4) — a decision, not an accident.

**Not a design gap, but the next thing after those:** the app has 52 `onClick` divs and zero
`<button>` elements, so the accessibility tree is literally empty — a screen reader sees
nothing, and neither does any automated test.

## In one paragraph

The design was a prototype and production is a real system, and on every axis where that
distinction matters — fog, authority, provable fairness, honest copy — production is
correct and should not be rolled back. But a prototype's job is to show what the thing feels
like, and on that axis we had lost most of what was built: the ground stopped looking like
ground, the glyphs that made the board readable without colour went with it, the tap stopped
answering, the map went silent, and the four bands of plain-English guidance around the grid
became one row of truncated 9px chips. That is now put back — the ground is ground again,
the crowd is on it, the bar says what it buys and when it returns, and the numbers on the
profile are the player's own. What is left is one endpoint, one reveal screen, and the one
decision that sits underneath a third of the original list: **how big the map should be.**
