# LOOTGRID server

The game referee: server-authoritative fog, energy and races. Single Node process,
SQLite on disk, no database service to run.

**No money moves through this yet.** `prizeLabel` is a display string; escrow, the
chain indexer and settlement are a separate milestone. See
[`../docs/BACKEND_AND_CONTRACTS.md`](../docs/BACKEND_AND_CONTRACTS.md) for that design,
and [`DEPLOY.md`](DEPLOY.md) to put this on a VPS.

## Run it

```bash
npm install
cp .env.example .env

npm run dev          # tsx watch, :8787
npm test             # 83 tests
npm run typecheck
npm run build        # typecheck + esbuild bundle + migrations → dist/
npm start            # node dist/index.js
```

Readable local logs: `npm run dev | npx pino-pretty`.

Exercise a real race end to end, with the server running under `AUTH_MODE=dev`:

```bash
npx tsx scripts/race-sim.ts
```

Two human-like players and a bot race whatever game the block is running. Expected
every time: **the bot is rejected on timing despite being the fastest**, and the
faster human wins.

## Shape

```
src/
├── index.ts        boot, plugin registration, graceful shutdown
├── env.ts          zod-validated config; refuses unsafe production settings
├── config.ts       game tunables — the numbers to calibrate after launch
├── referee.ts      attempt lifecycle, settlement window, race resolution, fan-out
├── store.ts        the seam: SQLite for durable state, memory for live races
├── energy.ts       lazily computed, never ticked
├── grid.ts         the fog — keyed on a seed that never leaves the server
├── timerWheel.ts   one deadline sweeper for every attempt in the process
├── rooms.ts        websocket rooms + coalesced fan-out
├── ratelimit.ts    in-process token buckets
├── metrics.ts      prometheus registry
├── http.ts         REST + readiness + gated instrumentation
├── ws.ts           websocket protocol, heartbeat, connection caps
├── auth/           PlayerRegistry session-key verification
├── db/             migrations + repositories
└── games/          GameModule interface + the four games
```

## Design decisions worth knowing before changing anything

**The game belongs to the block, not the player.** `gameTypeForBlock()` derives type
and spec from the hunt's salt, so everyone racing a block plays the identical game.
If you got Math Dash and I got Tap Challenge we would not be racing the same thing.

**Elapsed time is measured server-side from when the spec was sent**, never from
packet arrival. This is what stops the prize going to whoever has the best
connection.

**The 400ms settlement window** holds the result open after the first completion and
awards to the lowest elapsed time, tie-breaking on `startedAt` then a hash —
deterministic, never random, so any result can be audited.

**Intervals come from client timestamps, and that is a real limitation.** The client
batches inputs, so several taps arrive in one frame and server-side resolution
between them is zero. A bot can forge plausible jitter. What it cannot forge are the
server-side bounds: total elapsed, and the rule that you cannot claim to have
finished faster than your packets arrived.

**Rejections are fatal by default.** Silently dropping an implausible input lets a
bot spam at 1000/sec and keep whichever inputs clear the floor.

**Memory never guards money.** The client must be told the sequence to play it back,
so it is the easiest of the four to automate. `gameTypeForBlock` restricts it to
puzzle hunts, and a test enforces that.

**In-flight races are lost on restart, on purpose.** Anything still `active` at boot
is marked `abandoned` — it belongs to a process that no longer exists and can never
complete. Fail closed.

## Auth

MiniPay cannot sign messages, which rules out SIWE, ERC-2612 `permit` and Permit2.
Instead:

1. The client generates a keypair in local storage.
2. It calls `PlayerRegistry.bind(sessionKeyAddress)` once — one cheap transaction,
   gas payable in a stablecoin via `feeCurrency`.
3. Every request afterwards is signed with the session key. No wallet interaction.

Requests carry `x-player`, `x-timestamp`, `x-nonce`, `x-signature`. The signature
covers method, path and body, so it cannot be replayed against a different endpoint
or with altered contents. Nonces are single-use; timestamps outside
`REQUEST_MAX_SKEW_MS` are rejected.

`AUTH_MODE=dev` trusts the claimed identity outright, for local work. **The server
refuses to boot with it in production**, along with `CORS_ORIGINS=*` and metrics
enabled without a token.

## Calibration

The thresholds in `config.ts` are justified by simulation, **not by human thumbs on
cheap Android hardware**. `GET /debug/attempts/:id` returns per-attempt interval
distributions, σ and clock skew — pull those from real devices and adjust.

| Knob | Value | Risk if wrong |
| --- | --- | --- |
| `TAP.minIntervalMs` | 25 | Too high → real double-taps fail as cheating |
| `TAP.minSigmaMs` | 8 | Too high → jittery-but-honest players rejected |
| `SEQUENCE.minIntervalMs` | 90 | Aimed taps at distinct targets, so looser than Tap |
| `MEMORY.minIntervalMs` | 120 | Recall-and-reach floor |
| `MATH.minAnswerMs` | 300 | Too high → fast readers rejected |
| `RACE.settlementWindowMs` | 400 | Too low → high-latency players lose unfairly |

Watch `lootgrid_attempt_failures_total{reason="interval_floor"}` after launch. A
spike there most likely means the floor is too tight for real hardware — legitimate
players being failed for cheating — not that you found a bot farm.

## Protocol

**HTTP** — signed requests carry `x-player`, `x-timestamp`, `x-nonce`, `x-signature`

```
GET  /health                           liveness, no dependency checks
GET  /ready                            checks sqlite + registry RPC
GET  /metrics                          prometheus; bearer-token gated
GET  /me                               player + energy
GET  /zones
GET  /zones/:id/grid                   revealed cells + live hunts only
POST /zones/:id/tiles/:r/:c/open       −1⚡
GET  /hunts/:id
POST /hunts/:id/attempts               −3⚡, returns the block's game spec
GET  /attempts/:id                     resume after a reconnect
GET  /audit/zones/:id                  revealed seeds for finished epochs
GET  /debug/attempts/:id               intervals, σ, clock skew; gated in prod
GET  /debug/hunts/:id
```

**WebSocket** `/ws` — rooms are `zone:{id}` and `hunt:{id}`

```
→ { t:'hello',  player, timestamp, nonce, signature }
→ { t:'join',   room }
→ { t:'input',  attemptId, events:[{ seq, kind, t, value? }] }   t = ms since attempt start

← { t:'ready' } { t:'energy' } { t:'tile:revealed' }
← { t:'progress', huntId, players:[{h,pct}] }      coalesced, 5Hz
← { t:'game:update', attemptId, data }             next challenge, sequential games
← { t:'hunt:chasers' } { t:'attempt:complete' } { t:'attempt:failed' } { t:'attempt:lost' }
← { t:'hunt:resolved', winner, elapsedMs, reveal:{r,c,salt} }
← { t:'hunt:closed' } { t:'hunt:expired' } { t:'zone:hunts' }
```

## Not done

- **Client rewire** — the React app still runs its own timers and fake rivals
- **Money** — escrow contract, indexer, settlement relayer
- **Horizontal scale** — SQLite and in-process race state pin this to one instance.
  Don't run two replicas against one volume.
