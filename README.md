# xGas

**Alpha, unaudited. Funds can be lost.** Use only what you can afford to lose. The same warning is on the site (`index.html`) and in [mcp/README.md](mcp/README.md).

xGas is an Arbitrum Orbit L4 rollup, chain **466302**, that settles to Robinhood Chain (**4663**). Batches are posted in full to the SequencerInbox (`dataAvailability` is `rollup` in [src/contracts/l4-deployment.json](src/contracts/l4-deployment.json)). There is no data-availability committee. **$xMoney** is the native gas token. It is minted by a USDG-backed vault on Robinhood. The ratio that matters is r/s: vault USDG reserve divided by circulating $xMoney (`get_vault_nav` on the MCP).

On the L4, a P2P OTC escrow holds $xMoney while the dollar leg moves between X handles on X Money. The connector never marks that fiat leg done. NGU tokens are permissionless bonding curves. XSwap escrows X Money on Robinhood against an asset on another EVM chain, filled by bonded solvers. The solver network fills X Money out to native ETH on Base; other routes wait for a bid. Ramps quote a whole route (vault, OTC, or exit) and walk it one step at a time. L4 fees of 0.02% are bridged to `XgasDevBuyback` on Robinhood, which redeems $xMoney for USDG, buys **XGAS.DEV**, and burns it.

The rollup, inbox, outbox, bridge, sequencer inbox, and upgrade executor are Arbitrum Orbit core, created with the RollupCreator. The escrow, NGU launcher, router, FOMO game, and XMoney vault token are separate contracts in this repository. They are not part of that audited Orbit core. The same is true of the other app contracts here (XSwap, the buyback, the paymaster, the JIT-toll PoolManager, and the staccpad fleet).

Chain **466301** is retired (AnyTrust). Its record, including how to finish a withdrawal that already started there, is `legacy466301` in the deployment file. [src/contracts/l3-deployment.json](src/contracts/l3-deployment.json) is the older manifest for that chain.

Operational history, superseded notes, and landmines live in [.claude/wiki.md](.claude/wiki.md). Tool behavior, environment variables, the XSwap owner gate, and the agent wallet live in [mcp/README.md](mcp/README.md). This file does not repeat them.

## Layout

| Path | What it is |
|---|---|
| [src/](src/) | Vite + React UI. Tabs are real paths: `/otc`, `/connector`, `/ngu`, `/nft`, `/drops`, `/markets`, `/pawn`, `/robinhood` ([src/App.tsx](src/App.tsx)). |
| [server.js](server.js) | Express app: API, hosted MCP, X sign-in, paymaster, keepers, link-preview cards. Serves `dist/`. |
| [server/](server/) | Paymaster ([server/paymaster/spec.md](server/paymaster/spec.md)), Fireball fee keeper, approval page, OG cards. |
| [mcp/](mcp/) | `xgas-mcp` package (Node `>=20`). stdio entry [mcp/src/index.mjs](mcp/src/index.mjs). |
| [contracts/](contracts/) | Solidity (`solc` 0.8.26). Scripts in [contracts/script/](contracts/script/), tests in [contracts/test/](contracts/test/). |
| [contracts/l4-artifacts/](contracts/l4-artifacts/), [contracts/l3-artifacts/](contracts/l3-artifacts/) | Committed `{abi, bytecode}` used where the runtime has no compiler. |
| [public/](public/) | Node and validator docs, chain info, and contract source served with the site. |
| [fly-rpc/](fly-rpc/) | Private Robinhood RPC failover proxy (Fly app `xgas-rpc`). |
| [fly-bundler/](fly-bundler/) | ERC-4337 bundler (Pimlico Alto) for chain 466302. |
| [scripts/](scripts/) | Operator utilities. Several assume `/Users/stacc/nft-range` and a local signer file. |
| [research/](research/) | Notes and drafts. Not a runbook. |
| [docs/](docs/) | Plasma and Tempo deploy runbook, the Orbit child, and the sovereign-unit memo. |
| [assets/fonts/](assets/fonts/) | Fonts for the OG cards. |

