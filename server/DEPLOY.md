# Deploying the LOOTGRID server to a VPS

Single box, three moving parts: the Node app, a SQLite file, and Caddy for TLS.
No database service, no Redis, no orchestrator.

---

## 0. Prerequisites

- A VPS (2 vCPU / 2GB is comfortable; 1 vCPU / 1GB works)
- A domain with an **A record** (and AAAA if you have IPv6) pointing at the VPS
- Docker Engine + Compose plugin
- Ports **80** and **443** open

> **TLS is mandatory, not optional.** MiniPay will not load a Mini App over plain
> HTTP. Caddy provisions a Let's Encrypt certificate automatically, which is the
> reason it's in the stack at all.

---

## 1. Deploy PlayerRegistry

The server authenticates by checking session keys against this contract, so it
has to exist before `AUTH_MODE=chain` will work.

```bash
cd contracts
forge install foundry-rs/forge-std --no-git   # first time only
forge test                                     # 10 tests should pass

forge script script/Deploy.s.sol \
  --rpc-url $CELO_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_KEY \
  --broadcast --verify
```

Note the deployed address — it goes in `PLAYER_REGISTRY_ADDRESS`.

The contract holds no funds, has no owner and no upgrade path, so the deployer
key has no lasting authority and losing it costs you nothing. Deploy to Celo
Sepolia first; use the same command with the mainnet RPC when you go live.

---

## 2. Configure

```bash
cd server
cp .env.example .env
```

Fill in at minimum:

| Variable | Notes |
| --- | --- |
| `DOMAIN` | Used by Caddy for the certificate. Must resolve to this VPS. |
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `chain`. The server **refuses to boot** with `dev` in production. |
| `CHAIN` / `RPC_URL` | `celo` + `https://forno.celo.org`, or the Sepolia equivalents |
| `PLAYER_REGISTRY_ADDRESS` | From step 1 |
| `CORS_ORIGINS` | Explicit origins. `*` is **refused** in production. |
| `METRICS_TOKEN` | `openssl rand -hex 32`. Required in production when metrics are on. |

The config is validated by zod at boot: a bad value stops the process with a
readable message rather than failing mysteriously on the first request. Three
production guard rails will refuse to start outright — `AUTH_MODE=dev`,
`CORS_ORIGINS=*`, and metrics enabled without a token. They exist to stop a
catastrophic deploy, so don't route around them.

---

## 3. Bring it up

```bash
docker compose up -d --build
docker compose logs -f app
```

Verify:

```bash
curl https://$DOMAIN/health     # {"ok":true,...}
curl https://$DOMAIN/ready      # {"ok":true,"checks":{"db":true,"registry":true}}
curl https://$DOMAIN/zones
```

`/health` is liveness — no dependency checks, so a slow disk can't get a busy
server killed. `/ready` checks SQLite and the registry RPC; point any load
balancer at that one.

---

## 4. Updating

```bash
git pull
docker compose up -d --build app
```

Compose stops the old container with SIGTERM. The app drains gracefully: timers
stop, WebSocket clients get a 1001 close so they reconnect rather than hanging,
and the SQLite WAL is checkpointed. `stop_grace_period` is 20s and the internal
force-exit is 10s, so shutdown never hangs the deploy.

Migrations run automatically at boot, forward-only, each in a transaction with
its own bookkeeping row — a failed migration can't be recorded as applied.

**In-flight races are lost on restart.** That's deliberate: anything still
`active` at boot is marked `abandoned`, because it belongs to a process that no
longer exists and can never complete. Deploy when the grid is quiet if you can.

---

## 5. Backups

⚠️ **Do not just copy `lootgrid.db`.** In WAL mode, recent commits live in
`lootgrid.db-wal`, so a plain copy can be missing data or be torn mid-write.

```bash
# Consistent snapshot while the server keeps running
docker compose exec app sqlite3 /data/lootgrid.db ".backup '/data/backup.db'"
docker compose cp app:/data/backup.db ./backups/lootgrid-$(date +%F-%H%M).db
docker compose exec app rm /data/backup.db
```

Nightly via cron:

