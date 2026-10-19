#!/usr/bin/env bash
# Plasma mainnet broadcast: XPL-native Orbit rollup, USDT0 + USDC token
# gateway, and the xMoney vault (USDT0 and Circle USDC as reserves).
#
# Real broadcast (uses the funded deployer key, which is not in this repo):
#
#   export PLASMA_DEPLOYER_KEY=...
#   export WASM_MODULE_ROOT=0x...   # must match the nitro-node image
#   ./deploy-plasma-mainnet.sh
#
# That runs, twice:
#   forge script ... --rpc-url https://rpc.plasma.to \
#     --private-key "$PLASMA_DEPLOYER_KEY" --broadcast --slow
#
# Fork proof (no mainnet transaction). Point PLASMA_FORK_URL at an anvil
# fork, fund 0x26E8...5158 with exactly 47 XPL, and leave the key unset:
#
#   PLASMA_FORK_URL=http://127.0.0.1:8545 WASM_MODULE_ROOT=0x01 ./deploy-plasma-mainnet.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOYER="${PLASMA_DEPLOYER:-0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158}"
: "${WASM_MODULE_ROOT:?set WASM_MODULE_ROOT to the nitro-node machine root before broadcasting}"

GAS_ARGS=()
if [[ -n "${PLASMA_FORK_URL:-}" ]]; then
  RPC="$PLASMA_FORK_URL"
  AUTH=(--sender "$DEPLOYER" --unlocked)
  # Prove the budget at the price Jarett quoted (0.001 gwei = 1_000_000 wei).
  GAS_ARGS=(--with-gas-price "${GAS_PRICE_WEI:-1000000}")
  echo "fork broadcast to $RPC as $DEPLOYER (no mainnet key)"
else
  : "${PLASMA_DEPLOYER_KEY:?set PLASMA_DEPLOYER_KEY}"
  RPC="${PLASMA_RPC:-https://rpc.plasma.to}"
  AUTH=(--private-key "$PLASMA_DEPLOYER_KEY")
  DEPLOYER="$(cast wallet address --private-key "$PLASMA_DEPLOYER_KEY")"
  if [[ -n "${GAS_PRICE_WEI:-}" ]]; then
    GAS_ARGS=(--with-gas-price "$GAS_PRICE_WEI")
  fi
  echo "MAINNET broadcast to $RPC as $DEPLOYER"
fi

export DEPLOYER WASM_MODULE_ROOT
export ROLLUP_OWNER="${ROLLUP_OWNER:-$DEPLOYER}"
export VALIDATOR="${VALIDATOR:-$DEPLOYER}"
export BATCH_POSTER="${BATCH_POSTER:-$DEPLOYER}"
export BATCH_POSTER_MANAGER="${BATCH_POSTER_MANAGER:-$DEPLOYER}"
export LOSER_STAKE_ESCROW="${LOSER_STAKE_ESCROW:-$DEPLOYER}"
export CHILD_DEPLOYER="${CHILD_DEPLOYER:-$DEPLOYER}"
export OWNER="${OWNER:-$DEPLOYER}"
export KEEPER="${KEEPER:-$DEPLOYER}"
export FANOUT_TREASURY="${FANOUT_TREASURY:-$DEPLOYER}"

mkdir -p "$ROOT/contracts/orbit/deployments" "$ROOT/contracts/deployments" "$ROOT/deployments"

if [[ -n "${PLASMA_FORK_URL:-}" ]]; then
  cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$RPC" >/dev/null
fi

before="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
echo "balance before wei $before"

(
  cd "$ROOT/contracts/orbit"
  forge script script/DeployPlasmaMainnet.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

(
  cd "$ROOT/contracts"
  forge script script/DeployPlasmaMainnet.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

after="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
echo "balance after wei $after"

python3 - "$ROOT" "$before" "$after" "$DEPLOYER" <<'PY'
import json, sys
root, before, after, deployer = sys.argv[1:]
before, after = int(before), int(after)
spent = before - after

def load(path):
    with open(path) as f:
        data = json.load(f)
    rows = []
    gas = 0
    for tx, rcpt in zip(data["transactions"], data["receipts"]):
        used = int(rcpt["gasUsed"], 16)
        status = int(rcpt.get("status", "0x1"), 16)
        if status != 1:
            raise SystemExit(f"reverted tx in {path}: {rcpt.get('transactionHash')}")
        if used > 36_000_000:
            raise SystemExit(f"tx over Plasma 36M gas: {tx.get('contractName')} {used}")
        gas += used
        rows.append({
            "contract": tx.get("contractName"),
            "type": tx.get("transactionType"),
            "function": tx.get("function"),
            "gasUsed": used,
            "hash": rcpt.get("transactionHash"),
        })
    return gas, rows

roll_gas, roll_rows = load(f"{root}/contracts/orbit/broadcast/DeployPlasmaMainnet.s.sol/9745/run-latest.json")
vault_gas, vault_rows = load(f"{root}/contracts/broadcast/DeployPlasmaMainnet.s.sol/9745/run-latest.json")
total = roll_gas + vault_gas
# 0.001 gwei = 1_000_000 wei. Also report what the fork actually charged.
at_milli_gwei = total * 1_000_000
rollup = json.load(open(f"{root}/contracts/orbit/deployments/plasma-rollup.json"))
vault = json.load(open(f"{root}/contracts/deployments/plasma-vault.json"))
out = {
    "broadcast": "anvil-fork" if before == 47 * 10**18 else "broadcast",
    "deployer": deployer,
    "balanceBeforeWei": str(before),
    "balanceAfterWei": str(after),
    "xplSpentWei": str(spent),
    "gas": {
        "rollupAndBridge": roll_gas,
        "vault": vault_gas,
        "total": total,
        "xplAtPoint001GweiWei": str(at_milli_gwei),
        "maxTxGas": max(r["gasUsed"] for r in roll_rows + vault_rows),
        "plasmaBlockGasLimit": 36_000_000,
    },
    "rollup": rollup,
    "vault": vault,
    "transactions": {"rollupAndBridge": roll_rows, "vault": vault_rows},
}
path = f"{root}/deployments/plasma-mainnet.json"
with open(path, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(path)
print("total gas", total)
print("xpl spent wei", spent)
print("xpl at 0.001 gwei wei", at_milli_gwei)
print("max tx gas", out["gas"]["maxTxGas"])
if spent > 47 * 10**18:
    raise SystemExit("spent more than 47 XPL")
PY
