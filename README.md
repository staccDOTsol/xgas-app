# xGas

xGas is an Arbitrum Orbit rollup, chain id **466302**, that posts every batch to **Robinhood Chain (4663)**. The project calls this chain the xgas Orbit L4. There is no data-availability committee: a node can rebuild the chain from a Robinhood RPC alone.

**$xMoney** is the native gas token. On Robinhood it is an ERC-20 whose supply is backed by **USDG** in a vault. Bridging in mints $xMoney and opens a retryable to the L4, where it arrives as native gas. Bridging out burns that gas through ArbSys and redeems USDG from the vault.

On top of the rollup this repo runs:

- a **P2P OTC escrow** (`XMoneyEscrow`) that holds native $xMoney. The dollar leg is an X Money payment between X handles. The contract does not see that payment; a person releases the escrow after it.
- **NGU** bonding-curve tokens (`NguLauncher` / `NguToken`). A token's floor is its reserve divided by its supply.
- **XSwap**, which escrows X Money on Robinhood against an asset on another EVM chain. Bonded solvers fill the order. The route the solver network fills today is X Money out to native ETH on Base.
- **ramps**, which are MCP routes that chain the vault bridge and the desk. They are not a separate contract.
- an **XGAS.DEV buyback-and-burn**. L4 fee paths send 0.02% to a sink that withdraws to `XgasDevBuyback` on Robinhood. That contract redeems $xMoney for USDG, swaps USDG → ETH → XGAS.DEV, and burns the XGAS.DEV. `execute` is keeper-only.