```cron
0 3 * * * cd /srv/lootgrid/server && docker compose exec -T app sqlite3 /data/lootgrid.db ".backup '/data/b.db'" && docker compose cp app:/data/b.db ./backups/lootgrid-$(date +\%F).db && docker compose exec -T app rm /data/b.db
```

Restore: stop the app, replace the volume's `lootgrid.db` with the backup,
delete any stale `-wal` and `-shm` files, start again.

Test a restore before you need one. A backup you've never restored is a guess.

---

## 6. Monitoring

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://$DOMAIN/metrics
```

Worth alerting on:

| Metric | Why |
| --- | --- |
| `lootgrid_attempt_failures_total{reason="interval_floor"}` | A spike most likely means the floor is **too tight for real hardware** and legitimate players are being failed for cheating. This is the one to watch after launch. |
| `lootgrid_attempt_failures_total{reason="timing_too_regular"}` | Bots. A sustained rise means someone is automating. |
| `lootgrid_auth_failures_total` | Sustained `session_key_mismatch` suggests probing. |
| `lootgrid_winner_elapsed_ms` | Distribution shifting down sharply is a cheating signal. |
| `lootgrid_ws_connections` | Growth with no players means sockets aren't being reaped. |
| `lootgrid_http_request_duration_seconds` | SQLite is synchronous; a slow disk shows up here first. |

The `/debug/attempts/:id` endpoint returns per-attempt interval distributions and
σ. In production it's gated behind `METRICS_TOKEN` and returns 404 without it —
it exposes timing data that would help someone tune a bot.

### Calibration

The thresholds in `src/config.ts` are justified by simulation, **not by human
thumbs on cheap Android hardware**. After launch, pull real interval
distributions from `/debug/attempts/:id` and adjust:

| Knob | Current | Risk if wrong |
| --- | --- | --- |
| `TAP.minIntervalMs` | 25 | Too high → real double-taps fail as cheating |
| `TAP.minSigmaMs` | 8 | Too high → jittery-but-honest players rejected |
| `MATH.minAnswerMs` | 300 | Too high → fast readers rejected |
| `RACE.settlementWindowMs` | 400 | Too low → high-latency players lose unfairly |

---

## 7. Security checklist

- [ ] `AUTH_MODE=chain` (the server refuses `dev` in production)
- [ ] `CORS_ORIGINS` set to explicit origins
- [ ] `METRICS_TOKEN` set and non-trivial
- [ ] App reachable **only** via Caddy — compose uses `expose`, not `ports`, so
      8787 is never published on the public interface
- [ ] Container runs as non-root (uid 1001)
- [ ] Firewall allows only 22, 80, 443
- [ ] Backups running **and a restore tested**
- [ ] `docker compose logs` shipping somewhere off-box

---

## 8. Troubleshooting

**Server exits immediately with "Invalid environment"** — a config guard rail
fired. The message names the offending variable.

**`/ready` returns 503 with `registry: false`** — the Celo RPC is unreachable.
The app still serves reads; authentication fails until it recovers. Check
`RPC_URL`.

**Every request is 401 `no_session_key_bound`** — the player hasn't called
`bind()` on PlayerRegistry, or `PLAYER_REGISTRY_ADDRESS` points at the wrong
network.

**A key rotation hasn't taken effect** — registry reads are cached for
`REGISTRY_CACHE_MS` (default 60s). This is deliberate; wait it out.

**Caddy can't get a certificate** — DNS isn't pointing at the box yet, or 80/443
are blocked. `docker compose logs caddy` will say which.

**Players report being failed for cheating** — check
`lootgrid_attempt_failures_total{reason="interval_floor"}` and pull a few
`/debug/attempts/:id`. If σ looks human but intervals dip below 25ms, the floor
is too tight for their hardware. Lower `TAP.minIntervalMs` and redeploy.

---

## 9. What this deployment is not

- **Not horizontally scalable.** SQLite and in-process race state pin you to one
  instance. That's the right trade for a VPS, and the module boundaries
  (`store.ts`, `ratelimit.ts`) are kept narrow so a shared backend can slot in
  later. Don't run two replicas against one volume.
- **Not handling money.** The escrow contract, indexer and settlement relayer are
  a separate milestone. `prizeLabel` is a display string; nothing moves on chain.
