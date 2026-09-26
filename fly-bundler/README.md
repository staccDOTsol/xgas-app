# xgas-bundler

ERC-4337 bundler for the xGas L4 (Arbitrum Orbit, chain 466302, gas token xMoney), so UserOps sponsored by
`XgasDevPaymaster` can land on chain. It runs [Pimlico Alto](https://github.com/pimlicolabs/alto) 0.0.21 from npm, pinned
in `package-lock.json`, as the Fly app `xgas-bundler`.

Nothing here is deployed yet.

## Files

| file | what |
| --- | --- |
| `Dockerfile` | node 22 slim + `npm ci` of the pinned Alto |
| `fly.toml` | app `xgas-bundler`, one machine, port 4337, `/health` check, non-secret env |
| `alto.config.json` | every non-secret Alto flag (passed as `--config`) |
| `entrypoint.sh` | maps the env below onto `ALTO_*`, refuses to start on a wrong chain id or missing env |
| `scripts/deploy-simulations.mjs` | one-time deploy of Alto's two helper contracts (see "Why") |
| `test/fork-e2e.sh`, `test/fork-e2e.mjs` | local end to end test on an anvil fork of 466302 |
| `test/NodeInterfaceMock.sol` | stands in for Nitro's NodeInterface on the fork |

## Environment

| name | kind | value |
| --- | --- | --- |
| `EXECUTOR_PRIVATE_KEYS` | **secret** | comma separated; the accounts that send `handleOps` |
| `UTILITY_PRIVATE_KEY` | **secret** | tops up the executors from its own xMoney balance |
| `RPC_URL` | env | `http://xgas-l4.internal:8449` (set in fly.toml) |
| `ENTRYPOINTS` | env | EntryPoint v0.7 address from `DeployXgasAA.s.sol` |
| `PIMLICO_SIMULATION_CONTRACT` | env | from `scripts/deploy-simulations.mjs` |
| `ENTRYPOINT_SIMULATION_CONTRACT_V7` | env | from `scripts/deploy-simulations.mjs` |
| `SEND_TRANSACTION_RPC_URL`, `MIN_EXECUTOR_BALANCE`, `EXPECTED_CHAIN_ID` | optional | |

Any `ALTO_<FLAG>` variable (such as `ALTO_LOG_LEVEL=debug`) overrides the config file.

## Deploy

1. Contracts: run `contracts/script/DeployXgasAA.s.sol` (EntryPoint v0.7, SimpleAccountFactory v0.7, XgasDevPaymaster),
   then fund the paymaster's EntryPoint deposit. That is the contracts runbook, not this one.
2. Bundler keys: use fresh keys that serve only the bundler.
   ```sh
   cast wallet new   # executor
   cast wallet new   # utility
   ```
   Send about 0.5 xMoney to the utility address and 0.05 xMoney to the executor on the L4. The executor is refilled
   from utility when it drops below 0.02 xMoney (`min-executor-balance`). The executor also receives each bundle's
   `actualGasCost` from the EntryPoint, so over time it pays for itself out of the paymaster deposit.
3. Alto helper contracts (one time, and again after every Alto upgrade):
   ```sh
   cd fly-bundler && npm ci
   RPC_URL=https://xgas.dev/rpc DEPLOYER_PRIVATE_KEY=<utility key> node scripts/deploy-simulations.mjs
   ```
   This prints `pimlicoSimulationContract` and `entrypointSimulationContractV7`. It costs about 7.6M L2 gas plus the
   L1 data component for about 35 KB of initcode.
4. Fly app, in the same org as `xgas-l4` so `.internal` resolves:
   ```sh
   cd fly-bundler
   fly apps create xgas-bundler
   # put ENTRYPOINTS, PIMLICO_SIMULATION_CONTRACT, ENTRYPOINT_SIMULATION_CONTRACT_V7 in fly.toml [env]
   fly secrets set EXECUTOR_PRIVATE_KEYS=0x... UTILITY_PRIVATE_KEY=0x... -a xgas-bundler
   fly deploy --ha=false
   ```
5. Smoke test:
   ```sh
   curl -s https://xgas-bundler.fly.dev -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}'
   ```
   The expected result is the EntryPoint address. `eth_chainId` should return `0x71d7e`.

## Using it from the site

- Bundler URL: `https://xgas-bundler.fly.dev` (CORS is on). Alternatively the web app can proxy
  `POST /api/bundler/466302` to `http://xgas-bundler.internal:4337` and keep a single origin.
- Take UserOp fees from the bundler's `pimlico_getUserOperationGasPrice` (`.fast`), not from the wallet. On Arbitrum
  the priority fee is never paid to anyone, but the EntryPoint still charges `min(maxFee, baseFee + priorityFee)`. A
  wallet default like 1 gwei of priority fee would make every op cost about 10x the 0.1 gwei base fee. Alto caps
  its own suggestion at 0.001 gwei (`ceiling-max-priority-fee-per-gas`). The paymaster signer should also refuse
  ops whose `maxPriorityFeePerGas` is above a small cap.
- Enabled methods: `eth_chainId`, `eth_supportedEntryPoints`, `eth_estimateUserOperationGas`, `eth_sendUserOperation`,
  `eth_getUserOperationByHash`, `eth_getUserOperationReceipt`, `pimlico_getUserOperationGasPrice`,
  `pimlico_getUserOperationStatus`. Debug methods are off.
- viem 2.56 has no `toSimpleSmartAccount` (that lives in `permissionless`, whose 0.4.1 peer dependency on `ox` ^0.11
  conflicts with viem 2.56). `test/fork-e2e.mjs` has a 40 line SimpleAccount v0.7 built on viem's `toSmartAccount`
  that works with this bundler. It includes the paymaster client for both the sample and `XgasDevPaymaster`.

## Why the config looks like this

- **`chain-type: arbitrum`**: preVerificationGas and the bundle gas limit include the L1 data component from
  NodeInterface (`0x...C8`). On 466302 that component is large right now: ArbGasInfo reports an L1 base fee estimate of
  84 gwei against a 0.1 gwei L2 base fee (the chain is new and the L1 pricer has not adjusted yet). A 1 KB random
  payload estimates at about 17M gas, and a first UserOp (account deploy) needs about 22M preVerificationGas. At
  0.1 gwei that is about 0.0022 xMoney, so it is cheap in money but large in gas units.
- **`max-gas-per-user-op` / `max-gas-per-bundle` = 30M**: Alto measures these without preVerificationGas, so the L1
  component does not count against them. 30M keeps a bundle's execution gas under Nitro's 32M per-block limit.
- **`safe-mode: false`**: the xgas-l4 node does not expose `debug_traceCall` ("the method debug_traceCall does not
  exist"), and Alto's ERC-7562 tracing needs it. Without tracing, a UserOp could pass simulation and then fail
  on chain if its validation depends on state that changes in between, which costs the executor that gas. Alto
  re-simulates every bundle just before sending it, which limits the window to about one block. To turn safe mode on,
  enable the `debug` API on the node and stake the paymaster (`addStake`, the paymaster reads its own storage).
- **`deploy-simulations-contract: false`**: Alto normally deploys its helpers at startup through the CREATE2
  deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which has no code on 466302 (eth_getCode `0x` at block 18,
  2026-09-26). `scripts/deploy-simulations.mjs` deploys the same bytecode from the installed Alto package with a plain
  CREATE instead.
- **`code-override-support: true`**: checked on the node: `eth_call` and `eth_estimateGas` accept state overrides.
- **`floor-max-fee-per-gas: 0.1`**: the Orbit minimum base fee.
- **One machine**: the mempool lives in memory. Horizontal scaling would need Redis (`enable-horizontal-scaling`).

## Local test

```sh
cd fly-bundler && npm install
sh test/fork-e2e.sh                     # VerifyingPaymaster sample from @account-abstraction/contracts 0.7.0
PAYMASTER=xgasdev sh test/fork-e2e.sh   # contracts/src/aa/XgasDevPaymaster.sol
```

The test forks `https://xgas.dev/rpc` with anvil (`--chain-id 466302`) and compiles EntryPoint and
SimpleAccountFactory from `@account-abstraction/contracts@0.7.0` (unmodified; solc 0.8.23, via-IR, 1M runs). It
installs a NodeInterface stand-in calibrated to the live node, deploys the helpers with
`scripts/deploy-simulations.mjs`, and funds fresh bundler keys. It then starts Alto through `entrypoint.sh` with
`alto.config.json` and sends two sponsored UserOps: the first deploys the account, the second runs a batch call. Both
must come back `success=true` from `eth_getUserOperationReceipt`. In xgasdev mode the test also checks the
`XgasDevGasCharged` event (userOpHash, payer, charge cap). Ports default to 18545 and 14337 and must be free. The script
stops only the processes it started.

On the fork, gas costs follow anvil's base fee, which decays below 0.1 gwei on empty blocks. The live chain holds the
base fee at a 0.1 gwei minimum.