The site is [https://xgas.dev](https://xgas.dev). Public L4 RPC: `https://xgas.dev/rpc`. Sequencer: `https://xgas-l4.fly.dev`. Parent RPC named in the deployment file: `https://rpc.mainnet.chain.robinhood.com`.

Chain 466301 (AnyTrust) is retired. Its addresses are under `legacy466301` in the deployment file so old withdrawals can still be claimed. Do not deposit to it.

Operator notes in [`.claude/wiki.md`](.claude/wiki.md) record that Robinhood Chain itself settles to Ethereum, so a strict layer count would call 466302 an L3. The deployment file, the contracts, and the public node docs in this repo use the L4 name. Some wiki entries are marked superseded; prefer the deployment file and the source when they disagree.

This software is alpha. The contracts below are unaudited. Funds can be lost. Use amounts you can afford to lose.

## Custom contracts, not Orbit core

The rollup, inbox, outbox, bridge, sequencer inbox, and challenge contracts are Arbitrum Orbit. Their addresses are the `l3.rollup`, `l3.inbox`, `l3.outbox`, `l3.bridge`, and `l3.sequencerInbox` fields below. They are not the code in `contracts/src`.

The desk, the curves, the router, FOMO, and the vault token are this repo's own contracts. They are separate from Arbitrum's audited Orbit core:

| Contract | Source | Role |
|---|---|---|
| `XMoney` | `contracts/src/XMoney.sol` | USDG vault and parent-chain gas token |
| `XMoneyEscrow` | `contracts/src/XMoneyEscrow.sol` | L4 P2P OTC escrow |
| `NguLauncher`, `NguToken` | `contracts/src/NguLauncher.sol`, `contracts/src/NguToken.sol` | Bonding-curve factory and token |
| `XGasRouter` | `contracts/src/XGasRouter.sol` | L4 native-value router |
| `FomoAttritionL4` | `contracts/src/FomoAttritionL4.sol` | L4 FOMO game, settled in $xMoney |
| `XgasDevBuyback` | `contracts/src/XgasDevBuyback.sol` | Robinhood buyback-and-burn |
| `FanoutSink` | `contracts/src/FanoutSink.sol` | L4 fee sink that withdraws to Robinhood |

Same warning for the rest of `contracts/src`: the Robinhood ETH desk (`RobinhoodEthOtc`), XSwap (`contracts/src/xswap/`), the paymaster (`contracts/src/aa/XgasDevPaymaster.sol`), and the v4 fork under `contracts/src/amm/`.

## Addresses

Every address the app and the MCP use comes from [`src/contracts/l4-deployment.json`](src/contracts/l4-deployment.json). The current L4 desk generation is also in [`src/contracts/fireball-relaunch.json`](src/contracts/fireball-relaunch.json) (`active: true`). The same hex can exist on both chains; an address only means something together with its chain id.

### Rollup on Robinhood Chain (4663)

| | |
|---|---|
| Rollup | `0x5868266C0c0663f4bc39329B525884f137BAD93E` |
| Inbox | `0xa7087693676F2Ca8e5e9563A6859952258688146` |
| Outbox | `0xA6f07dd42CFE78EC8D88484b238b3B05149Eb2b3` |
| Bridge | `0x2290f4505484f055B710e7Df37e2482c90B8B6fb` |
| Sequencer inbox | `0xCA038a032154d0091b019A9104b369F94FD5c75F` |
| Upgrade executor | `0x43E881A831Ec5680aa6f63d2b48913050038b9F9` |
| Chain owner | `0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F` |
| Fast-confirm Safe | `0x17fC7585A3c99ACC2A7CFC1842C119d7FBB12cBC` (2 of 3) |
| Challenge window | `confirmPeriodBlocks` **50400** (Ethereum blocks; see the wiki) |
| Assertion stake | `0.01` WETH (`baseStake` `10000000000000000`, token `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`) |
| Validator whitelist | disabled (`validatorWhitelistDisabled: true`) |

The chain owner key holds `EXECUTOR_ROLE` on the upgrade executor, so it can upgrade the Orbit core and force-confirm. The 24h timelock below owns the vault token, not the rollup.

### Vault, XGAS.DEV, and the Robinhood desks

| | Address | Where it is set |
|---|---|---|
| $xMoney (vault token) | `0xa924C725B64cC346f275269EFA4Bd0538cfBa97E` | `l3.xMoney` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `l3.usdg` |
| Vault fanout (USDG rake) | `0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e` | `l3.fanout` and `XMoney.FANOUT` |
| XMoney timelock | `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B` | `l3.timelock`, min delay 86400s |
| XGAS.DEV | `0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3` | `l3.xgasDev` |
| XgasDevBuyback | `0x6067E608d1e0C4a67d406447FaA42a7C7452f7F8` | `l3.xgasDevBuyback` |
| EarlyDepositor | `0x36e52831ba473e9374bad7cc22ed942a99b4d431` | `l3.earlyDepositor` |
| Robinhood ETH OTC | `0x534df478ea378C1B4A596a10f8d3b5659486a8Cb` | `l3.robinhoodOtc` |
| OTC arbitration | `0x16BCd95b5eB685DfaA04295462564d56979f35b4` | `l3.otcArbitration` |

`EarlyDepositor` was the deposit path while the vault inbox still pointed at chain 466301. The connector reads `vault.inbox()` live and uses `enterRollup` once that inbox is `0xa7087693676F2Ca8e5e9563A6859952258688146`. The wiki records that switch as executed on 2026-10-06.

The Robinhood ETH desk (`/robinhood`) is a different market from the L4 escrow: ETH against X Money dollars, with its own fee and bond (below).

### L4 desk (chain 466302)

`fireball.active` is true, so new orders, keys, and launches go to the Fireball generation. The original `l4.*` contracts stay live for positions already opened there.

| | Fireball (current) | Original `l4.*` |
|---|---|---|
| Escrow | `0xf8Dbd439A994ff913509e68085B2ED3deC94c26A` | `0x842E6904e4eB64d5957CC2E9Eb640A9a8C006754` |
| FOMO | `0xDefE7c5e5B36B964894e931A83768083B040ad62` | `0xa8d88800cf41a2c246fa363f4fa9ee14c1fef151` |
| Router | `0x82334088CB47E95eFaB8D65591157190Ac40e00A` | `0xc4a5869A959Db3cead7E568D368Ce822f52b9a2E` |
| NGU launcher | `0x9e9BC96c318996b4DC147069E1Ed17d828245e53` | `0x6067e608d1e0c4a67d406447faa42a7c7452f7f8` |
| Fanout sink | `0x4ca8826FBb7F69F55B858485313eAC56a1b4F458` | `0xfeb38ce50e1F49438acAa39b2Da513d2F1DE548f` |

Fireball's parent fanout is `0x0a87Da84277232720e0908CC7470e3A7f925748f`. The forwarder in front of it is `0x44a0438e85C3947C369B1B8A7D9991741040A7FF`. The original buyback sink on the L4 is `l4.buybackSink` `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B`.

### XSwap (Robinhood Chain)

New orders use the V2 escrows in `XSWAP_V2` inside [`mcp/src/config.mjs`](mcp/src/config.mjs), not the `xswap` block of the deployment file.

| | |
|---|---|
| Collector | `0x5a5e18e5003d75f9705252b2c3436c1b61e6d33e` |
| Intents (X Money out) | `0xdf6398ff5a694a03d85a614812490143c4e5d238` |
| Asks (X Money in) | `0x2f507a18043002d8f5d6d3022efd6265be7a87fc` |
| Expected owner | `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158` |

The deployment file's `xswap.intents` / `xswap.asks` (`0x5D78651C728c15b715d5f6727bE40C1c3a02B53d`, `0xa999BC26e184b83CECb3cF5b9640C438C5aDc8a3`) are an earlier pair. The connector keeps them for refunds, cancels, and withdrawals of orders already there. The keyless v1 pair (`0xf8B4F14eF9A08e334CA9fc026C6e5E9a79B39a35`, `0x0a33001A28A82d50ECC5c166dd5DCb8f5efaCd13`, owner `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38`) cannot resolve a dispute. Details are in [`mcp/README.md`](mcp/README.md).

### Also in the deployment file

- **Fleet** (`fleet`): staccpad NFT NGU, peg markets, drops, CLMM, and pawn on the L4, plus the JIT-toll PoolManager at `fleet.infra.poolManager` `0xea2ce320b5cdbf14bc734feb60c78097e146f1b0`. Superseded generations are under `fleet.superseded`. The Solidity for those products is not in this repo; this repo has the addresses, the site tabs, and the MCP tools.
- **Account abstraction** (`l4.entryPoint` `0x78546FE8666E4fD4b67C764cdEa7619C6037B870`, `l4.simpleAccountFactory` `0xf13ad263AB0F4Cd007a933B449C1d6Cf80B23195`, `l4.xgasDevPaymaster` `0x3f484cdf443A0bDa9c0993e0d4BA1024B4c1CE64`). Gas on the L4 can be sponsored and charged in XGAS.DEV on Robinhood. See [`server/paymaster/spec.md`](server/paymaster/spec.md).
- **Chain info** served to Nitro: [`public/chain-info.json`](public/chain-info.json) and [`public/chain-info-466302.json`](public/chain-info-466302.json).

## Fees

Numbers below are the constants in the Solidity and in `mcp/src/config.mjs` / `mcp/src/xswapV2.mjs`. `get_fee_schedule` on the MCP reads the same schedule. 1 bp is 0.01%.

| Path | Fee |
|---|---|
| Enter (USDG → $xMoney) | 0.01% USDG to the vault fanout (`FANOUT_RAKE_BPS = 1`) and 0.01% entry burn (`BURN_BPS = 1`). Half of that burn is minted to the bridge as a solvency buffer. |
| $xMoney transfer on Robinhood | 0.01% burn. Transfers into the inbox or bridge are exempt; transfers out of the bridge burn as usual. |
| Exit ($xMoney → USDG) | 0.01% USDG rake, plus the 0.01% transfer tax on the way out of the bridge. |
| L4 escrow release, router send, FOMO key | 0.01% burn + 0.01% fanout + 0.02% XGAS.DEV buyback (`BUYBACK_BPS = 2`). Escrow and router deliver 99.96% to the recipient. |
| FOMO key split | 55% dividends, 35% this round's jackpot, the 4 bp above, and the remaining 9.96% into the next round's jackpot (`5500` / `3500` / `10000` in `FomoAttritionL4`). |
| NGU buy and sell | Same 0.01% + 0.01% + 0.02% on curves from the current launcher. Launch fee is zero. Donate pays none of it. |
| Escrow trade timeout | 15 minutes (`TRADE_TIMEOUT`). |
| Fanout sink flush | at least 0.01 $xMoney (`FanoutSink.MIN_FLUSH`). |
| XSwap V2 | 10 bp site fee of the winning solver ask (`XSWAP_V2_SITE_BPS`), 50 bp protocol fee (`XSWAP_V2_PROTOCOL_BPS`), plus the 1 bp $xMoney transfer burn. Charged from the gross debit, at settlement for the site fee. |
| Robinhood ETH OTC | 0.10% fee (`FEE_BPS = 10`), 5% bond (`BOND_BPS = 500`), minimum bond 0.002 ETH. Pay window 30 minutes, release window 12 hours. |
| v4 JIT toll (L4 PoolManager) | LP add/remove and swaps pay the pool fee plus 10 bp. The n-th reference to a non-native token in one transaction pays `(fee + 10 bp) * n²`, capped at 100%. See [`contracts/src/amm/README.md`](contracts/src/amm/README.md). |

The vault's 0.01% rates are `constant` on `XMoney`. L4 contracts add the 0.02% buyback on top. The buyback contract has no withdraw: what lands there can only leave as a burned XGAS.DEV buy.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | React UI (Vite). Tabs: `/otc`, `/connector`, `/ngu`, `/nft`, `/drops`, `/markets`, `/pawn`, `/robinhood`. |
| `server.js` | Express app: the site, `/mcp`, `/api/*`, X sign-in, paymaster, withdrawal executor, Fireball fee keeper. |
| `server/` | Paymaster, OG cards, approval page, fee keeper. |
| `src/contracts/l4-deployment.json` | Chain ids, RPCs, and contract addresses. |
| `contracts/` | Solidity, Foundry tests, deploy scripts, committed `contracts/l4-artifacts/` and `contracts/l3-artifacts/`. |
| `mcp/` | `xgas-mcp` package (stdio). The hosted server imports `mcp/src`. |
| `fly-rpc/` | Failover JSON-RPC proxy for Robinhood Chain. Fly app `xgas-rpc`. |
| `fly-bundler/` | ERC-4337 bundler (Pimlico Alto) for chain 466302. Fly app `xgas-bundler`. |
| `public/` | Chain info, node and validator docs, terms, privacy. Copied into `dist/` by Vite. |
| `scripts/` | Artifact export, Fireball planning, fleet deploy helpers. |
| `research/` | Notes. Not a build input. |
| `.claude/wiki.md` | Operator wiki. Read the superseded banners before trusting an entry. |
| `Dockerfile`, `fly.toml` | Site image. Fly app `xgas`, port 3000, volume `xgas_data` at `/data`. |

The Nitro sequencer is not in this repo. Its public URL is `https://xgas-l4.fly.dev`. `server.js` uses `http://xgas-l4.internal:8449` when `FLY_APP_NAME` is set.

## Web app and API

Node 20 or newer. The image is `node:20-bookworm-slim`. Install the way the Dockerfile does:

```sh
npm install --legacy-peer-deps
```

| Command | What it runs |
|---|---|
| `npm run dev` | Vite on port 3000 (`vite --port=3000 --host=0.0.0.0`). UI only. |
| `npm run build` | `vite build` → `dist/` |
| `npm run preview` | `vite preview` |
| `npm run lint` | `tsc --noEmit` |
| `npm run artifacts` | `node scripts/export-l4-artifacts.mjs` (needs `contracts/out/` from `forge build`) |
| `node server.js` | API, hosted MCP, and the built site. `PORT` defaults to 3000. Serves `dist/`. |

Host state (session secret, connector-token epochs, paymaster ledger) goes to `/data` when that directory exists, otherwise `l4-data/`. Off Fly, `XGAS_DATA_DIR_DEV` points a test run at a scratch directory.

Deploy from the repo root. `fly.toml` names the app `xgas` and the Dockerfile is the build:

```sh
fly deploy
```

The process is `node server.js`. The `xgas_data` volume must be mounted at `/data`.

## Contracts

`contracts/foundry.toml` uses solc 0.8.26, Cancun, optimizer 200. `forge-std` and OpenZeppelin are **not** in this repo. The remappings point at `/Users/stacc/nft-range/lib`. `@account-abstraction/contracts` is vendored at `contracts/lib/account-abstraction`. A clean clone does not compile until those two libraries are on that path (or the remappings change).

From `contracts/`:

```sh
forge build
forge test
forge test --match-path 'test/amm/*' -vv
forge test --match-contract FireballBridgeFeeForwarderTest
FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract FireballBridgeFeeForwarderForkTest
FORK_L4_URL=https://xgas.dev/rpc forge test --match-contract FireballOrbitL4ForkTest
forge test --match-path test/XSwap.fork.t.sol
```

The fork tests need a Robinhood (and, for the L4 one, an xGas) archive node. The wiki's note on pruned RPCs: `FORK_URL=https://rpc.mainnet.chain.robinhood.com`. After a successful `forge build`, from the repo root:

```sh
npm run artifacts
```

That copies `{abi, bytecode}` for `FanoutSink`, `XMoneyEscrow`, `FomoAttritionL4`, `XGasRouter`, `NguToken`, `NguLauncher`, and `XgasDevBuyback` into `contracts/l4-artifacts/`.

Deploy scripts (broadcast only with a key you control; simulate first). Env vars are what each script reads:

| Script | Chain | Env |
|---|---|---|
| `contracts/script/DeployOrbitL4Fireball.s.sol` | 466302 | `PRIVATE_KEY`, `EXPECTED_DEPLOYER`, `FIREBALL_L4_STEP` (`sink`, then `escrow` / `fomo` / `router` / `ngu`), `FIREBALL_FORWARDER_PARENT`, `BUYBACK_SINK`, `FIREBALL_L4_SINK` |
| `contracts/script/DeployFireballBridgeForwarder.s.sol` | 4663 | `PRIVATE_KEY`, `EXPECTED_DEPLOYER` |
| `contracts/script/DeployOrbitL4.s.sol` | L4 | optional `FANOUT_SINK`, `BUYBACK_SINK`; `XGAS_BUYBACK` if the buyback sink is deployed fresh |
| `contracts/script/DeployXgasDevBuyback.s.sol` | 4663 | `KEEPER` |
| `contracts/script/DeployXSwap.s.sol` | 4663 | `PRIVATE_KEY`, `OWNER` (required; see `mcp/README.md`) |
| `contracts/script/DeployAmm.s.sol` | 466302 | `PRIVATE_KEY`, `AMM_FEE_COLLECTOR`, optional `AMM_OWNER` |
| `contracts/script/DeployXgasAA.s.sol` | 466302 | `PRIVATE_KEY`, `PAYMASTER_SIGNER` |
| `contracts/script/DeployRobinhoodOtc.s.sol`, `DeployRobinhoodOtcFireball.s.sol` | 4663 | see the script |
| `contracts/script/DeployXMoneyStack.s.sol` | 4663 | `DEPLOYER_PRIVATE_KEY`. Deploys `XMoneyUSD`, not the live `XMoney` vault. |

The cutover notes for the Fireball generation are [`contracts/relaunch/FIREBALL-466302.md`](contracts/relaunch/FIREBALL-466302.md). Fleet deploy helpers live in `scripts/deploy-l4-fleet-infra.mjs`, `scripts/run-fleet-forge.mjs`, and `scripts/replay-forge-broadcast-l4.mjs`.

Offline tests that do not need Foundry, from the repo root after `npm install --legacy-peer-deps`:

```sh
node --test scripts/plan-fireball-relaunch.test.mjs
node --test server/keeper/fireball.test.mjs
node --test server/paymaster/test/*.test.mjs
```

`server/paymaster/test/contract.test.mjs` skips unless `contracts/out` contains `XgasDevPaymaster` and `EntryPoint` and `anvil` is on `PATH`.

## MCP server

Package `xgas-mcp` (`mcp/package.json`, version in that file). Node `>=20`. The tool registry is `mcp/src/registry.mjs`. Live hosted counts are `GET https://xgas.dev/api/mcp`. Trust that over any number copied into a doc.

### Hosted

```
https://xgas.dev/mcp
```

`POST` only. The endpoint is stateless Streamable HTTP. `GET` and `DELETE` return 405.

Without a bearer token the server exposes every tool except `claim_exit` and `wallet_*` (`isHostable` in `mcp/src/server.mjs`). That includes reads, unsigned `prepare_*` transactions, and `submit_*` relays of a transaction you already signed. It does not sign for you.

Wallet tools are added when you send the connector token minted after [Sign in with X](https://xgas.dev/auth/x/login). That URL with no `returnTo` lands on `/connector`, which mints a token (`POST /api/connector/token`) and can show this host config:

```json
{
  "mcpServers": {
    "xgas": {
      "url": "https://xgas.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The token lasts 180 days and only carries your X id. `POST https://xgas.dev/api/connector/revoke` while signed in with X revokes every token you have minted. With that bearer, the endpoint also serves `wallet_status`, `wallet_create`, `wallet_execute`, and `wallet_approval_status`. `claim_exit` stays off HTTP: it spends the host's gas.

The wallet is opt-in and custodial (Privy, `PRIVY_APP_SECRET` on the host). `wallet_execute` with `confirm: true` sends on its own only inside the host policy: default **25 USD** per execution and **100 USD** per rolling 24 hours (`mcp/src/walletPolicy.mjs`), and only to contracts from the deployment file. Anything else returns `https://xgas.dev/approve/<id>`, which expires in 10 minutes, works once, and requires the owner signed in with X in a browser.

`MCP_AUTH_TOKEN` is an operator token for this host's own tooling, not the user path above.

### Local stdio

```sh
cd mcp
npm install
npm start
```

Or, from a published package: `npx -y xgas-mcp`.

Host config for stdio:

```json
{
  "mcpServers": {
    "xgas": { "command": "npx", "args": ["-y", "xgas-mcp"] }
  }
}
```

Stdio serves the full registry, including `claim_exit`. Wallet tools do nothing until `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are set.

| Command | What it does |
|---|---|
| `npm start` | `node src/index.mjs` on stdio |
| `npm test` | `node --test scripts/wallet-policy.test.mjs` (offline) |
| `npm run check` | `node scripts/smoke.mjs` against the live chains |
| `npm run check:deployment` | checks `../src/contracts/l4-deployment.json` |
| `npm run e2e` | `node scripts/xswap-e2e.mjs`. Needs an anvil fork and a redeployed XSwap pair. See the header of that file. |
| `npm run e2e:v2` | `node scripts/xswap-v2-e2e.mjs`. Starts its own anvil processes. Needs Foundry. |

Optional env vars (`XGAS_DEPLOYMENT`, `XGAS_RPC`, `XGAS_PARENT_RPC`, `XGAS_API`, and the wallet caps) are listed in [`mcp/README.md`](mcp/README.md).

## Robinhood RPC proxy

`fly-rpc/` is a failover proxy in front of dRPC, publicnode, staccpad, and `https://rpc.mainnet.chain.robinhood.com`. No npm dependencies. The site and the hosted MCP use it as `http://xgas-rpc.internal:8545` (see root `fly.toml`). The sequencer and validators stay on dRPC directly.

```sh
cd fly-rpc
npm test          # node --test --test-concurrency=1 test/unit.test.mjs test/proxy.test.mjs
npm run smoke     # node --test test/live.test.mjs
npm start         # node server.mjs
```

Deploy is the comment block in `fly-rpc/fly.toml`:

```sh
fly apps create xgas-rpc --org personal
fly secrets import -a xgas-rpc --stage     # stdin: DRPC_URL=https://...
fly deploy --ha=false
fly scale count 2 --region iad,ord --max-per-region 1 -a xgas-rpc
```

`DRPC_URL` is a secret. The image is Node 22 (`fly-rpc/Dockerfile`).

## Bundler

`fly-bundler/` runs Pimlico Alto for chain 466302 so `XgasDevPaymaster` user operations can land. One machine: the mempool is in memory. The full runbook is [`fly-bundler/README.md`](fly-bundler/README.md). Short form, from that directory:

```sh
npm ci
npm start            # sh ./entrypoint.sh
npm run test:fork    # sh test/fork-e2e.sh  (needs Foundry; anvil fork of https://xgas.dev/rpc)
PAYMASTER=xgasdev sh test/fork-e2e.sh
```

Deploy the EntryPoint, factory, and paymaster with `contracts/script/DeployXgasAA.s.sol` first. Then, still in `fly-bundler/`:

```sh
RPC_URL=https://xgas.dev/rpc DEPLOYER_PRIVATE_KEY=<utility key> node scripts/deploy-simulations.mjs
fly apps create xgas-bundler
fly secrets set EXECUTOR_PRIVATE_KEYS=0x... UTILITY_PRIVATE_KEY=0x... -a xgas-bundler
fly deploy --ha=false
```

`fly-bundler/fly.toml` already records the EntryPoint and simulation-contract addresses from `l4-deployment.json`. Chain id `466302` is `0x71d7e`.

## Run a node

Third-party node and validator instructions are served from `public/`:

- [`public/RUN-A-NODE.md`](public/RUN-A-NODE.md)
- [`public/run-a-validator.md`](public/run-a-validator.md)
- [`public/validator-node-config-466302.json`](public/validator-node-config-466302.json)

A full node, from `public/RUN-A-NODE.md`:

```sh
docker run --rm -it -v $PWD/xgas-node:/home/user/.arbitrum -p 8547:8547 \
  offchainlabs/nitro-node:v3.11.4-7d5ac27 \
  --chain.info-json="$(curl -s https://xgas.dev/chain-info.json)" \
  --chain.name=xgas \
  --parent-chain.connection.url=https://rpc.mainnet.chain.robinhood.com \
  --execution.forwarding-target=https://xgas.dev/rpc \
  --http.api=net,web3,eth,arb --http.corsdomain=* --http.addr=0.0.0.0 --http.vhosts=*
```

`--chain.name` must be `xgas`, matching `chain-name` in `public/chain-info.json`. Validation is permissionless. Posting an assertion requires the 0.01 WETH stake.

## More documentation

| | |
|---|---|
| Operator wiki | [`.claude/wiki.md`](.claude/wiki.md) |
| MCP design, XSwap history, wallet policy | [`mcp/README.md`](mcp/README.md) |
| Fireball cutover | [`contracts/relaunch/FIREBALL-466302.md`](contracts/relaunch/FIREBALL-466302.md) |
| JIT toll and the v4 fork | [`contracts/src/amm/README.md`](contracts/src/amm/README.md) |
| Paymaster wire format | [`server/paymaster/spec.md`](server/paymaster/spec.md) |
| Bundler | [`fly-bundler/README.md`](fly-bundler/README.md) |
| Research notes | [`research/`](research/) |
