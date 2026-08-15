# LOOTGRID v2 — Implementation Plan

Status: plan. Companion to [`AGENTIC_ARCHITECTURE.md`](./AGENTIC_ARCHITECTURE.md), which owns
the *why*. This document owns the *order*, the file paths and the gates.

Eleven phases. Each one ships something usable, answers exactly one question, and can be
stopped at without stranding the phases before it.

---

## The shape of the work

```
P0  zone typing            ← root change; everything branches on it
     │
P1  hints, no money        ← THE RISK. Cheapest test of the core premise.
     │
P2  hint commitment        ← makes deception auditable; must precede any trade
     │
     ├──────────────┬───────────────────┐
P3  escrow      P4 entry fees      P5 hint trading
     │                                  │
P6  agent zones (modules + async clock) │
     │                                  │
P7  AgentVault + player agents ─────────┘
     │
P8  Director agent
     │
P9  ERC-8004 identity + reputation
     │
P10 treasury agent
```

**Do not reorder P1 before P0, or P2 after P5.** Everything else has slack.

| Track | Can run in parallel with |
| --- | --- |
| Foundry contracts (P3, P5, P7) | The server phase before them |
| Client UI | The server API of the same phase |
| Legal review of entry fees | P1–P3 |

---

## Phase 0 — Zone typing

**Question:** none. Pure refactor, invisible to players.

Everything in v2 branches on whether a zone is played by humans or agents. Doing this first
means no later phase has to retrofit it.

| Work | Path |
| --- | --- |
| Migration: `zones.kind TEXT NOT NULL DEFAULT 'human'` | `server/src/db/migrations/003_zone_kind.sql` |
| `ZoneKind = 'human' \| 'agent'` | `server/src/types.ts` |
| Zone repo reads/writes `kind` | `server/src/db/repos/zones.ts` |
| `gameTypeForBlock(salt, huntId, kind, zoneKind)` | `server/src/games/index.ts` |
| Scope `CASH_GAMES` per zone kind | `server/src/games/index.ts` |
| Scope jitter check (`tap.ts:74`) to `zoneKind === 'human'` | `server/src/games/tap.ts` |
| Expose `kind` on zone responses | `server/src/http.ts` |

**Done when:** every existing test passes unchanged, all zones default to `'human'`, and a
zone seeded as `'agent'` skips anti-automation. Add `server/src/games/zoneScoping.test.ts`
asserting both branches.

**Watch:** the jitter check is currently a correctness guarantee for cash games. Scoping it is
the single most security-sensitive edit in this phase — it must be impossible for a `human`
zone to run with it disabled. Assert that in a test, not a comment.

---

## Phase 1 — Hints, earned by play, no trading, no money

**Question: is hint-driven discovery actually fun?**

This is the riskiest assumption in v2 and the cheapest to test. No chain, no agents, no
market, no money.

| Work | Path |
| --- | --- |
| Migration: `hints`, `player_hints` | `server/src/db/migrations/004_hints.sql` |
| **Typed hint schema** | `server/src/hints/types.ts` |
| Deterministic generation from zone salt | `server/src/hints/generate.ts` |
| Repo | `server/src/db/repos/hints.ts` |
| Award hints on reveal / attempt | `server/src/referee.ts` (observer), `server/src/http.ts` |
| `GET /hints`, `POST /hints/:id/apply` | `server/src/http.ts` |
| Inventory + "apply hint" UI | `src/components/HintsScreen.jsx`, `src/components/GridScreen.jsx` |
| Client API | `src/api/hints.js` |

### The hint schema is a security boundary, not a convenience

Define it now, before anything reads a hint into a model:

```ts
export interface Hint {
  id: string;
  zoneId: string;
  epoch: number;
  kind: 'region' | 'distance' | 'parity' | 'exclusion' | 'adjacency';
  payload: Record<string, string | number>;   // schema-validated per kind
  tier: 1 | 2 | 3;                            // precision
  reliability: number;                        // advertised accuracy of the tier's pool
  expiresAt: number;
}
```

No free-text field, ever. §6 of the architecture doc explains why this is the strongest
control you have; adding a `note: string` later would quietly undo it.

Truth flags are generated alongside hints and stored **server-side only** — they are the
input to P2's commitment.

**Done when:** a player can earn hints, see them, apply them to narrow the grid, and the same
zone salt reproduces the identical hint set.

> ### 🚩 Gate
> If discovery is not fun with perfect information flow and zero friction, no market,
> agent or prize downstream will rescue it. **Stop here and redesign rather than proceed.**

---

## Phase 2 — Hint commitment and audit

**Question: can a player verify the house did not lie more than it said it would?**

Required before any hint is sold, and before entry fees exist. See architecture §5.0.

