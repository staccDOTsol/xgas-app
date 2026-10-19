# Sovereign unit kit

A new unit is one file, `config/units/<id>.json`. `./deploy-unit.sh` reads it and deploys a chain whose gas token is that unit. No contract edit. The design brief is [sovereign-unit-memo.md](sovereign-unit-memo.md). This page is the operator steps. It does not replace the memo.

Every unit this deployer accepts is pegged 1 whole token = 1 USD, backed in full by the reserve list. USDT0 and USDC are the Plasma reserves in the first file. Another USD stable is another address in that list. A peg other than USD, a ratio other than 1, a partial reserve, or a fee other than 1 bp is rejected. Those dials are in the memo. The contracts still use the xgas constants.

## This is not the XPL-native broadcast

The open Plasma mainnet path keeps the parent's native coin, XPL, as the child gas token. Its commands are unchanged:

```bash
unset WASM_MODULE_ROOT
export PLASMA_DEPLOYER_KEY=...
./deploy-plasma-mainnet.sh
./seed-plasma-usdt0.sh
```

That chain id is 974502. Run those two, in that order, from a checkout of this branch. `./deploy-unit.sh` is a different chain. Do not substitute it for the broadcast above.

## First instance

[config/units/xmoney-plasma.json](../config/units/xmoney-plasma.json) is xMoney on Plasma.

| Field | Value |
| --- | --- |
| Name, symbol | X Money, xMoney, 18 decimals |
| Peg | 1 unit = 1 USD, full reserve |
| Reserves | Plasma USDT0 `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb`, Circle USDC `0x2d661C89D812261039AF9764eceaAee884f5F67F` |
| Fees | 1 bp transfer burn, 1 bp entry burn, 1 bp reserve rake |
| Parent | Plasma 9745, `https://rpc.plasma.to` |
| Child chain id | 974503, name `xmoney-plasma`. Provisional, and deliberately not 974502 |
| Gas token | `unit` — the vault this script deploys |
| Stake token | WXPL `0x6100E367285b01F48D07953803A2d8dCA5D19873` |
| WASM / ArbOS | consensus-v61 root `0xc10cd7ec6acaf1c441a3f6bd0900ad20f15855ba775a96f1939118cbc629dc97`, InitialArbOSVersion 61 |

The vault prices each reserve at $1 per whole token: `balance * 10^(18 - decimals)`. Decimals above 18 are rejected. The file's `decimals` for a reserve is checked against the token on the parent.

## Add a unit

1. Copy `config/units/xmoney-plasma.json` to `config/units/<id>.json`.
2. Set `id`, `unit.name`, and `unit.symbol`.
3. Set `chain.chainId` to a free id and `chain.chainName` to a new name. Do not reuse 974502 or 974503.
4. Replace `reserves` with the USD stables on the parent you are deploying to. Each entry is `symbol`, `address`, and `decimals`. The tokens must already have code there.
5. Leave `peg` at `USD` / `1` / `full`, `feesBps` at 1, `unit.decimals` at 18, and `chain.gasToken` at `unit`. Leave `wasmModuleRoot` and `initialArbOSVersion` unless the nitro image changes, and then change them together.
6. Point `chain.parentChainId`, `chain.parentRpc`, and `chain.stakeToken` at that parent. On Plasma the stake token is WXPL.
7. Rehearse, then broadcast:

```bash
# fork, no key
PLASMA_FORK_URL=http://127.0.0.1:8545 ./deploy-unit.sh config/units/<id>.json

# broadcast, when this chain is the one you mean
export DEPLOYER_KEY=...
./deploy-unit.sh config/units/<id>.json
```

The script deploys the vault, the fanout, the 24-hour timelock, and the buyback. It then deploys the Orbit rollup with `nativeToken` set to that vault, so the ERC-20 bridge templates are the ones that get used. It marks the inbox and the bridge as tax-exempt on the vault and transfers the vault to the timelock. Bridge transfers of the gas token have to be exempt: the inbox pulls the amount it was told, and a 1 bp burn on that pull would leave the bridge short. That exemption is the memo's bridge rule, applied to this token.

`deployFactoriesToL2` stays false, same as the XPL launch. A canonical CREATE2 factory on the child is a separate funding step. There is no AnyTrust fast confirmer. Batch posting is calldata. The node image is `offchainlabs/nitro-node:v3.11.4-7d5ac27` with `--node.batch-poster.post-4844-blobs=false`. Fill `contracts/orbit/node/chain-info-974502.json`'s sibling for this chain id from `deployments/units/<id>.json` after the broadcast. The committed copy of that file is a fork rehearsal, not mainnet.

## Fork rehearsal, 2026-10-19

Anvil fork of Plasma. `broadcast` in [deployments/units/xmoney-plasma.json](../deployments/units/xmoney-plasma.json) is `anvil-fork`. These addresses are not mainnet.

| Step | Result |
| --- | --- |
| Vault, timelock, fanout, buyback | 4,201,169 gas, symbol `xMoney` |
| Rollup with that vault as gas token | 72,792,979 gas, heaviest tx 6,915,960, under 36,000,000 |
| Bridge `nativeToken()` | the vault |
| Inbox marked tax-exempt, vault owner | the 24-hour timelock |

## What a new file does not yet do

The memo's fund spawner, a mint cap, a burn rate other than 1 bp, a peg other than 1 USD, and an Ethereum ERC-20 of the unit are not in this deployer. Reserve deposits onto the child still need the custom-fee token gateway. This script's vault holds the parent-chain reserves directly. The child node, the batch poster, and the $1000 USDT0 yield measurement against 4.29% are the XPL-native path in [plasma-proof.md](plasma-proof.md), not this command.
