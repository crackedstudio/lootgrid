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
forge install foundry-rs/forge-std --no-git                                   # first time only
git clone --depth 1 -b v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --depth 1 -b v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable.git lib/openzeppelin-contracts-upgradeable
forge test                                                                    # 41 tests should pass

REGISTRY_OWNER=0xYourMultisig forge script script/Deploy.s.sol \
  --rpc-url $CELO_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_KEY \
  --broadcast --verify
```

The script prints two addresses. **`PLAYER_REGISTRY_ADDRESS` is the proxy**, not
the implementation — the implementation changes on every upgrade.

> 🔑 **`REGISTRY_OWNER` must be a multisig.**
>
> The registry is UUPS-upgradeable, which makes the owner the highest-value key
> in the system — higher than the escrow's game signer. It holds no funds, but it
> holds *authentication authority*: an implementation where `isBound` returns
> true unconditionally impersonates every player at once. The escrow signer, by
> contrast, can only ever move escrowed prizes.
>
> Two things bound that risk, and neither replaces a multisig:
> - Upgrades are **timelocked 48 hours**. They must be proposed first, emit
>   `UpgradeProposed`, and cannot execute early. The delay does not let players
>   exit — there is nothing to exit — it buys time to *notice*.
> - Ownership transfer is two-step, so the seat cannot go to a typo.
>
> **Monitor `UpgradeProposed` and alert on it.** An unexpected proposal is the
> only warning you get, and the timelock is worthless if nobody is watching.

The deployer key itself has no lasting authority — ownership is assigned to
`REGISTRY_OWNER` during construction. Deploy to Celo Sepolia first; use the same
command with the mainnet RPC when you go live.

### Upgrading later

```bash
# 1. propose. Starts the 48h clock and emits UpgradeProposed(impl, codehash, payloadHash, eta).
#    The implementation must already hold code — its codehash is pinned now, so
#    the bytecode reviewed during the window is the bytecode that executes.
#    Pass the migration calldata (or 0x for none); its hash is pinned too.
cast send $PROXY "proposeUpgrade(address,bytes)" $NEW_IMPL 0x --private-key $OWNER_KEY --rpc-url $RPC

# 2. watch. 0 means ARMED NOW; type(uint64).max means idle or expired.
cast call $PROXY "upgradeReadyIn()(uint64)" --rpc-url $RPC
cast call $PROXY "pendingUpgrade()(address,bytes32,uint64,bool)" --rpc-url $RPC

# 3. execute, after UPGRADE_DELAY and within UPGRADE_GRACE (7 days).
#    The payload must byte-match what was proposed.
cast send $PROXY "upgradeToAndCall(address,bytes)" $NEW_IMPL 0x --private-key $OWNER_KEY --rpc-url $RPC

# abandon instead
cast send $PROXY "cancelUpgrade()" --private-key $OWNER_KEY --rpc-url $RPC
```

**A proposal expires.** Past `UPGRADE_DELAY + UPGRADE_GRACE` it reverts
`UpgradeExpired` and must be re-proposed — which emits a fresh `UpgradeProposed`.
That is deliberate: without it a matured proposal is a permanently armed
zero-delay upgrade whose only public warning fired arbitrarily long ago.

**A pending proposal is cancelled by an ownership transfer**, so an outgoing
owner cannot arm one and hand the seat over.

**`renounceOwnership()` reverts.** Renouncing would permanently remove the
ability to patch the system's sole authentication authority — strictly worse
than a bad upgrade, which a later upgrade can undo.

Storage is append-only: never reorder or remove existing variables, and take new
slots from the `__gap`. Verify with:

```bash
forge inspect PlayerRegistry storage      # slots 0-2 must never move
```

`test_upgrade_succeedsAfterDelayAndPreservesStorage` covers the layout with a V2
that declares a real storage variable, but it cannot catch every reordering —
diff the `forge inspect` output before and after any storage change.

---

## 1b. Deploy LootGridActions (optional)

Only if you want gameplay published on chain. Skip it and the game is unchanged —
the chain records nothing the server does not already own.

```bash
cd contracts
ACTIONS_OWNER=0xYourMultisig \
ACTIONS_RELAYER=0xHotWalletAddress \
forge script script/DeployActions.s.sol \
  --rpc-url $CELO_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
