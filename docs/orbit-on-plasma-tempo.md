# Orbit child of Plasma, with XPL as gas

Plasma (chain 9745) is the parent. The child is an ETH-style Arbitrum Orbit chain: `nativeToken = address(0)`, so the child's gas token is Plasma's native coin, XPL. There is no custom ERC-20 gas token and no AnyTrust fast confirmer.

The sovereign-unit brief this launch is for is [sovereign-unit-memo.md](sovereign-unit-memo.md). Which of its claims the $1000 USDT0 deployment can test, and the empty mainnet hash table, are [plasma-proof.md](plasma-proof.md). The vault economics are [plasma-tempo-deploy.md](plasma-tempo-deploy.md).

Chain id **974502** is a provisional label used by the launch script. It is not registered.

Tempo (chain 4217) is not a parent for this design. It has no native coin, so the Inbox/Outbox ETH path does not exist there. A Tempo equivalent would be a different, custom-gas Orbit chain (`ERC20Inbox`, `nativeToken` = OUSD or pathUSD, `L1OrbitERC20Gateway`). That configuration was not deployed.

## Go / no-go

| Parent | Result | Why |
| --- | --- | --- |
| Plasma 9745 | Go, on a mainnet fork | ETH-style rollup deploys. XPL, USDT0, and USDC deposit and withdraw. Each template transaction and `createRollup` fit in the 36,000,000 block gas limit. Calldata batches post. Blob batches revert with the standard dummy reader. |
| Tempo 4217 | No for this design | No native gas token. BALANCE / CALLVALUE are 0, so `depositEth` and value-bearing withdrawals cannot escrow a gas token. |

The fork test that holds the go is `contracts/orbit/test/PlasmaChildBridge.fork.t.sol`. It does not broadcast.

## What was verified

Fork of `https://rpc.plasma.to`, chain id 9745, around block 35,437,459. `forge test` gas limit is raised locally so the whole template set can be created inside one test transaction. On Plasma those creates are separate transactions. The test asserts each one is under 36,000,000 gas.

| Step | Gas | XPL at the observed `eth_gasPrice` of 9,003,180 wei |
| --- | ---: | ---: |
| Heaviest single template deploy | 5,800,092 | 0.00005222 |
| `createRollup` | 7,159,549 | 0.00006446 |
| All templates plus `createRollup` in one transaction | 80,718,288 | Does not fit in a Plasma block. Do not do this. |
| `Inbox.depositEth` of 0.2 XPL | 102,719 | 0.00000092, plus 0.2 XPL held by the bridge |
| USDT0 `outboundTransfer` of 1 USDT0 | 262,661 | 0.00000236, plus a few million wei of retryable value held by the bridge |
| USDC `outboundTransfer` of 1 USDC | 255,141 | 0.00000230, same shape |
| Empty calldata batch | 104,630 | 0.00000094 |
| XPL `Outbox.executeTransaction` | 134,052 | 0.00000121 |
| USDT0 release | 182,251 | 0.00000164 |
| USDC release | 183,505 | 0.00000165 |

`eth_gasPrice` was 9,003,180 wei while `baseFeePerGas` was 8 wei. Price off `eth_gasPrice`. At 1 gwei the `createRollup` transaction is about 0.0072 XPL, and the whole template set is on the order of 0.08 XPL. Funding the deployer with **1 XPL** covers the launch at the live price and at a large spike. Stake for BoLD is WXPL, not a separate fee: the test wrapped 0.001 XPL. Production `baseStake` in the launch library is the same 0.001 XPL until you change it.

`addSequencerL2BatchFromBlobs` reverts. The sequencer inbox is constructed with `IReader4844(address(137))`, which has no code on Plasma, the same dummy the upstream tests use. Calldata batches succeed, including the genesis batch inside `createRollup` and a later empty batch from the batch poster. This matches how 466302 posts batches. A blob path needs a real Reader4844 baked into the SequencerInbox template before `createRollup`.