The root `package.json` is still named `react-example`. The Fly app name in [fly.toml](fly.toml) is `xgas`. The production image is Node 20 ([Dockerfile](Dockerfile)). `fly-rpc` and `fly-bundler` use Node 22.

## Addresses

Taken from [src/contracts/l4-deployment.json](src/contracts/l4-deployment.json) unless noted. The fleet, superseded generations, and the retired chain are in that file. Do not copy addresses out of [.claude/wiki.md](.claude/wiki.md) when this file disagrees with it: several wiki sections are marked superseded.

### Orbit core (Robinhood Chain 4663)

| | Address |
|---|---|
| Rollup | `0x5868266C0c0663f4bc39329B525884f137BAD93E` |
| Inbox | `0xa7087693676F2Ca8e5e9563A6859952258688146` |
| Outbox | `0xA6f07dd42CFE78EC8D88484b238b3B05149Eb2b3` |
| Bridge | `0x2290f4505484f055B710e7Df37e2482c90B8B6fb` |
| Sequencer inbox | `0xCA038a032154d0091b019A9104b369F94FD5c75F` |
| Upgrade executor | `0x43E881A831Ec5680aa6f63d2b48913050038b9F9` |
| Chain owner | `0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F` |
| Fast-confirm Safe (2 of 3) | `0x17fC7585A3c99ACC2A7CFC1842C119d7FBB12cBC` |
| XMoney timelock (24h, `timelockMinDelaySeconds` 86400) | `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B` |

`confirmPeriodBlocks` is **50400**. `validatorWhitelistDisabled` is true. `baseStake` is `10000000000000000` (0.01 WETH; the stake token is WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). Public L4 RPC: `https://xgas.dev/rpc`. Sequencer: `https://xgas-l4.fly.dev`. Parent RPC named in the deployment file: `https://rpc.mainnet.chain.robinhood.com`.

Running a node or a validator is [public/RUN-A-NODE.md](public/RUN-A-NODE.md) and [public/run-a-validator.md](public/run-a-validator.md). Chain info for Nitro is [public/chain-info-466302.json](public/chain-info-466302.json) and [public/validator-node-config-466302.json](public/validator-node-config-466302.json). This repo does not contain the sequencer Fly app.

### Vault, gas token, buyback (Robinhood)

| | Address |
|---|---|
| $xMoney vault (native gas token) | `0xa924C725B64cC346f275269EFA4Bd0538cfBa97E` |
| Legacy $xMoney | `0xa72Ab0874A57Ab0F950Bf61B096b01b183A3CB7c` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Stacc Wizards Fanout (vault rake) | `0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e` |
| EarlyDepositor | `0x36e52831ba473e9374bad7cc22ed942a99b4d431` |
| XGAS.DEV | `0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3` |
| XgasDevBuyback | `0x6067E608d1e0C4a67d406447FaA42a7C7452f7F8` |

[mcp/README.md](mcp/README.md) records that this deployed vault is older than [contracts/src/XMoney.sol](contracts/src/XMoney.sol): some functions in that source are absent from the bytecode. The fee constants below are the ones the source and the connector both use.

Deposits follow `vault.inbox()` at call time. The helper route and the direct `enterRollup` route are both in [mcp/README.md](mcp/README.md).

### L4 desk

`fireball.active` is true, so new orders, keys, and launches use the Fireball generation. The original `l4.*` contracts stay for positions already opened there. Same addresses in [src/contracts/fireball-relaunch.json](src/contracts/fireball-relaunch.json).

| | Fireball (current) | Original `l4.*` |
|---|---|---|
| Escrow | `0xf8Dbd439A994ff913509e68085B2ED3deC94c26A` | `0x842E6904e4eB64d5957CC2E9Eb640A9a8C006754` |
| FOMO | `0xDefE7c5e5B36B964894e931A83768083B040ad62` | `0xa8d88800cf41a2c246fa363f4fa9ee14c1fef151` |
| Router | `0x82334088CB47E95eFaB8D65591157190Ac40e00A` | `0xc4a5869A959Db3cead7E568D368Ce822f52b9a2E` |
| NGU launcher | `0x9e9BC96c318996b4DC147069E1Ed17d828245e53` | `0x6067e608d1e0c4a67d406447faa42a7c7452f7f8` |
| Fanout sink | `0x4ca8826FBb7F69F55B858485313eAC56a1b4F458` | `0xfeb38ce50e1F49438acAa39b2Da513d2F1DE548f` |