| Work | Path |
| --- | --- |
| Commit on epoch rotation: `keccak(hintSet ‖ truthFlags ‖ salt)` | `server/src/hints/commit.ts` |
| Store commitment; reveal on epoch close | `server/src/db/repos/hints.ts` |
| `GET /audit/hints/:zoneId` — mirrors the existing `/audit/zones/:id` | `server/src/http.ts` |
| Rolling per-zone accuracy stats | `server/src/hints/stats.ts` |
| Client: display tier reliability before applying | `src/components/HintsScreen.jsx` |

**Done when:** an independent script can fetch a revealed epoch, recompute the commitment,
and confirm observed accuracy matches the advertised tier. Write that script as
`server/src/hints/verify-cli.ts` — if you cannot verify it, neither can a player.

**Watch:** the Director must fix truth flags **before knowing who enters**. In this phase
generation is deterministic so that is free; preserve the property in P8.

---

## Phase 3 — Escrow and real prizes

**Question: does the money path work end to end?**

| Work | Path |
| --- | --- |
| `LootGridEscrow.sol` | `contracts/src/LootGridEscrow.sol` |
| Tests | `contracts/test/LootGridEscrow.t.sol` |
| Deploy script | `contracts/script/DeployEscrow.s.sol` |
| Funding worker (reuse the `relay_queue` outbox pattern) | `server/src/chain/escrow.ts` |
| Migration: `escrow_queue` | `server/src/db/migrations/005_escrow.sql` |
| Prize sizing by difficulty, $0.01–$5 | `server/src/store.ts` (replaces `PRIZE_LABELS`) |
| Claim UI | `src/components/WinScreen.jsx` |

### Contract surface

```solidity
function fundHunt(bytes32 huntId, uint256 amount) external;       // house only
function claim(                                                    // anyone with attestation
    address winner, bytes32 huntId, uint32 elapsedMs, uint16 racers,
    uint256 deadline, bytes calldata signature
) external;
function refund(bytes32 huntId) external;                          // permissionless after expiry
function setCaps(uint256 perHunt, uint256 perDay) external;        // owner
function pause() external;                                          // guardian; never blocks refund
```

Reuse the **exact** `Resolution` typehash from `LootGridActions` so one attestation serves
both the record and the payout. No second trust model.

**Test matrix — all required before mainnet funds:**

| Case | Expect |
| --- | --- |
| Valid attestation, funded hunt | Pays winner once |
| Replay same attestation | Reverts |
| Forged / wrong-signer attestation | Reverts |
| Claim above per-hunt cap | Reverts |
| Cumulative claims above daily cap | Reverts |
| Claim during challenge window | Reverts |
| `refund` after expiry, while paused | **Succeeds** |
| `refund` before expiry | Reverts |
| Attestation from another deployment | Reverts |

**Watch — this is where the attestor key changes meaning.** Today a leak fabricates cosmetic
logs. After this phase the same leak signs payouts. Multisig/threshold signing and live caps
are prerequisites for funding mainnet, not follow-ups.

---

## Phase 4 — Entry fees (x402)

**Question: will players pay to enter, and do agents still find it worth entering?**

⚠️ **Blocked on legal review** (architecture §10). Build behind a flag; do not enable in
production until that returns.

| Work | Path |
| --- | --- |
| x402 settle wrapper | `server/src/payments/x402.ts` |
| Entry gate on rewarded hunts | `server/src/http.ts` (`POST /hunts/:id/attempts`) |
| Free-entry path via energy | `server/src/energy.ts` |
| Fee config per difficulty | `server/src/config.ts` |
| **EV telemetry** | `server/src/metrics.ts` |
| Payment UI | `src/components/HuntPreview.jsx` |

### The metric that matters

Emit `F ÷ (P/N)` per zone as a gauge. Architecture §1: a rational agent refuses a
negative-EV hunt, so on agent zones this ratio crossing 1.0 does not slow participation, it
stops it. Alert on `> 0.6`.

**Done when:** a human can pay to enter, energy admits a player without payment, and the EV
gauge is live on the dashboard.

---

## Phase 5 — Hint trading

**Question: does a market form, and does deduction create value?**

| Work | Path |
| --- | --- |
| `HintEscrow.sol` — commit-reveal trade | `contracts/src/HintEscrow.sol` |
| Tests | `contracts/test/HintEscrow.t.sol` |
| **Hint attestation** — authenticity + tier, *never* accuracy | `server/src/chain/attestor.ts` |
| Listing / bid / settle API | `server/src/market/*.ts` |
| Migration: `hint_listings`, `hint_trades` | `server/src/db/migrations/006_market.sql` |
| Rake, minimum trade size, fee waiver threshold | `server/src/market/fees.ts` |
| Market UI | `src/components/MarketScreen.jsx` |