`ArbSys` at `0x64` has no code on Plasma. Rollup init asks `ArbitrumChecker` whether it is on an Arbitrum parent (staticcall to `0x64`'s `arbOSVersion`). The call fails, the chain is treated as a non-Arbitrum parent, and init completes. `parent-chain-is-arbitrum` in the node config is `false`.

## Three assets

| Asset | Plasma address | Path |
| --- | --- | --- |
| XPL | native | `Inbox.depositEth`. Withdrawal is an `Outbox.executeTransaction` that pays XPL out of the bridge. |
| USDT0 | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` | `L1GatewayRouter` / `L1ERC20Gateway`. 6 decimals, read on the fork. |
| USDC | `0x2d661C89D812261039AF9764eceaAee884f5F67F` | Same standard gateway. Published by Circle for Plasma: [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). On the fork: name USDC, symbol USDC, decimals 6, code size 1798. |

The gateway is the ETH-rollup gateway. `L1OrbitERC20Gateway` is the custom-fee-token gateway and is not used. Both tokens escrow on the gateway (`safeTransferFrom`, so a missing `bool` return is acceptable) and a later outbox message whose `l2Sender` is the registered L2 gateway releases them.

The L1 gateway is initialized with these counterparts. The child chain has to place the L2 contracts at the same addresses, or withdrawals will not authenticate and the L2 token addresses will not match:

| Role | Address |
| --- | --- |
| L2 ERC-20 gateway | `0xC0fFeE0000000000000000000000000000000974` |
| L2 gateway router | `0xc0fFEe0000000000000000000000000000000975` |
| L2 beacon proxy factory | `0xC0FFEe0000000000000000000000000000000976` |

`calculateL2TokenAddress` on the fork-test gateway, using `keccak256(type(ClonableBeaconProxy).creationCode)`:

| L1 token | Child reserve address |
| --- | --- |
| USDT0 | `0xdcEF77A85B501B038e127270e2E206857e26D93e` |
| USDC | `0x07ae580F267A268Cbafd34d0F926ceFE04b59505` |

`XMoneyMultiReserveVault` accepts a list of USD stables. Every whole token is valued at $1, so a token with `d` decimals (d ≤ 18) contributes `balance * 10^(18-d)` to the NAV. USDT0 and USDC are the Plasma default. `RESERVE_TOKENS` is a comma-separated override (USDG, USDT, USDT0, USDC, or any other USD stable the constructor can read `decimals()` from). Enter and exit name which reserve moves, with the same 1 bp rake, 1 bp entry burn, and 1 bp transfer burn as the single-reserve vault. `MultiReserveFanout` splits whichever reserve it is given 2:1 between buyback and treasury. `MultiReserveBuyback` enters that reserve and sends the minted $xMoney to `0xdead`.

The fork cannot execute those L2 tokens: they do not exist until the child is running. The vault is covered by `contracts/test/evm/XMoneyMultiReserve.t.sol`.

Stake token for assertions is WXPL `0x6100E367285b01F48D07953803A2d8dCA5D19873` (name "Wrapped XPL", symbol WXPL, decimals 18, `deposit()` wraps XPL). `anyTrustFastConfirmer` is `address(0)`. The fork test uses `confirmPeriodBlocks = 1` so it can `confirmAssertion` after `vm.roll`. The launch script uses 50400, in the same range as 466302.

## One-command launch

`./deploy-plasma-mainnet.sh` broadcasts the rollup, the USDT0/USDC gateway, and the Plasma xMoney vault. `./seed-plasma-usdt0.sh` then escrows the deployer's 1000.428045 USDT0.

The WASM module root is the consensus-v61 machine shipped in `offchainlabs/nitro-node:v3.11.4-7d5ac27`:

`0xc10cd7ec6acaf1c441a3f6bd0900ad20f15855ba775a96f1939118cbc629dc97`

That is the hash in the [consensus-v61 release](https://github.com/OffchainLabs/nitro/releases/tag/consensus-v61) ("WAVM Module Root") and the argument to `download-machine.sh consensus-v61` in the [v3.11.4 Dockerfile](https://github.com/OffchainLabs/nitro/blob/v3.11.4/Dockerfile). The image writes it to `/home/user/target/machines/latest/module-root.txt`. The chain config's `InitialArbOSVersion` is 61 so genesis matches that machine. The shell defaults `WASM_MODULE_ROOT` to this hash. Set it only to pin a different image.

```bash
export PLASMA_DEPLOYER_KEY=...
./deploy-plasma-mainnet.sh
./seed-plasma-usdt0.sh
```

Both scripts use `https://rpc.plasma.to`, `--private-key`, `--broadcast`, and `--slow`. A fork rehearsal sets `PLASMA_FORK_URL` and leaves the key unset.

`deployFactoriesToL2` is false, so the launch does not need a lump of XPL inside the transaction for L2 factory retryables. A production chain that wants the canonical CREATE2 factories should fund that path separately before anyone can use nonce 0 on the child. The script logs the rollup, bridge, inbox, sequencer inbox, outbox, gateway, router, and the two L2 reserve addresses. Copy the rollup addresses from the JSON the script writes into `contracts/orbit/node/chain-info-974502.json` (`rollup`, `bridge`, `inbox`, `sequencer-inbox`). `InitialChainOwner` becomes the upgrade executor the script's rollup owner controls. `InitialArbOSVersion` in that file is already 61.

The addresses above in the L2 counterpart table are the fork test's vanity constants. The mainnet script predicts the child contracts from `CHILD_DEPLOYER`'s nonces 0 through 4 instead. Those predictions are in `contracts/orbit/deployments/plasma-rollup.json` (`l2Erc20Gateway`, `l2GatewayRouter`, `l2BeaconProxyFactory`, `l2Usdt0`, `l2Usdc`). `DeployChildTokenBridge.s.sol` has to be that key's first five creates on chain 974502.

Fork rehearsal of 19 Oct 2026, anvil fork of Plasma at the deployer's live balances (47.211150098866677224 XPL and 1000.428045 USDT0), real consensus-v61 root, no mainnet transaction. Every receipt status 1. Heaviest transaction 6,839,679 gas, under the 36,000,000 cap.

| Step | Gas used | XPL at 0.001 gwei |
| --- | ---: | ---: |
| Rollup, bridge, gateway | 80,461,843 | 0.000080461843 |
| Vault, fanout, timelock, buyback | 4,196,616 | 0.000004196616 |
| Deploy total | 84,658,459 | 0.000084658459 |
| USDT0 approve | 53,377 | 0.000000053377 |
| USDT0 `outboundTransfer` of 1000.428045 | 235,865 | 0.000000235865 |

The seed also locks 100000000093440 wei (0.000100000000093440 XPL) in the bridge as the retryable's submission fee and L2 gas budget. That value is refundable on the child. It is not a fee paid to Plasma. The fork charged 300,000 wei per gas, so the deployer actually spent 0.0000253975377 XPL on the deploy and 0.0000000867726 XPL of gas on the seed, plus the locked retryable value. The 0.001 gwei column is the ceiling if every gas unit is priced at the cap the script passes on a fork.

Node, once those addresses are real:

```bash
docker run --rm -it -v "$PWD/xgas-plasma-node:/home/user/.arbitrum" -p 8547:8547 \
  offchainlabs/nitro-node:v3.11.4-7d5ac27 \
  --chain.info-json="$(cat contracts/orbit/node/chain-info-974502.json)" \
  --parent-chain.connection.url=https://rpc.plasma.to \
  --node.batch-poster.post-4844-blobs=false \
  --http.api=net,web3,eth,arb --http.addr=0.0.0.0 --http.vhosts=*
```

`--chain.name` must match `chain-name` (`xgas-plasma`). Parent RPC is Plasma. There is no data availability committee.

Child vault, after the child is up and the two reserve addresses are the ones `calculateL2TokenAddress` returns:

```bash
cd contracts
export DEPLOYER=... OWNER=... KEEPER=... FANOUT_TREASURY=...
export RESERVE_USDT0=<l2Usdt0 from contracts/orbit/deployments/plasma-rollup.json>
export RESERVE_USDC=<l2Usdc from contracts/orbit/deployments/plasma-rollup.json>
forge script script/DeployChildReserves.s.sol --rpc-url <child rpc> --sender "$DEPLOYER"
```

Again, no `--broadcast` until the child RPC is the chain you mean to deploy on.

## License

`contracts/orbit/lib/nitro-contracts` is Offchain Labs nitro-contracts v3.1.1, BUSL-1.1. The token bridge is Apache-2.0. The Arbitrum Expansion Program requires that the parent chain rely on the Ethereum security model, and it takes 10% of net revenue. Plasma is its own L1, not an Ethereum-settled rollup. That is an open legal question, not a conclusion that this launch is licensed.