Fireball parent fanout: `0x0a87Da84277232720e0908CC7470e3A7f925748f`. Parent forwarder: `0x44a0438e85C3947C369B1B8A7D9991741040A7FF`. Original L4 buyback sink: `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B` (that hex is also the Robinhood timelock; they are different chains).

Robinhood ETH OTC (dollars against ETH, separate from the L4 $xMoney desk): arbitration `0x16BCd95b5eB685DfaA04295462564d56979f35b4`, escrow `0x534df478ea378C1B4A596a10f8d3b5659486a8Cb`.

ERC-4337 on the L4: EntryPoint `0x78546FE8666E4fD4b67C764cdEa7619C6037B870`, `XgasDevPaymaster` `0x3f484cdf443A0bDa9c0993e0d4BA1024B4c1CE64`.

### XSwap (Robinhood)

V2 addresses are pinned in [mcp/src/config.mjs](mcp/src/config.mjs) (`XSWAP_V2`), not in the deployment file:

| | Address |
|---|---|
| Collector | `0x5a5e18e5003d75f9705252b2c3436c1b61e6d33e` |
| Intents escrow | `0xdf6398ff5a694a03d85a614812490143c4e5d238` |
| Asks escrow | `0x2f507a18043002d8f5d6d3022efd6265be7a87fc` |
| Deployed owner | `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158` |
| Treasury | `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8` |

The deployment file's `xswap` block (`0x5D78651C728c15b715d5f6727bE40C1c3a02B53d` / `0xa999BC26e184b83CECb3cF5b9640C438C5aDc8a3`) and the older v1 escrows are exit-only. New swaps go through the gate in [mcp/src/xswapV2.mjs](mcp/src/xswapV2.mjs). `xswap_terms` is the live reading. See [mcp/README.md](mcp/README.md).

### Fleet

`fleet.status` is `live` (staccpad NFT NGU, peg markets, drops, CLMM, pawn). PoolManager (the JIT-toll fork): `0xea2ce320b5cdbf14bc734feb60c78097e146f1b0`. The rest, including superseded generations, is the `fleet` object in the deployment file. Record of the deploy: [contracts/relaunch/fleet-466302-deployed.json](contracts/relaunch/fleet-466302-deployed.json).

## Fees

Basis points are `n / 10000`. Sources are the contracts and the MCP constants that mirror them (`BURN_BPS`, `FANOUT_RAKE_BPS`, `BUYBACK_BPS` in [mcp/src/config.mjs](mcp/src/config.mjs)).

| Path | Fee | Source |
|---|---|---|
| Vault enter and exit | 0.01% USDG to the Fanout (`FANOUT_RAKE_BPS = 1`). Entry also burns 0.01% of $xMoney (`BURN_BPS = 1`). | [contracts/src/XMoney.sol](contracts/src/XMoney.sol) |
| $xMoney transfer | 0.01% burned. Transfers into the inbox and bridge are the exception the vault is built around. | [contracts/src/XMoney.sol](contracts/src/XMoney.sol) |
| L4 escrow release, router, FOMO, NGU mint and burn | 0.01% burn + 0.01% FanoutSink + 0.02% buyback sink (0.04% combined). | [contracts/src/XMoneyEscrow.sol](contracts/src/XMoneyEscrow.sol), [contracts/src/XGasRouter.sol](contracts/src/XGasRouter.sol), [contracts/src/FomoAttritionL4.sol](contracts/src/FomoAttritionL4.sol), [contracts/src/NguToken.sol](contracts/src/NguToken.sol) |
| NGU launch | No launch fee. The seed goes to the reserve. | [contracts/src/NguLauncher.sol](contracts/src/NguLauncher.sol) |
| FOMO key buy | 55% dividends, 35% this round's jackpot, the 4 bp above, and the rest (9.96%) seeds the next round. | [contracts/src/FomoAttritionL4.sol](contracts/src/FomoAttritionL4.sol) (`5500` and `3500` per 10000) |
| L4 OTC fiat timeout | 15 minutes, then the seller can reclaim. | `TRADE_TIMEOUT` in [contracts/src/XMoneyEscrow.sol](contracts/src/XMoneyEscrow.sol) |
| Robinhood ETH OTC | 0.1% fee (`FEE_BPS = 10`), 5% bond (`BOND_BPS = 500`). | [contracts/src/RobinhoodEthOtc.sol](contracts/src/RobinhoodEthOtc.sol) |
| XSwap V2 | 1 bp $xMoney transfer burn, 10 bp site fee, 50 bp protocol fee. | `XSWAP_V2_*_BPS` in [mcp/src/xswapV2.mjs](mcp/src/xswapV2.mjs) |
| PoolManager JIT toll | LP add, LP remove, and swaps pay the pool fee plus a 10 bp floor, escalating with repeat references in one transaction, capped at 100%. | [contracts/src/amm/JitToll.sol](contracts/src/amm/JitToll.sol), [contracts/src/amm/README.md](contracts/src/amm/README.md) |
| Buyback | Keeper-only `execute`: redeem $xMoney, swap USDG → ETH → XGAS.DEV, burn. No withdraw. | [contracts/src/XgasDevBuyback.sol](contracts/src/XgasDevBuyback.sol) |

