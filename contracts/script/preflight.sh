#!/usr/bin/env bash
# Mainnet preflight. Run from contracts/ with .env in place:  bash script/preflight.sh
# Checks what the deploy scripts cannot: that the addresses you filled in are
# the things you think they are, on the chain you think you are on.
set -uo pipefail
fail=0
ok(){ printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
no(){ printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
lc(){ printf '%s' "$1" | tr 'A-Z' 'a-z'; }   # bash 3.2 on macOS has no ${x,,}
# Token amounts are up to 1e21 and bash integers are 64-bit (max ~9.2e18), so
# `[ 100000000000000000000 -ge ... ]` errors out and silently reads as a FAIL.
# bc is arbitrary-precision and POSIX.
ge(){ [ "$(printf '%s >= %s\n' "$1" "$2" | bc)" = "1" ]; }
[ -f .env ] || { echo "no .env — cp .env.mainnet .env and fill it in"; exit 1; }
set -a; . ./.env; set +a
RPC="${CELO_RPC_URL:?CELO_RPC_URL unset}"

echo "── secrets ──"
nk=$(grep -cE '^[A-Z_]+_KEY=0x[a-fA-F0-9]{64}$' .env || true)
if [ "$nk" -gt 0 ]; then
  printf '  \033[33mWARN\033[0m  %s private key(s) stored in .env (by design here).\n' "$nk"
  printf '        Anyone with read access to this file controls them.\n'
  perm=$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env 2>/dev/null)
  if [ "$perm" = "600" ]; then ok "file mode is 600 (owner-only)"
  else no "file mode is $perm — run: chmod 600 .env"; fi
else ok "no private keys in .env"; fi
if git -C . check-ignore -q .env 2>/dev/null; then ok ".env is gitignored"; else no ".env is NOT gitignored"; fi
if grep -q '^ALLOW_EOA_OWNER=true' .env; then printf '  \033[33mWARN\033[0m  ALLOW_EOA_OWNER=true — owners are EOAs by explicit choice\n'; else ok "no EOA-owner escape hatch"; fi
n=$(grep -cE 'FILL_ME|FILL_AFTER' .env || true)
if [ "$n" -gt 0 ]; then no "$n unfilled placeholders remain"; else ok "no placeholders left"; fi

echo "── chain ──"
id=$(cast chain-id --rpc-url "$RPC" 2>/dev/null | tail -1)
if [ "$id" = "42220" ]; then ok "chain id 42220 (Celo mainnet)"; else no "chain id is '$id', expected 42220"; fi

echo "── token ──"
same=1
for v in ESCROW_TOKEN HINT_TOKEN BOND_TOKEN; do
  [ "$(lc "$(eval echo \$$v)")" = "$(lc "$TREASURY_TOKEN")" ] || { no "$v differs from TREASURY_TOKEN"; same=0; }
done
[ "$same" = 1 ] && ok "all four *_TOKEN vars agree"
dec=$(cast call "$TREASURY_TOKEN" "decimals()(uint8)" --rpc-url "$RPC" 2>/dev/null | tail -1)
sym=$(cast call "$TREASURY_TOKEN" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null | tail -1)
if [ -n "$dec" ]; then ok "token is $sym with $dec decimals"; else no "token has no decimals() — not an ERC20?"; fi
# Sanity-check magnitude against the token's real decimals rather than assuming
# 18: a cap 1e12 too large is not a cap, and a minimum 1e12 too large blocks
# every trade. Both look like ordinary numbers in the file.
unit=$(printf '10^%s\n' "$dec" | bc)
hunt=$(printf '%s / %s\n' "$ESCROW_PER_HUNT_CAP" "$unit" | bc)
bmin=$(printf '%s / %s\n' "$BOND_MIN" "$unit" | bc)
if ge "$hunt" 1 && ge 100000 "$hunt"; then ok "escrow per-hunt cap = $hunt $sym (sane for ${dec}dp)"
else no "escrow per-hunt cap = $hunt $sym — wrong by orders of magnitude for ${dec}dp"; fi
if ge "$bmin" 1 && ge 100000 "$bmin"; then ok "bond minimum = $bmin $sym (sane for ${dec}dp)"
else no "bond minimum = $bmin $sym — no seller could ever post this"; fi

echo "── owners ──"
for v in REGISTRY_OWNER ACTIONS_OWNER ESCROW_OWNER HINT_OWNER BOND_OWNER TREASURY_OWNER; do
  a=$(eval echo \$$v)
  code=$(cast code "$a" --rpc-url "$RPC" 2>/dev/null | tail -1)
  if [ "${#code}" -gt 2 ]; then ok "$v has code (contract)"
  elif grep -q '^ALLOW_EOA_OWNER=true' .env; then printf '  \033[33mWARN\033[0m  %s is an EOA (allowed by ALLOW_EOA_OWNER)\n' "$v"
  else no "$v is an EOA — must be a multisig"; fi
done

echo "── role separation ──"
chk(){ if [ "$(lc "$1")" != "$(lc "$2")" ]; then ok "$3"; else no "$3"; fi; }
chk "$ACTIONS_OWNER"       "$ACTIONS_RELAYER"          "ACTIONS_OWNER != RELAYER"
chk "$ACTIONS_OWNER"       "$ACTIONS_ATTESTOR"         "ACTIONS_OWNER != ATTESTOR"
chk "$ACTIONS_RELAYER"     "$ACTIONS_ATTESTOR"         "ACTIONS_RELAYER != ATTESTOR"
chk "$ESCROW_OWNER"        "$ESCROW_ATTESTOR"          "ESCROW_OWNER != ATTESTOR"
chk "$ESCROW_TREASURY"     "$ESCROW_ATTESTOR"          "ESCROW_TREASURY != ATTESTOR"
chk "$ESCROW_GUARDIAN"     "$ESCROW_ATTESTOR"          "ESCROW_GUARDIAN != ATTESTOR"
chk "$HINT_VOUCH_ATTESTOR" "$HINT_RELEASE_ATTESTOR"    "HINT_VOUCH != HINT_RELEASE"
chk "$HINT_OWNER"          "$HINT_RELEASE_ATTESTOR"    "HINT_OWNER != HINT_RELEASE"
chk "$HINT_GUARDIAN"       "$HINT_RELEASE_ATTESTOR"    "HINT_GUARDIAN != HINT_RELEASE"
chk "$BOND_SLASH_ATTESTOR" "$BOND_OWNER"               "BOND_SLASH != BOND_OWNER"
chk "$BOND_SLASH_ATTESTOR" "$BOND_BENEFICIARY"         "BOND_SLASH != BOND_BENEFICIARY"
chk "$TREASURY_PROPOSER"   "$TREASURY_OWNER"           "TREASURY_PROPOSER != OWNER"
chk "$TREASURY_GUARDIAN"   "$TREASURY_PROPOSER"        "TREASURY_GUARDIAN != PROPOSER"

echo "── caps and windows ──"
if ge "$ESCROW_PER_DAY_CAP" "$ESCROW_PER_HUNT_CAP"; then ok "escrow perDay >= perHunt"; else no "escrow perDay < perHunt"; fi
if ge "$TREASURY_PER_DAY" "$TREASURY_PER_PROPOSAL"; then ok "treasury perDay >= perProposal"; else no "treasury perDay < perProposal"; fi
if [ "$ESCROW_CHALLENGE_WINDOW" -ge 3600 ]; then ok "escrow challenge window >= 1h"; else no "escrow challenge window under an hour"; fi
if [ "$HINT_CHALLENGE_WINDOW" -le 1800 ] && [ "$HINT_CHALLENGE_WINDOW" -gt 0 ]; then ok "hint window 0<w<=30m (it restarts on every credit)"; else no "hint window must be short and non-zero"; fi
if [ "$BOND_WITHDRAW_DELAY" -ge 86400 ]; then ok "bond delay >= 1 day"; else no "bond delay lets sellers exit pre-verdict"; fi
if [ "$TREASURY_DELAY" -gt 0 ]; then ok "treasury delay non-zero"; else no "treasury delay is 0 — no veto window"; fi

echo
if [ "$fail" -eq 0 ]; then printf '\033[32mPREFLIGHT CLEAN — safe to broadcast\033[0m\n'
else printf '\033[31m%s CHECK(S) FAILED — do not broadcast\033[0m\n' "$fail"; fi
exit "$fail"
