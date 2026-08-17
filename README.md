# LOOTGRID

**A living map of real prizes someone else put up. Hunt them. Crack them. First to win takes it.**

A mobile-first treasure-hunt game for [MiniPay](https://www.opera.com/products/minipay) on Celo.
Players spend energy uncovering fog tiles on a shared grid; when someone finds a treasure tile
they race other hunters through a speed minigame, and the first to crack it takes the prize.

> ### Status
>
> **The game is real and multiplayer. The money is not.**
>
> A server-authoritative referee owns the map, energy and every race — the client renders and
> forwards input, and is trusted with nothing. What's missing is the escrow contract, chain
> indexer and settlement relayer, so `prizeLabel` is a display string and nothing moves on
> chain yet. That design is written up in
> [`docs/BACKEND_AND_CONTRACTS.md`](docs/BACKEND_AND_CONTRACTS.md).

---

## Repository

| Path | What it is |
| --- | --- |
| `src/` | React client (Vite) — the MiniPay Mini App |
| `server/` | Game referee: Node + SQLite. See [`server/README.md`](server/README.md) |
| `contracts/` | Foundry. `PlayerRegistry` today; escrow later |
| `docs/` | Architecture and design |

## Quick start

**The client will not run without the server.** There is no offline mode — a client that
silently falls back to fake local state is indistinguishable from a working one, which makes
it impossible to tell whether the server is doing anything.

```bash
# terminal 1 — the referee
cd server && npm install && npm run dev     # :8787

# terminal 2 — the client
npm install && npm run dev                  # :5173
```

Point the client elsewhere with `VITE_API_URL=https://your-host` if needed.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run lint` | ESLint (client only; server and contracts have their own) |

---

## The gameplay loop

```
home → onboarding → zone picker → 12×18 grid
                                     │
       ┌── tap a fog tile (−1⚡) ──→ POST /zones/:id/tiles/:r/:c/open
       │                             server returns the type; everyone in the zone sees it
       │
       └── tap a hunt tile ──────→ preview → confirm (−3⚡)
                                     │
                                POST /hunts/:id/attempts
                                     │  server picks the block's game and returns its spec
                                     ▼
                        minigame + REAL rival bars over WebSocket
                                     │
                    ┌────────────────┴──────────────┐
              hunt:resolved (you won)        lost / failed
```

**Energy** gates everything: 12 max, +1 every 9s, computed server-side and never ticked. A fog
tile costs 1⚡, a hunt 3⚡.

**The game belongs to the block, not the player.** Its type and spec are derived from the
hunt's salt, so everyone racing a block plays the identical game — you don't find out which
until you commit.

| Game | Challenge |
| --- | --- |
| **Tap Challenge** | Mash to the target inside the time limit |
| **Math Dash** | Solve N in a row; the server holds the answers and issues one question at a time |
| **Sequence Dig** | Tap shuffled tiles in order |
| **Memory Dig** | Repeat a Simon sequence — XP only, never money |

**Racing** is resolved on server-measured elapsed time from when the spec was sent, inside a
400ms settlement window. Not on packet arrival — otherwise the prize goes to whoever has the
best connection.

---

## Client architecture

React 19 + Vite 8, no router, no state library, inline styles. One hook owns everything, but it
is now a **client of the referee** rather than a simulation of one.

`src/api/`
- `http.js` — fetch wrapper; errors surface as `ApiError` with the server's machine-readable code
- `socket.js` — one WebSocket for the app, with reconnect, room re-join, and input batching
- `session.js` — dev identity. **Production replaces this** with a PlayerRegistry session key
- `config.js` — API URL and timeouts

`src/hooks/useGameState.js` — fetches the world, dispatches socket events, sends inputs, and
keeps optimistic render state so the UI feels instant while the server decides pass and fail.

**Screens** switch on `state.view`; overlays (`HuntPreview`, `Minigame`, `WinScreen`,
`ConnectionGate`) layer on top by z-index.

`src/data/gameData.js` is now presentation copy only. `buildGrid`, `hiddenType`, `HUNTS`,
`PUZZLES` and `SEEDS` are gone — the grid used to be computable from the bundle, so every
treasure location was readable from devtools.

### Design system

Neo-brutalist: hard black borders, offset drop shadows, no rounded corners. Archivo Black
(display), Space Grotesk (body), Space Mono (labels). Three CSS-variable surface themes and
~12 `lg-` keyframes in `src/index.css`. Pixel sprites in `Mascot.jsx` render from 7×7 ASCII
maps into SVG.

---

## What's real

| Feature | Status |
| --- | --- |
| Server-authoritative fog | ✅ The map exists only on the server |
| Energy | ✅ Computed server-side, write-through to SQLite |
| Four minigames | ✅ Server validates every input |
| Multiplayer races | ✅ Real players, real settlement window |
| **Rival bars** | ✅ **Real opponents.** Shows "you're alone on this one" when they are |
| Anti-cheat | ✅ Timing floors, interval variance, clock-skew checks |
| Fairness proof | ✅ Zone seed commits; salt revealed on resolution |
| Persistence | ✅ SQLite; survives restarts |
| Auth | ⚠️ Dev mode locally; `PlayerRegistry` signing ready but needs deployment |
| On-chain game log | ✅ Built, off by default — `LootGridActions` + a durable relay outbox |
| Prize escrow | ❌ Not built — `prizeLabel` is a display string |
| Creating hunts | ❌ Needs escrow; the screen says so rather than faking it |
| Leaderboard / profile activity | ❌ Still static arrays |

---

## Known issues

- **Leaderboard and profile activity are static.** `BOARD_DATA` and `PROFILE_FINDS` are
  hardcoded; the server has the data to derive them but doesn't expose it yet.
- **Fixed-pixel frame.** 390 × 844 is hardcoded in `App.jsx`, so this is a phone *mockup*
  rather than a responsive layout. It needs to be fluid before running in MiniPay's webview.
- **No real wallet.** `src/api/session.js` generates a random address in localStorage. Real
  auth needs `PlayerRegistry` deployed and the client signing requests with a bound key.

---

## Roadmap

**Done** — server-authoritative game, all four minigames, real multiplayer racing, persistence,
rate limiting, metrics, Docker/VPS deployment ([`server/DEPLOY.md`](server/DEPLOY.md)).

**Next** — deploy `PlayerRegistry` and switch the client to signed requests; derive the
leaderboard from real results; make the layout responsive.

**Then** — `LootGridEscrow`, the chain indexer and the settlement relayer, so prizes actually
pay out. Audit before mainnet.

**Optional at any point after `PlayerRegistry`** — flip `RELAY_ENABLED=true` to publish hunt
entries and hunt resolutions to `LootGridActions`, one transaction per action, with no wallet
prompt for the player. Tile reveals are deliberately *not* published: the fog is per-player, and
a public log of who dug where would hand any observer the pooled map back.

Gameplay itself can't go on chain: Tap Challenge is 14 inputs in 6 seconds against ~1s blocks,
so block inclusion order would decide races instead of reflexes. The chain records; the referee
still decides.

### MiniPay constraints that shape all of it

- **No message signing** — rules out SIWE, ERC-2612 `permit` and Permit2. Auth uses a one-time
  on-chain session-key binding instead.
- **Legacy transactions only** (no EIP-1559), but **gas is payable in stablecoins** via
  `feeCurrency` — which is what lets a winner claim a prize without holding CELO.
- **HTTPS required** — MiniPay won't load a Mini App over plain HTTP.

Prizes should be escrowed in **USDm** (18 decimals), **USDC** or **USDT** (both 6 decimals) —
never CELO, whose volatility would make an advertised dollar prize wrong by the time it's won.