`quote_exit` also counts the 0.01% $xMoney tax on the bridge payout. The breakdown is in [mcp/README.md](mcp/README.md).

## Web app and API

From the repo root. The Docker build uses `npm install --legacy-peer-deps` ([Dockerfile](Dockerfile)).

```bash
npm install --legacy-peer-deps
npm run dev       # Vite only, port 3000, host 0.0.0.0. No API proxy.
npm run build     # vite build → dist/
npm run lint      # tsc --noEmit
npm run preview   # Vite preview of dist/. Still no API.
node server.js    # API, /mcp, and dist/. PORT defaults to 3000.
```

`npm run dev` does not start [server.js](server.js), and [vite.config.ts](vite.config.ts) has no proxy. The UI's `/api/*` calls need the Express server. `node server.js` listens even before a build; pages that send `dist/index.html` need `npm run build` first.

Off Fly, state goes to `l4-data/` when `/data` is absent, or to `XGAS_DATA_DIR_DEV` when that is set. On Fly the volume `xgas_data` is mounted at `/data` ([fly.toml](fly.toml)).

`npm run clean` deletes `dist` and also `server.js`. It is not a dist-only clean.

Deploy the site from the repo root:

```bash
fly deploy
```

That is app `xgas`, image from [Dockerfile](Dockerfile), internal port 3000. The runtime stage copies `dist/`, `server.js`, `server/`, `assets/`, `mcp/src`, `mcp/package.json`, [src/contracts/l4-deployment.json](src/contracts/l4-deployment.json), and [src/contracts/fireball-relaunch.json](src/contracts/fireball-relaunch.json). `L4_RPC_INTERNAL` defaults on Fly to `http://xgas-l4.internal:8449`. The parent RPC in [fly.toml](fly.toml) is `http://xgas-rpc.internal:8545`.

## Contracts

[contracts/foundry.toml](contracts/foundry.toml) sets `solc` 0.8.26, Cancun, optimizer 200 runs. `libs` includes `lib` and `/Users/stacc/nft-range/lib`. Remappings send `forge-std` and `@openzeppelin` at that nft-range tree. `@account-abstraction` is vendored at [contracts/lib/account-abstraction](contracts/lib/account-abstraction). A checkout without those paths will not `forge build`.

After a successful `forge build`, export the bytecode the rest of the repo commits:

```bash
cd contracts && forge build
cd .. && npm run artifacts          # node scripts/export-l4-artifacts.mjs
node scripts/export-l3-artifacts.mjs
```

`npm run artifacts` reads `contracts/out/<Name>.sol/<Name>.json` for FanoutSink, XMoneyEscrow, FomoAttritionL4, XGasRouter, NguToken, NguLauncher, and XgasDevBuyback, and writes [contracts/l4-artifacts/](contracts/l4-artifacts/).

Unit and fork tests live under [contracts/test/](contracts/test/). Commands already used in this repo:

```bash
cd contracts
forge test --match-path test/XSwap.fork.t.sol
forge test --match-contract FireballBridgeFeeForwarderTest
FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract FireballBridgeFeeForwarderForkTest
FORK_L4_URL=https://xgas.dev/rpc forge test --match-contract FireballOrbitL4ForkTest
```

The first is the XSwap fork test named in [mcp/README.md](mcp/README.md), which says `FORK_URL` defaults to the Robinhood RPC. The Fireball three are named in [contracts/relaunch/FIREBALL-466302.md](contracts/relaunch/FIREBALL-466302.md).

Deploy scripts (broadcast only against the chain the script checks, with the env vars in each file's header):

| Script | Chain |
|---|---|
| [contracts/script/DeployXMoneyStack.s.sol](contracts/script/DeployXMoneyStack.s.sol) | XMoneyUSD on Robinhood |
| [contracts/script/DeployXgasDevBuyback.s.sol](contracts/script/DeployXgasDevBuyback.s.sol) | Robinhood buyback |
| [contracts/script/DeployRobinhoodOtc.s.sol](contracts/script/DeployRobinhoodOtc.s.sol) | Robinhood ETH OTC |
| [contracts/script/DeployXSwap.s.sol](contracts/script/DeployXSwap.s.sol) | Robinhood XSwap |
| [contracts/script/DeployOrbitL4.s.sol](contracts/script/DeployOrbitL4.s.sol) | L4 desk |
| [contracts/script/DeployOrbitL4Fireball.s.sol](contracts/script/DeployOrbitL4Fireball.s.sol) | L4 Fireball generation, one step per tx |
| [contracts/script/DeployFireballBridgeForwarder.s.sol](contracts/script/DeployFireballBridgeForwarder.s.sol) | Robinhood forwarder |
| [contracts/script/DeployXgasAA.s.sol](contracts/script/DeployXgasAA.s.sol) | L4 EntryPoint, factory, paymaster |
| [contracts/script/DeployAmm.s.sol](contracts/script/DeployAmm.s.sol) | L4 tolled PoolManager |

Header commands, copied from those files:

```bash
cd contracts
PRIVATE_KEY=... forge script script/DeployRobinhoodOtc.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast
forge script script/DeployAmm.s.sol --rpc-url https://xgas.dev/rpc --broadcast
```

The XSwap dry-run and broadcast lines are in [mcp/README.md](mcp/README.md). Fireball ordering is [contracts/relaunch/FIREBALL-466302.md](contracts/relaunch/FIREBALL-466302.md). `forge script --broadcast` on the L4 underprices parent posting gas; [scripts/replay-forge-broadcast-l4.mjs](scripts/replay-forge-broadcast-l4.mjs) replays a dry-run with the node's gas estimates. That script, [scripts/run-fleet-forge.mjs](scripts/run-fleet-forge.mjs), and [scripts/deploy-l4-fleet-infra.mjs](scripts/deploy-l4-fleet-infra.mjs) require `FIREBALL_SIGNER_PROFILE=owner` and a signer file at `/Users/stacc/staccoverflow.eth`.

Node tests that do not need Foundry. Run them from the repo root after `npm install --legacy-peer-deps` (`viem` and `express` are root dependencies). [server/keeper/fireball.test.mjs](server/keeper/fireball.test.mjs) has no package imports and can run before that install.

```bash
node --test scripts/plan-fireball-relaunch.test.mjs
node --test server/keeper/fireball.test.mjs
node --test server/paymaster/test/*.test.mjs
```

`server/paymaster/test/contract.test.mjs` skips unless `anvil` and `contracts/out` are both present. The paymaster wire format it checks is [server/paymaster/spec.md](server/paymaster/spec.md).

## MCP

Package `xgas-mcp`. Full tool list, env vars, wallet policy, and the XSwap gate: [mcp/README.md](mcp/README.md).

Hosted server: `https://xgas.dev/mcp` (Streamable HTTP, `POST` only). `GET https://xgas.dev/api/mcp` returns the live tool counts from the registry.

Anonymous callers get every tool except `claim_exit` and `wallet_*` ([mcp/src/server.mjs](mcp/src/server.mjs), `isHostable`): reads, unsigned prepares, and `submit_*` relays of a transaction the caller already signed.

Wallet tools are added when the request is signed in. A model has no cookie, so the person signs in with X at `https://xgas.dev/auth/x/login` (no `returnTo` lands on `/connector`), mints a connector token, and pastes the host config:

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

That JSON is what the connector page labels host config ([src/components/McpConnector.tsx](src/components/McpConnector.tsx)). The token lasts 180 days. `POST /api/connector/revoke`, while signed in with X, kills every token that person has minted. `claim_exit` stays off HTTP either way. Wallet tools sign only when Privy is configured on the host.

Local stdio serves the full set, including `claim_exit`:

```bash
cd mcp
npm install            # npm ci fails: the lockfile is missing utf-8-validate
npm start              # node src/index.mjs
npm test               # wallet policy, contract fidelity, public-RPC scrub
npm run check          # stdio smoke against the live chains
npm run check:deployment
npm run e2e            # XSwap on an anvil fork
npm run e2e:v2
```

`npm run check:deployment` runs [mcp/scripts/check-deployment.mjs](mcp/scripts/check-deployment.mjs) on [src/contracts/l4-deployment.json](src/contracts/l4-deployment.json). `prepack` copies that file to [mcp/deployment.json](mcp/deployment.json) and checks the copy. Without cloning: `npx -y xgas-mcp`.

## fly-rpc

Failover JSON-RPC proxy for Robinhood Chain. No npm dependencies. From [fly-rpc/](fly-rpc/):

```bash
cd fly-rpc
npm test          # node --test test/unit.test.mjs test/proxy.test.mjs
npm run smoke     # live upstreams (test/live.test.mjs)
npm start         # node server.mjs
```

Deploy commands are the header of [fly-rpc/fly.toml](fly-rpc/fly.toml):

```bash
fly apps create xgas-rpc --org personal
fly secrets import -a xgas-rpc --stage     # stdin: DRPC_URL=https://...
fly deploy --ha=false
fly scale count 2 --region iad,ord --max-per-region 1 -a xgas-rpc
```

The app has no public HTTP service. Consumers use `http://xgas-rpc.internal:8545`. Image: [fly-rpc/Dockerfile](fly-rpc/Dockerfile) (Node 22).

## Bundler

ERC-4337 bundler for chain 466302. Setup, Alto flags, helper-contract deploy, and the fork test are [fly-bundler/README.md](fly-bundler/README.md). Short form, from that file and [fly-bundler/package.json](fly-bundler/package.json):

```bash
cd fly-bundler
npm install
sh test/fork-e2e.sh
PAYMASTER=xgasdev sh test/fork-e2e.sh
fly deploy --ha=false
```

`npm run test:fork` is `sh test/fork-e2e.sh`. The Fly app name is `xgas-bundler`. One machine: the mempool is in memory ([fly-bundler/fly.toml](fly-bundler/fly.toml)).

## More docs

- [mcp/README.md](mcp/README.md) — connector, tools, fees the quoter applies, wallet caps.
- [.claude/wiki.md](.claude/wiki.md) — how the chain was actually operated, including notes that later commits superseded.
- [contracts/src/amm/README.md](contracts/src/amm/README.md) — JIT toll and the PonsV2 rules.
- [public/RUN-A-NODE.md](public/RUN-A-NODE.md), [public/run-a-validator.md](public/run-a-validator.md) — Nitro node and permissionless validator.
- [docs/sovereign-unit-memo.md](docs/sovereign-unit-memo.md) — sovereign-unit design brief. A new unit is one file under [config/units/](config/units/); the steps are [docs/sovereign-unit-kit.md](docs/sovereign-unit-kit.md). The Plasma deployment and the $1000 USDT0 yield comparison against 4.29% are [docs/plasma-proof.md](docs/plasma-proof.md). The XPL-native launch runbook is [docs/orbit-on-plasma-tempo.md](docs/orbit-on-plasma-tempo.md) and [docs/plasma-tempo-deploy.md](docs/plasma-tempo-deploy.md).
- [server/paymaster/spec.md](server/paymaster/spec.md) — `XgasDevPaymaster` wire format.