Extend `attestor.ts` with a third typed struct alongside `Entry` and `Resolution`:

```
Hint(bytes32 hintHash,bytes32 zoneId,uint8 tier,uint16 reliabilityBps,uint256 deadline)
```

Add it to `attestor.test.ts`'s drift guard — that test compares EIP-712 type strings against
the Solidity source, and a new struct that skips it will fail silently in production.

**Watch:** dust and circumvention (architecture §5). Minimum trade size and batched settlement
from day one; retrofitting them after agents have optimised around a per-trade fee is much
harder.

---

## Phase 6 — Agent zones: modules and the async clock

**Question: is there a challenge worth an agent solving?**

No agents yet — build the zones and prove the modules with scripted clients.

| Work | Path |
| --- | --- |
| `deduction` module | `server/src/games/deduction.ts` |
| `negotiation` module | `server/src/games/negotiation.ts` |
| `search` module (adversarial) | `server/src/games/search.ts` |
| Register for agent zones | `server/src/games/index.ts` |
| Async hunt lifecycle — minutes/hours | `server/src/referee.ts`, `server/src/timerWheel.ts` |
| Hunt TTL per zone kind | `server/src/config.ts` |

The `GameModule` interface is unchanged — `generate` / `publicSpec` / `init` / `step` /
`progress` is already the right shape. Each module needs its own test file matching the
existing `games/*.test.ts` convention.

**Watch:** `timerWheel` is currently tuned for 6-second attempts. Hour-long hunts change its
bucketing assumptions — check `timerWheel.test.ts` covers the long horizon before relying on
it.

---

## Phase 7 — AgentVault and player agents

**Question: do agents trade sensibly, and is custody safe?**

| Work | Path |
| --- | --- |
| `AgentVault.sol` | `contracts/src/AgentVault.sol` |
| Tests | `contracts/test/AgentVault.t.sol` |
| Agent key generation + binding | `server/src/agents/identity.ts` |
| **Multi-tenant runtime pool** | `server/src/agents/runtime.ts` |
| Inference provider adapter (DeepSeek) | `server/src/agents/inference.ts` |
| Schema validation + retry + fallback | `server/src/agents/validate.ts` |
| **Typed A2A protocol** | `server/src/agents/protocol.ts` |
| Spend + inference budget enforcement | `server/src/agents/budget.ts` |
| Typed config store | `server/src/agents/config.ts` |
| Migration: `agents`, `agent_config`, `agent_spend` | `server/src/db/migrations/007_agents.sql` |
| Deposit / configure / withdraw / kill-switch UI | `src/components/AgentScreen.jsx` |

### Addresses: three, not one

An agent is a session key with a wallet and a budget — the `sessionKeyOf` / `playerOfKey`
pattern already in `PlayerRegistry.sol`, extended. Architecture §4.

```
PlayerRegistry.sessionKeyOf[player]  →  agent address      (reuse, do not reinvent)
AgentVault.owner                     →  player address
AgentVault.spender                   →  agent address
```

**The agent address must never equal the player address.** If it does, the caps below are
decorative — the agent already controls the wallet. Assert this in `AgentVault`'s constructor
and in a test; it is a one-line invariant guarding the entire custody model.

### Hosting is a pool, not a process

Players do not bring API keys, so the house runs inference and meters it against each vault.
This makes P7 a **multi-tenant service**:

| Requirement | Test |
| --- | --- |
| Per-tenant context isolation | Agent A's prompt never contains agent B's hints or budget |
| Inference budget checked **before** the call | A looping agent cannot bill past its cap |
| Provider key never leaves the server | Absent from client bundle and agent config |
| Fair scheduling | One busy tenant does not starve a hunt |
| Schema-violation rate tracked per model | Gauge in `metrics.ts`; regression is an incident |

Re-run the inference arithmetic against live DeepSeek pricing before fixing the prize range
(architecture §7 assumed ~$0.005/call). Inference is cost of goods sold against the same
deposits that fund prizes.

### Custody rules — non-negotiable

| Rule | Consequence if skipped |
| --- | --- |
| Agent is a **spender**, never a key holder | Injection drains the player's balance |
| Per-tx and per-day caps, set by the player | One bad trade empties the vault |
| Allowlisted spend targets | Agent pays an attacker's address |
| Withdrawal not blockable by the agent | Funds held hostage by a bug |
| Kill switch revokes spender rights instantly | No incident response |

Agent-to-agent messages are **schema-validated structs**. A rival's message is
attacker-controlled input reaching a model that can move a user's money — free-text
negotiation here is a funded attack surface, not a UX nicety.

Cap negotiation rounds. Architecture §7: ~200 inference calls per hunt is ~8% of a $12 prize
and far worse against a $0.50 one. Budget inference per hunt and enforce it in `budget.ts`.

