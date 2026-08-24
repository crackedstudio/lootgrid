# LOOTGRID — Celo mainnet (42220)

Deployed 2026-08-22. All seven verified to hold code on-chain.

**Token: Tether USD (USD₮)** `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` — **6 decimals**

## Addresses

| # | Contract | Address | Server env var |
|---|---|---|---|
| 1 | PlayerRegistry (**proxy — use this**) | `0xe0dCcC4D8C06C9f7F370C8E4ab94BD9b4bc29E0D` | `PLAYER_REGISTRY_ADDRESS` |
| 1 | └ implementation (verification only) | `0x5E9a1e8fCd272f1C456b067903a4baE84b63190D` | — |
| 2 | AgentVaultFactory | `0xC04906F42Fe8E1b1323d3a006675683Cbc02D140` | `AGENT_VAULT_FACTORY_ADDRESS` |
| 3 | LootGridActions | `0x55bC2302324cd3Ebca3ae15dC28abCeC01BAed05` | `LOOTGRID_ACTIONS_ADDRESS` |
| 4 | Treasury | `0x0f78716EC59bCCCdb07c3eb34c604F221FDe3b13` | — |
| 5 | LootGridEscrow | `0xd39C6679B4d2C132B6AD57225BaF716E487268dc` | `LOOTGRID_ESCROW_ADDRESS` |
| 6 | HintEscrow | `0xcD04587bE47e6d6ac92A73a0b3116e9Dac62282F` | `HINT_ESCROW_ADDRESS` |
| 7 | HintBond | `0x283052567DCc4Bb899a5F91BC5371Ec3Dc3A1a31` | `HINT_BOND_ADDRESS` |

Also set on the server: `HINT_TOKEN_ADDRESS` / `AGENT_TOKEN_ADDRESS` =
`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, and **`HINT_TOKEN_DECIMALS=6`**
(the example file ships `18` — wrong for this token).

## Roles

| Role | Address |
|---|---|
| owner (all seven) | `0xe1a0F916e859624D4edbadA23E4382D327EAf626` |
| guardian | `0xe1a0F916e859624D4edbadA23E4382D327EAf626` |
| relayer | `0xf6928F774B993588D76c30c380058Aa0A6c26684` |
| attestor (records + hint vouch) | `0x2321A2a9ACB156380Fa83fb00448d8Ef807CC33F` |
| escrow signer (payouts, releases, slashes) | `0x55c7054fAA788daA98Ec5Ee08e6e00379D07658c` |
| escrow treasury (holds float) | `0xc794BeA50911e5F5A34b4bb33C6fA0933CD07d42` |
| treasury proposer (agent) | `0x7a36fF9AbCa258FE1bad54e5E0b615D0c058A6D1` |

## Limits as deployed (raw units, 6dp)

| | raw | USDT |
|---|---|---|
| escrow per hunt | `2000000` | 2.00 |
| escrow per day | `20000000` | 20.00 |
| escrow challenge window | `86400` | 24 h |
| treasury per proposal | `5000000` | 5.00 |
| treasury per day | `20000000` | 20.00 |
| treasury reserve floor | `0` | 0.00 |
| treasury delay | `172800` | 48 h |
| hint min trade | `10000` | 0.01 |
| hint per trade | `500000` | 0.50 |
| hint rake waiver | `50000` | 0.05 |
| hint rake | `250` bps | 2.5 % |
| hint challenge window | `600` | 10 min |
| bond minimum | `1000000` | 1.00 |
| bond withdraw delay | `604800` | 7 days |

All adjustable post-deploy via `setCaps` / `setLimits` — no redeploy needed.

## Required before the game can take money

1. **`Treasury.setTarget()`** — the allowlist is empty, so the treasury agent can
   currently send funds nowhere. Nothing works until targets are set.
2. **Escrow treasury must `approve()`** `0xd39C…68dc` before the first `fundHunt`.
3. **Fund** the escrow treasury EOA with USD₮, and the relayer with CELO for gas.
4. **Alert on `UpgradeProposed`** from the registry. Upgrade delay is 48 h; that
   window is worthless if nobody is watching.

## Open risks

- **Owner and guardian are the same EOA.** One key compromise takes ownership of
  all seven contracts *and* removes the ability to pause. The guardian exists to
  be a second, independently-held key.
- **No completed security audit.** The 12-agent review was stopped before it
  produced findings. Bundles are staged in `.audit-nEQmNc/`.
- Contracts are **not yet verified on Celoscan** (`CELOSCAN_API_KEY` was empty).
