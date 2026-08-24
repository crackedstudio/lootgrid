#!/usr/bin/env bash
# Fills SECTION 2 of .env from the private keys you pasted into SECTION 1.
# Run from contracts/:   bash script/derive-env.sh
#
# Never prints a full private key — only the last 4 chars, so you can tell two
# keys apart in the output without the terminal scrollback becoming a wallet.
set -uo pipefail
[ -f .env ] || { echo "no .env — run: cp .env.mainnet .env"; exit 1; }
command -v cast >/dev/null || { echo "cast not found (foundryup)"; exit 1; }

# KEY_VAR:ADDR_VAR:label
PAIRS="RELAYER_KEY:RELAYER_ADDR:relayer
ATTESTOR_KEY:ATTESTOR_ADDR:attestor
ESCROW_SIGNER_KEY:ESCROW_SIGNER_ADDR:escrow signer
ESCROW_TREASURY_KEY:ESCROW_TREASURY_ADDR:escrow treasury
TREASURY_PROPOSER_KEY:PROPOSER_ADDR:treasury proposer"

set -a; . ./.env; set +a
fail=0; seen=""

derive(){ cast wallet address --private-key "$1" 2>/dev/null; }
tail4(){ printf '…%s' "$(printf '%s' "$1" | tail -c 4)"; }

echo "── deriving addresses ──"
printf '%s\n' "$PAIRS" | while IFS=: read -r kv av label; do
  key=$(eval printf '%s' "\"\${$kv:-}\"")
  if [ -z "$key" ]; then printf '  \033[31mMISSING\033[0m %-18s %s is empty\n' "$label" "$kv"; continue; fi
  addr=$(derive "$key")
  if [ -z "$addr" ]; then printf '  \033[31mBAD KEY\033[0m %-18s %s is not a valid private key\n' "$label" "$kv"; continue; fi
  # rewrite the ADDR line in place
  if command -v python3 >/dev/null; then
    python3 - "$av" "$addr" <<'PY'
import re,sys
v,a=sys.argv[1],sys.argv[2]
s=open('.env').read()
s2=re.sub(r'^%s=.*$'%re.escape(v), '%s=%s'%(v,a), s, count=1, flags=re.M)
open('.env','w').write(s2)
PY
  fi
  printf '  \033[32mOK\033[0m      %-18s %s  (key %s)\n' "$label" "$addr" "$(tail4 "$key")"
done

echo
echo "── deployer ──"
if [ -n "${DEPLOYER_KEY:-}" ]; then
  d=$(derive "$DEPLOYER_KEY")
  if [ -n "$d" ]; then
    bal=$(cast balance "$d" --rpc-url "${CELO_RPC_URL:-https://forno.celo.org}" 2>/dev/null)
    printf '  %s\n  balance: %s wei\n' "$d" "${bal:-unknown}"
    [ "${bal:-0}" = "0" ] && printf '  \033[31mUNFUNDED — deployment will fail\033[0m\n'
  else printf '  \033[31mDEPLOYER_KEY is not a valid private key\033[0m\n'; fi
else printf '  \033[31mDEPLOYER_KEY is empty\033[0m\n'; fi

echo
echo "── all six keys must be distinct ──"
dups=$(for v in DEPLOYER_KEY RELAYER_KEY ATTESTOR_KEY ESCROW_SIGNER_KEY ESCROW_TREASURY_KEY TREASURY_PROPOSER_KEY; do
  k=$(eval printf '%s' "\"\${$v:-}\""); [ -n "$k" ] && printf '%s\n' "$(printf '%s' "$k" | tr 'A-Z' 'a-z')"
done | sort | uniq -d | wc -l | tr -d ' ')
if [ "$dups" = "0" ]; then printf '  \033[32mPASS\033[0m  no key is reused\n'
else printf '  \033[31mFAIL\033[0m  %s key(s) reused — the deploy scripts will revert\n' "$dups"; fi

echo
echo "Next:  bash script/preflight.sh"
