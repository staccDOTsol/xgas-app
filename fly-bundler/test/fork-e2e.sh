#!/bin/sh
# Local end-to-end test of the xgas-bundler config: anvil fork of chain 466302 -> EntryPoint v0.7 + SimpleAccountFactory
# (compiled from @account-abstraction/contracts 0.7.0) + VerifyingPaymaster sample + Alto helpers -> Alto started
# through ../entrypoint.sh with ../alto.config.json -> two sponsored UserOps (the first deploys the account).
#
#   sh fly-bundler/test/fork-e2e.sh                       VerifyingPaymaster sample (no dependency on contracts/)
#   PAYMASTER=xgasdev sh fly-bundler/test/fork-e2e.sh     contracts/src/aa/XgasDevPaymaster.sol, compiled here
#
# Needs node >= 22, foundry (anvil, forge) and `npm install` in fly-bundler/. Touches nothing outside $WORK and the
# two ports, which must be free. Only processes this script started are stopped on exit.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLER_DIR=$(cd "$HERE/.." && pwd)
FOUNDRY_BIN=${FOUNDRY_BIN:-$HOME/.foundry/bin}
ANVIL=$(command -v anvil || echo "$FOUNDRY_BIN/anvil")
FORGE=$(command -v forge || echo "$FOUNDRY_BIN/forge")
ANVIL_PORT=${ANVIL_PORT:-18545}
BUNDLER_PORT=${BUNDLER_PORT:-14337}
FORK_URL=${FORK_URL:-https://xgas.dev/rpc}
WORK=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/xgas-bundler-e2e.XXXXXX")}
mkdir -p "$WORK"

for p in "$ANVIL_PORT" "$BUNDLER_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is in use; set ANVIL_PORT/BUNDLER_PORT" >&2; exit 1; fi
done
[ -d "$BUNDLER_DIR/node_modules/@pimlico/alto" ] || { echo "run npm install in $BUNDLER_DIR first" >&2; exit 1; }

ANVIL_PID=""; ALTO_PID=""
cleanup() {
  [ -z "$ALTO_PID" ] || kill "$ALTO_PID" 2>/dev/null || true
  [ -z "$ANVIL_PID" ] || kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== work dir $WORK"

# 1. EntryPoint v0.7 + SimpleAccountFactory v0.7 + VerifyingPaymaster v0.7 from the published package, unmodified
AA="$WORK/aa"
if [ ! -f "$AA/out/EntryPoint.sol/EntryPoint.json" ]; then
  echo "== compiling @account-abstraction/contracts@0.7.0"
  mkdir -p "$AA/src"
  [ -f "$AA/package.json" ] || (cd "$AA" && npm init -y >/dev/null)
  (cd "$AA" && npm install --no-audit --no-fund --silent @account-abstraction/contracts@0.7.0 @openzeppelin/contracts@5.0.2)
  cat > "$AA/foundry.toml" <<'EOF'
[profile.default]
src = "src"
out = "out"
libs = ["node_modules"]
solc = "0.8.23"
optimizer = true
optimizer_runs = 1000000
via_ir = true
evm_version = "paris"
remappings = [
  "@account-abstraction/contracts/=node_modules/@account-abstraction/contracts/",
  "@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/"
]
EOF
  cat > "$AA/src/Imports.sol" <<'EOF'
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;
import "@account-abstraction/contracts/core/EntryPoint.sol";
import "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import "@account-abstraction/contracts/samples/VerifyingPaymaster.sol";
EOF
  cp "$HERE/NodeInterfaceMock.sol" "$AA/src/"
  (cd "$AA" && "$FORGE" build --quiet)
fi

# 1b. optional: the real XgasDevPaymaster (solc 0.8.26), compiled against the same package in its own dir
PAYMASTER=${PAYMASTER:-verifying}
XGASDEV_OUT=""
if [ "$PAYMASTER" = "xgasdev" ]; then
  PM="$WORK/aa-xgasdev"
  mkdir -p "$PM/src"
  ln -sfn "$AA/node_modules" "$PM/node_modules"
  sed -e 's/^solc = .*/solc = "0.8.26"/' -e 's/^evm_version = .*/evm_version = "cancun"/' -e 's/^optimizer_runs = .*/optimizer_runs = 200/' "$AA/foundry.toml" > "$PM/foundry.toml"
  cp "$BUNDLER_DIR/../contracts/src/aa/XgasDevPaymaster.sol" "$PM/src/"
  echo "== compiling XgasDevPaymaster"
  (cd "$PM" && "$FORGE" build --quiet)
  XGASDEV_OUT="$PM/out"
fi
export PAYMASTER XGASDEV_OUT

# 2. anvil fork of the live L4
echo "== anvil --fork-url $FORK_URL --chain-id 466302 on :$ANVIL_PORT"
"$ANVIL" --fork-url "$FORK_URL" --chain-id 466302 --host 127.0.0.1 --port "$ANVIL_PORT" > "$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
FORK_RPC="http://127.0.0.1:$ANVIL_PORT"
i=0; until curl -s -m 2 "$FORK_RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x71d7e; do
  i=$((i+1)); [ $i -lt 60 ] || { echo "anvil did not start"; cat "$WORK/anvil.log"; exit 1; }; sleep 0.5
done

# 3. contracts + Alto helpers + bundler keys on the fork
STATE="$WORK/fork-state.json"
AA_OUT="$AA/out" STATE="$STATE" FORK_RPC="$FORK_RPC" node "$HERE/fork-e2e.mjs" deploy
val() { node -e "console.log(require(process.argv[1])[process.argv[2]])" "$STATE" "$1"; }

# 4. Alto, started exactly as the Fly image starts it
echo "== alto on :$BUNDLER_PORT (log $WORK/alto.log)"
RPC_URL="$FORK_RPC" ENTRYPOINTS=$(val entryPoint) EXECUTOR_PRIVATE_KEYS=$(val executorKey) UTILITY_PRIVATE_KEY=$(val utilityKey) \
PIMLICO_SIMULATION_CONTRACT=$(val pimlicoSimulationContract) ENTRYPOINT_SIMULATION_CONTRACT_V7=$(val entrypointSimulationContractV7) \
PORT="$BUNDLER_PORT" sh "$BUNDLER_DIR/entrypoint.sh" > "$WORK/alto.log" 2>&1 &
ALTO_PID=$!
i=0; until curl -s -m 2 "http://127.0.0.1:$BUNDLER_PORT/health" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -lt 60 ] || { echo "alto did not start"; cat "$WORK/alto.log"; exit 1; }; sleep 0.5
done

# 5. two sponsored UserOps through the bundler
AA_OUT="$AA/out" STATE="$STATE" FORK_RPC="$FORK_RPC" BUNDLER_URL="http://127.0.0.1:$BUNDLER_PORT" node "$HERE/fork-e2e.mjs" send | tee "$WORK/result.json"
echo "== PASS (artifacts in $WORK)"
