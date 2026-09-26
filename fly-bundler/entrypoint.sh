#!/bin/sh
# Starts Alto for the xGas L4 (chain 466302).
# Non-secret settings live in alto.config.json. Addresses and keys come from the environment:
#   RPC_URL                           L4 node JSON-RPC (default: Fly private network to the xgas-l4 Nitro node)
#   ENTRYPOINTS                       EntryPoint v0.7 address(es), comma separated (required)
#   EXECUTOR_PRIVATE_KEYS             Fly secret, comma separated, each key needs a little xMoney (required)
#   UTILITY_PRIVATE_KEY               Fly secret, refills the executors and is the bundle beneficiary (required)
#   PIMLICO_SIMULATION_CONTRACT       from scripts/deploy-simulations.mjs (required, no CREATE2 deployer on 466302)
#   ENTRYPOINT_SIMULATION_CONTRACT_V7 from scripts/deploy-simulations.mjs (required)
#   SEND_TRANSACTION_RPC_URL          optional, where bundles are submitted (defaults to RPC_URL)
#   MIN_EXECUTOR_BALANCE              optional, wei, overrides alto.config.json
# Any ALTO_<FLAG_NAME> variable is also read by Alto directly and wins over the mapping below.
set -eu

: "${RPC_URL:=http://xgas-l4.internal:8449}"
: "${ALTO_RPC_URL:=$RPC_URL}"
: "${ALTO_ENTRYPOINTS:=${ENTRYPOINTS:-}}"
: "${ALTO_EXECUTOR_PRIVATE_KEYS:=${EXECUTOR_PRIVATE_KEYS:-}}"
: "${ALTO_UTILITY_PRIVATE_KEY:=${UTILITY_PRIVATE_KEY:-}}"
: "${ALTO_PIMLICO_SIMULATION_CONTRACT:=${PIMLICO_SIMULATION_CONTRACT:-}}"
: "${ALTO_ENTRYPOINT_SIMULATION_CONTRACT_V7:=${ENTRYPOINT_SIMULATION_CONTRACT_V7:-}}"

missing=""
[ -n "$ALTO_ENTRYPOINTS" ] || missing="$missing ENTRYPOINTS"
[ -n "$ALTO_EXECUTOR_PRIVATE_KEYS" ] || missing="$missing EXECUTOR_PRIVATE_KEYS"
[ -n "$ALTO_UTILITY_PRIVATE_KEY" ] || missing="$missing UTILITY_PRIVATE_KEY"
[ -n "$ALTO_PIMLICO_SIMULATION_CONTRACT" ] || missing="$missing PIMLICO_SIMULATION_CONTRACT"
[ -n "$ALTO_ENTRYPOINT_SIMULATION_CONTRACT_V7" ] || missing="$missing ENTRYPOINT_SIMULATION_CONTRACT_V7"
if [ -n "$missing" ]; then
  echo "xgas-bundler: missing required env:$missing (see fly-bundler/README.md)" >&2
  exit 1
fi

# Refuse to bundle for the wrong chain: a stale RPC_URL would burn executor gas on another network.
EXPECTED_CHAIN_ID="${EXPECTED_CHAIN_ID:-466302}"
got=$(node -e '
  fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
    .then(r => r.json()).then(j => console.log(parseInt(j.result, 16))).catch(e => { console.error(e.message); console.log(0) })
' "$ALTO_RPC_URL")
if [ "$got" != "$EXPECTED_CHAIN_ID" ]; then
  echo "xgas-bundler: RPC $ALTO_RPC_URL reports chain $got, expected $EXPECTED_CHAIN_ID; refusing to start" >&2
  exit 1
fi

export ALTO_RPC_URL ALTO_ENTRYPOINTS ALTO_EXECUTOR_PRIVATE_KEYS ALTO_UTILITY_PRIVATE_KEY \
  ALTO_PIMLICO_SIMULATION_CONTRACT ALTO_ENTRYPOINT_SIMULATION_CONTRACT_V7
[ -z "${SEND_TRANSACTION_RPC_URL:-}" ] || export ALTO_SEND_TRANSACTION_RPC_URL="${ALTO_SEND_TRANSACTION_RPC_URL:-$SEND_TRANSACTION_RPC_URL}"
[ -z "${MIN_EXECUTOR_BALANCE:-}" ] || export ALTO_MIN_EXECUTOR_BALANCE="${ALTO_MIN_EXECUTOR_BALANCE:-$MIN_EXECUTOR_BALANCE}"
[ -z "${PORT:-}" ] || export ALTO_PORT="${ALTO_PORT:-$PORT}"

DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$DIR/node_modules/@pimlico/alto/esm/cli/alto.js" run --config "${ALTO_CONFIG:-$DIR/alto.config.json}" "$@"