---

## Phase 8 — Director agent

**Question: does live difficulty beat deterministic generation?**

| Work | Path |
| --- | --- |
| Typed directive schema | `server/src/director/types.ts` |
| Pipelined generation (round N+1 during N) | `server/src/director/index.ts` |
| Timeout → deterministic fallback | `server/src/director/fallback.ts` |
| Hash chain over directives | `server/src/director/transcript.ts` |
| Publish chain head with resolution | `server/src/chain/attestor.ts` |
| Transcript viewer | `src/components/HuntTranscript.jsx` |

Four constraints from architecture §4, each with a test:

1. Schema-validated output — reject anything else, including extra fields
2. Per-round, broadcast identically to all racers
3. Pipelined — never in the critical path
4. **~200ms timeout → `generate(seed, difficulty)`**; gameplay never waits

The Director gets **no wallet, no DB writes, no arbitrary HTTP**, and sees anonymised
aggregate progress only. Assert the blinding in a test: given two states differing only in
player identity, the directive must be identical.

---

## Phase 9 — ERC-8004 identity and reputation

**Question: does trust scale past players who already know each other?**

| Work | Path |
| --- | --- |
| Agent registration | `server/src/agents/identity.ts` |
| Feedback after each trade | `server/src/agents/reputation.ts` |
| Reputation gate before paying | `server/src/agents/runtime.ts` |
| Reputation display | `src/components/MarketScreen.jsx` |

Registries are already deployed (architecture §3). Self-feedback is blocked by the contract,
but two wallets can still wash-trade — weight reputation by stake and count only *verified*
trades. Plan to detect and slash, not to prevent.

---

## Phase 10 — Treasury agent

**Question: can the economy self-regulate?**

| Work | Path |
| --- | --- |
| `Treasury.sol` — caps, allowlisted strategies | `contracts/src/Treasury.sol` |
| Allocation proposals | `server/src/treasury/agent.ts` |
| Prize sizing from real inflow | `server/src/treasury/pricing.ts` |
| Liquidity buffer so payouts never wait | `server/src/treasury/buffer.ts` |

Replaces static difficulty→prize mapping with sizing driven by actual deposits, inside
contract caps. The agent proposes; the contract disposes.

---

## Verification gates

Every phase, before merge:

```bash
cd contracts && forge test && forge fmt --check
cd server   && npm run typecheck && npm test
cd .        && npm run lint && npm run build
```

Phase-specific additions:

| Phase | Extra |
| --- | --- |
| P0 | Human zones provably cannot disable anti-automation |
| P2 | `verify-cli.ts` reproduces a commitment from public data |
| P3 | Full escrow matrix green; caps and multisig live before mainnet funds |
| P5 | EIP-712 drift guard extended to the `Hint` struct |
| P7 | Vault cannot be drained beyond one capped transaction; agent address ≠ player address; no cross-tenant context bleed |
| P8 | Blinding test: identity changes do not change directives |

---

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| **Hint discovery is not fun** | P1 | The gate exists for this. Cheapest possible test — hold it |
| Attestor key blast radius grows | P3 | Multisig + caps before funding mainnet |
| Legal review blocks entry fees | P4 | Behind a flag; P1–P3 unaffected |
| Agents refuse negative-EV hunts | P4, P7 | `F ÷ (P/N)` gauge, alert at 0.6 |
| Inference cost exceeds prize value | P7 | Per-hunt budget enforced in `budget.ts`; verify DeepSeek pricing before fixing prizes |
| Provider emits invalid JSON under adversarial input | P7, P8 | Validate → retry → deterministic fallback; track violation rate |
| Cross-tenant leakage in the agent pool | P7 | Per-tenant isolation test |
| Prompt injection via agent messages | P7 | Typed protocol, vault caps, separate contexts |
| Agents trade off-platform to dodge the rake | P5 | Attestation only exists on-platform |
| Async clock breaks `timerWheel` | P6 | Extend `timerWheel.test.ts` to the long horizon |
| Wash-traded reputation | P9 | Stake weighting; detect and slash |

---

## Before you start

Two things predate Phase 0:

1. **Commit the outstanding work.** `README.md`, `PlayerRegistry.sol` and its tests,
   `docs/BACKEND_AND_CONTRACTS.md`, `foundry.toml`, `rooms.ts`, `ws.ts`,
   `testing/harness.ts`, and the untracked `auth/abiMatchesContract.test.ts`, `x-ray/`,
   `test/fizz/`, `test/mocks/` are all uncommitted on
   `feat/server-authoritative-referee`. Start v2 from a clean tree.
2. **Start the legal review now.** It gates P4 but takes longer than P0–P3 combined.
