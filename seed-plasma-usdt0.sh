#!/usr/bin/env bash
# Bridge the deployer's full 1000.428045 USDT0 from Plasma into the child.
# Run this after ./deploy-plasma-mainnet.sh in the same checkout. It reads
# router, gateway, and inbox from the JSON that deploy just wrote.
# Those addresses are the ones from that broadcast, not the committed
# fork rehearsal.
#
# Mainnet (key is not in this repo):
#
#   export PLASMA_DEPLOYER_KEY=...
#   ./deploy-plasma-mainnet.sh
#   ./seed-plasma-usdt0.sh
#
# Fork proof:
#
#   PLASMA_FORK_URL=http://127.0.0.1:8545 ./seed-plasma-usdt0.sh
#
# This is the parent-chain leg only. The L2 token is credited when the
# sequencer includes the retryable. The child vault deposit is later.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOYER="${PLASMA_DEPLOYER:-0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158}"
export SEED_AMOUNT="${SEED_AMOUNT:-1000428045}"

GAS_ARGS=()
if [[ -n "${PLASMA_FORK_URL:-}" ]]; then
  RPC="$PLASMA_FORK_URL"
  AUTH=(--sender "$DEPLOYER" --unlocked)
  GAS_ARGS=(--with-gas-price "${GAS_PRICE_WEI:-1000000}")
  echo "fork seed to $RPC as $DEPLOYER (no mainnet key)"
else
  : "${PLASMA_DEPLOYER_KEY:?set PLASMA_DEPLOYER_KEY}"
  RPC="${PLASMA_RPC:-https://rpc.plasma.to}"
  AUTH=(--private-key "$PLASMA_DEPLOYER_KEY")
  DEPLOYER="$(cast wallet address --private-key "$PLASMA_DEPLOYER_KEY")"
  if [[ -n "${GAS_PRICE_WEI:-}" ]]; then
    GAS_ARGS=(--with-gas-price "$GAS_PRICE_WEI")
  fi
  echo "MAINNET seed to $RPC as $DEPLOYER"
fi

ROLLUP_JSON="$ROOT/contracts/orbit/deployments/plasma-rollup.json"
if [[ ! -f "$ROLLUP_JSON" ]]; then
  echo "missing $ROLLUP_JSON — run ./deploy-plasma-mainnet.sh first" >&2
  exit 1
fi

eval "$(python3 - "$ROLLUP_JSON" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for key in ("router", "gateway", "inbox"):
    value = data.get(key, "")
    if not value or int(value, 16) == 0:
        raise SystemExit(f"{key} is unset in {sys.argv[1]}")
    print(f'export {key.upper()}={value}')
print(f'echo "router {data["router"]}"')
print(f'echo "gateway {data["gateway"]}"')
print(f'echo "inbox {data["inbox"]}"')
PY
)"

export DEPLOYER ROUTER GATEWAY INBOX
export L2_RECIPIENT="${L2_RECIPIENT:-$DEPLOYER}"

if [[ -n "${PLASMA_FORK_URL:-}" ]]; then
  cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$RPC" >/dev/null
fi

USDT0="${USDT0:-0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb}"
before="$(cast balance "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
usdt0_before="$(cast call "$USDT0" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
echo "xpl before wei $before"
echo "usdt0 before $usdt0_before"
echo "seed amount $SEED_AMOUNT"

(
  cd "$ROOT/contracts/orbit"
  forge script script/SeedPlasmaUsdt0.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

after="$(cast balance "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
usdt0_after="$(cast call "$USDT0" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
gateway_bal="$(cast call "$USDT0" "balanceOf(address)(uint256)" "$GATEWAY" --rpc-url "$RPC" | awk '{print $1}')"
echo "xpl after wei $after"
echo "usdt0 after $usdt0_after"
echo "gateway usdt0 $gateway_bal"

python3 - "$ROOT" "$before" "$after" "$usdt0_before" "$usdt0_after" "$gateway_bal" "$DEPLOYER" "${PLASMA_FORK_URL:+anvil-fork}" <<'PY'
import json, sys
root, before, after, usdt_before, usdt_after, gateway_bal, deployer, kind = sys.argv[1:]
before, after = int(before), int(after)
usdt_before, usdt_after, gateway_bal = int(usdt_before), int(usdt_after), int(gateway_bal)
kind = kind or "broadcast"
path = f"{root}/contracts/orbit/broadcast/SeedPlasmaUsdt0.s.sol/9745/run-latest.json"
data = json.load(open(path))
rows = []
gas = 0
for tx, rcpt in zip(data["transactions"], data["receipts"]):
    used = int(rcpt["gasUsed"], 16)
    status = int(rcpt.get("status", "0x1"), 16)
    if status != 1:
        raise SystemExit(f"reverted seed tx {rcpt.get('transactionHash')}")
    if used > 36_000_000:
        raise SystemExit(f"seed tx over Plasma 36M gas: {used}")
    gas += used
    rows.append({
        "contract": tx.get("contractName"),
        "function": tx.get("function"),
        "gasUsed": used,
        "hash": rcpt.get("transactionHash"),
        "value": tx.get("transaction", {}).get("value") or tx.get("value"),
    })
seed = json.load(open(f"{root}/contracts/orbit/deployments/plasma-seed.json"))
moved = usdt_before - usdt_after
if moved != int(seed["amount"]):
    raise SystemExit(f"deployer USDT0 delta {moved} != seed amount {seed['amount']}")
if gateway_bal < int(seed["amount"]):
    raise SystemExit(f"gateway holds {gateway_bal}, seed was {seed['amount']}")
locked = int(seed["retryableValueWei"])
out = {
    "broadcast": kind,
    "deployer": deployer,
    "xplBeforeWei": str(before),
    "xplAfterWei": str(after),
    "xplSpentWei": str(before - after),
    "retryableValueWei": str(locked),
    "xplGasWei": str(before - after - locked),
    "usdt0Before": str(usdt_before),
    "usdt0After": str(usdt_after),
    "usdt0Escrowed": str(moved),
    "gatewayUsdt0": str(gateway_bal),
    "gas": {"total": gas, "xplAtPoint001GweiWei": str(gas * 1_000_000), "maxTxGas": max(r["gasUsed"] for r in rows)},
    "seed": seed,
    "transactions": rows,
}
dest = f"{root}/deployments/plasma-seed.json"
with open(dest, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(dest)
print("seed gas", gas)
print("xpl spent wei", before - after)
print("usdt0 escrowed", moved)
PY
