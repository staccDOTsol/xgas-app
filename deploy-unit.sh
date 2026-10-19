#!/usr/bin/env bash
# Deploy one sovereign unit from a config file.
#
#   ./deploy-unit.sh config/units/xmoney-plasma.json
#
# The gas token of the new chain is the unit in that file. This is not the
# XPL-native Plasma broadcast. That broadcast is ./deploy-plasma-mainnet.sh
# and then ./seed-plasma-usdt0.sh, and it does not read this config.
#
# Fork proof (no mainnet transaction):
#
#   PLASMA_FORK_URL=http://127.0.0.1:8545 ./deploy-unit.sh config/units/xmoney-plasma.json
#
# A real broadcast sets DEPLOYER_KEY (or PLASMA_DEPLOYER_KEY on Plasma).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${1:?usage: ./deploy-unit.sh config/units/<unit>.json}"
if [[ "$CONFIG" != /* ]]; then
  CONFIG="$ROOT/$CONFIG"
fi
[[ -f "$CONFIG" ]] || { echo "missing $CONFIG" >&2; exit 1; }

export PLASMA_ETHERSCAN_API_KEY="${PLASMA_ETHERSCAN_API_KEY-}"

eval "$(python3 - "$CONFIG" <<'PY'
import json, sys
u = json.load(open(sys.argv[1]))
chain = u["chain"]
if u["peg"]["quote"] != "USD" or u["peg"]["wholeUnitEquals"] != 1 or u["peg"]["backing"] != "full":
    raise SystemExit("peg must be 1 unit = 1 USD, fully backed")
if chain["gasToken"] != "unit":
    raise SystemExit("gasToken must be \"unit\"")
fees = u["feesBps"]
if fees["transferBurn"] != 1 or fees["entryBurn"] != 1 or fees["reserveRake"] != 1:
    raise SystemExit("fees are fixed at 1 bp")
cfg = {
    "chainId": chain["chainId"],
    "arbitrum": {
        "EnableArbOS": True,
        "DataAvailabilityCommittee": chain["dataAvailabilityCommittee"],
        "InitialArbOSVersion": chain["initialArbOSVersion"],
        "InitialChainOwner": "0x0000000000000000000000000000000000000000",
    },
}
def exp(name, value):
    print(f"export {name}={json.dumps(str(value))}")
exp("UNIT_ID", u["id"])
exp("UNIT_CONFIG", sys.argv[1])
exp("PARENT_CHAIN_ID", chain["parentChainId"])
exp("PARENT_RPC", chain["parentRpc"])
exp("CHILD_CHAIN_ID", chain["chainId"])
exp("CHAIN_NAME", chain["chainName"])
exp("STAKE_TOKEN", chain["stakeToken"])
exp("WASM_MODULE_ROOT", chain["wasmModuleRoot"])
exp("CONFIRM_PERIOD_BLOCKS", chain["confirmPeriodBlocks"])
exp("CHAIN_CONFIG", json.dumps(cfg, separators=(",", ":")))
PY
)"

DEPLOYER="${PLASMA_DEPLOYER:-0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158}"
FORK_URL="${UNIT_FORK_URL:-${PLASMA_FORK_URL:-}}"
GAS_ARGS=()
if [[ -n "$FORK_URL" ]]; then
  RPC="$FORK_URL"
  AUTH=(--sender "$DEPLOYER" --unlocked)
  GAS_ARGS=(--with-gas-price "${GAS_PRICE_WEI:-1000000}")
  echo "fork unit $UNIT_ID to $RPC as $DEPLOYER (no mainnet key)"
else
  KEY="${DEPLOYER_KEY:-${PLASMA_DEPLOYER_KEY:-}}"
  : "${KEY:?set DEPLOYER_KEY}"
  RPC="${UNIT_RPC:-$PARENT_RPC}"
  AUTH=(--private-key "$KEY")
  DEPLOYER="$(cast wallet address --private-key "$KEY")"
  if [[ -n "${GAS_PRICE_WEI:-}" ]]; then
    GAS_ARGS=(--with-gas-price "$GAS_PRICE_WEI")
  fi
  echo "MAINNET unit $UNIT_ID to $RPC as $DEPLOYER"
fi

export DEPLOYER
export ROLLUP_OWNER="${ROLLUP_OWNER:-$DEPLOYER}"
export VALIDATOR="${VALIDATOR:-$DEPLOYER}"
export BATCH_POSTER="${BATCH_POSTER:-$DEPLOYER}"
export BATCH_POSTER_MANAGER="${BATCH_POSTER_MANAGER:-$DEPLOYER}"
export LOSER_STAKE_ESCROW="${LOSER_STAKE_ESCROW:-$DEPLOYER}"
export OWNER="${OWNER:-$DEPLOYER}"
export KEEPER="${KEEPER:-$DEPLOYER}"
export FANOUT_TREASURY="${FANOUT_TREASURY:-$DEPLOYER}"

mkdir -p "$ROOT/contracts/deployments" "$ROOT/contracts/orbit/deployments" "$ROOT/deployments/units"

if [[ -n "$FORK_URL" ]]; then
  cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$RPC" >/dev/null
fi

(
  cd "$ROOT/contracts"
  forge script script/DeployUnit.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

VAULT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["vault"])' "$ROOT/contracts/deployments/$UNIT_ID.json")"
TIMELOCK="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["timelock"])' "$ROOT/contracts/deployments/$UNIT_ID.json")"
export NATIVE_TOKEN="$VAULT"
export TIMELOCK
echo "gas token $NATIVE_TOKEN"

(
  cd "$ROOT/contracts/orbit"
  forge script script/DeployUnitChain.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

INBOX="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["inbox"])' "$ROOT/contracts/orbit/deployments/$UNIT_ID-rollup.json")"
BRIDGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bridge"])' "$ROOT/contracts/orbit/deployments/$UNIT_ID-rollup.json")"
export VAULT INBOX BRIDGE

(
  cd "$ROOT/contracts"
  forge script script/WireUnitBridge.s.sol \
    --rpc-url "$RPC" \
    "${AUTH[@]}" \
    --broadcast \
    --slow \
    "${GAS_ARGS[@]}"
)

REL="${CONFIG#$ROOT/}"
python3 - "$ROOT" "$UNIT_ID" "$REL" "${FORK_URL:+anvil-fork}" <<'PY'
import json, sys
root, unit_id, config, kind = sys.argv[1:]
kind = kind or "broadcast"
unit = json.load(open(f"{root}/contracts/deployments/{unit_id}.json"))
rollup = json.load(open(f"{root}/contracts/orbit/deployments/{unit_id}-rollup.json"))
out = {
    "broadcast": kind,
    "config": config,
    "unit": unit,
    "rollup": rollup,
    "wired": {"vault": unit["vault"], "inbox": rollup["inbox"], "bridge": rollup["bridge"], "timelock": unit["timelock"]},
}
dest = f"{root}/deployments/units/{unit_id}.json"
with open(dest, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(dest)
PY