```

No proxy, on purpose: it holds no funds and no state, so a redeploy is cheaper and
safer than carrying an upgrade key.

Two keys, and they must be different:

| Key | Where it lives | If it leaks |
| --- | --- | --- |
| `ACTIONS_RELAYER` | `RELAY_PRIVATE_KEY` on the VPS | Attacker writes false game logs. Rotate with `setRelayer` — one transaction, immediate. |
| `ACTIONS_OWNER` | Cold / multisig | Attacker re-points the relayer. Still cannot touch funds or identity. |

**Never reuse `REGISTRY_OWNER` here.** That key can impersonate every player; this
one writes log lines. Keeping them apart is what makes the relayer key
cheap to lose.

Fund the relayer with a small CELO float and monitor it — an unfunded relayer
does not break the game, it just stops recording (rows pile up as `pending`,
then `dead`).

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
| `lootgrid_relay_dead_total` | **The relay alert.** A dead row is a game event that will never reach the chain. Non-zero means investigate; `last_error` in `relay_queue` says why. |
| `lootgrid_relay_queue_depth{status="pending"}` | Sustained growth means the relayer cannot keep up with play — raise `RELAY_MAX_IN_FLIGHT`. (`RELAY_BATCH_SIZE` no longer exists — batching went out with the reveal relay, so the relay now sends one transaction per action always.) |

If the relay is enabled, inspect stuck work directly:

```bash
sqlite3 /data/lootgrid.db \
  "SELECT kind, status, attempts, substr(last_error,1,80) FROM relay_queue
    WHERE status IN ('dead','pending') ORDER BY id DESC LIMIT 20;"
```

A relay outage is never a gameplay outage — `enqueue` is fire-and-forget by
design. Treat a growing queue as a billing and verifiability problem, not an
incident.

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

## 6b. Secrets

Four secrets can move money or impersonate people. None belongs in a `.env` on
the box, and all four should be rotatable without a code change.

| Secret | What it is | Blast radius if it leaks |
| --- | --- | --- |
| `ESCROW_TREASURY_PRIVATE_KEY` | The float that funds prize pots | **Everything in the treasury.** Nothing in the contract bounds this — keep the balance small and top it up on a schedule |
| `AGENT_MASTER_KEY` | Derives every house-run agent's key | Every hosted agent's spending rights at once — bounded per player by the vault's `perTxCap` / `perDayCap` / allowlist, and stoppable by the owner's `kill()` |
| `DEEPSEEK_API_KEY` | Buys inference on the house account | A balance someone else can spend. Not player data — but under a paid agent tier it is revenue |
| `METRICS_TOKEN` | Gates `/metrics` and `/debug/*` | Attempt timings, queue depth, and the funnel (conversion, retention) |

Ordering note: the escrow treasury and the agent master key are the two the
codebase itself calls out as the most dangerous on the box. Treat
`DEEPSEEK_API_KEY` as third rather than as an API key, because it is attached to
a balance.

**Rotation.** `AGENT_MASTER_KEY` rotates by re-binding, which every player must
then approve, because binding is their transaction — so plan it, do not do it
under incident pressure.

---

## 7. Security checklist

- [ ] `AUTH_MODE=chain` (the server refuses `dev` in production)
- [ ] The four secrets in §6b are injected, not written to disk
- [ ] `/debug/funnel` returns 404 without the metrics token — it carries
      conversion rate and retention, and lives under `/debug` rather than
      `/audit` for that reason
- [ ] `/audit/*` **is** meant to be public: hint sets, zone seeds and Director
      transcripts are published so players can check our honesty
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
