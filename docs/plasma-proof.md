# Plasma proof of the sovereign-unit memo

This file is the on-chain companion to [sovereign-unit-memo.md](sovereign-unit-memo.md). The memo is Jarett's text and is not edited here. This page says which of its claims the Plasma deployment is built to measure, and where the live numbers will go.

The comparison rate is Plasma One Earn at **4.29% APY**. The deposit is the deployer's **1000.428045 USDT0** (`1000428045` base units) on Plasma mainnet, chain 9745.

Nothing in the tables below is a mainnet transaction yet. Cells marked `PENDING` are empty until the broadcast. Fork hashes are rehearsal receipts from anvil. They are not Plasma mainnet, and they are not the yield proof.

## What is already true on Plasma

These are reads of contracts that existed before this deployment. They are not outputs of `./deploy-plasma-mainnet.sh`.

| Item | Value |
| --- | --- |
| Chain | Plasma, chain id 9745, `https://rpc.plasma.to`, explorer `https://plasmascan.to` |
| Deployer | `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158` |
| USDT0 | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` (6 decimals) |
| Circle USDC | `0x2d661C89D812261039AF9764eceaAee884f5F67F` (6 decimals) |
| WXPL | `0x6100E367285b01F48D07953803A2d8dCA5D19873` |
| Deployer USDT0 at the fork rehearsal | 1000.428045 |
| Deployer XPL at the fork rehearsal | 47.211150098866677224 |

The child is an ETH-style Orbit chain. Its gas token is XPL (`nativeToken = address(0)`), not an ERC-20. Provisional child chain id 974502. WASM module root for `offchainlabs/nitro-node:v3.11.4-7d5ac27`, consensus-v61 / ArbOS 61:

`0xc10cd7ec6acaf1c441a3f6bd0900ad20f15855ba775a96f1939118cbc629dc97`

Launch and the parent-chain USDT0 escrow are [orbit-on-plasma-tempo.md](orbit-on-plasma-tempo.md). The vault's $1-per-whole-token reserve rule is [plasma-tempo-deploy.md](plasma-tempo-deploy.md).

## Mainnet record

Fill this table from the broadcast. Until then every hash and every deployed address is a placeholder.

| Record | Mainnet value |
| --- | --- |
| Deploy command | `./deploy-plasma-mainnet.sh` with `PLASMA_DEPLOYER_KEY` set and `WASM_MODULE_ROOT` unset |
| Seed command | `./seed-plasma-usdt0.sh` in the same checkout, after deploy |
| Rollup | `PENDING` |
| Bridge | `PENDING` |
| Inbox | `PENDING` |
| Sequencer inbox | `PENDING` |
| Outbox | `PENDING` |
| Upgrade executor | `PENDING` |
| L1 ERC-20 gateway | `PENDING` |
| L1 gateway router | `PENDING` |
| xMoney vault (Plasma) | `PENDING` |
| Timelock | `PENDING` |
| Fanout | `PENDING` |
| Buyback | `PENDING` |
| `createRollup` tx | `PENDING` |
| Vault deploy tx | `PENDING` |
| USDT0 `approve` tx | `PENDING` |
| USDT0 `outboundTransfer` tx | `PENDING` |
| USDT0 escrowed | `PENDING` — target 1000.428045 |
| Inbox sequence | `PENDING` |
| L2 USDT0 token | `PENDING` — predicted only after the child deployer nonce is known |
| L2 USDT0 balance of the depositor | `PENDING` — credited when the sequencer includes the retryable |
| Child vault | `PENDING` — `DeployChildReserves` after the L2 token has code |
| Child `vault.enter` tx | `PENDING` |
| Activity txs | `PENDING` — script not written |
| Measurement report | `PENDING` — script not written |

Explorer links, once a hash exists: `https://plasmascan.to/tx/PENDING`.

## Fork rehearsal, not the proof

Anvil fork of `https://rpc.plasma.to` on 2026-10-19, `broadcast: anvil-fork` in [deployments/plasma-mainnet.json](../deployments/plasma-mainnet.json) and [deployments/plasma-seed.json](../deployments/plasma-seed.json). Every receipt status was 1. These addresses will not be the mainnet addresses.

| Step | Fork result |
| --- | --- |
| Deploy gas | 84,658,459 (heaviest tx 6,839,679, under the 36,000,000 cap) |
| Deploy XPL at a 0.001 gwei ceiling | 0.000084658459 |
| USDT0 `approve` | `0x3a13d45771d2e46e4db373dda8842e024cb065394e75bb841e24ce69f9060f9a` (53,377 gas) |
| USDT0 `outboundTransfer` of 1000.428045 | `0xe49bc592c9b6625aa8583d422801105795f9e8cb874b6c08db733bd41c919428` (235,865 gas) |
| Gateway USDT0 after the seed | 1000.428045 |
| Deployer USDT0 after the seed | 0 |
| Retryable value locked in the bridge | 100000000093440 wei, refundable on the child |

The seed escrows USDT0 in the L1 gateway and posts a retryable. It does not call `vault.enter`. On the fork there is no child node, so the L2 token was not credited and no yield was measured.

## Claims this proof will test

Each row is a statement in the memo. The measurement is what a later script has to read on the deployed contracts. Status stays `PENDING` until that read has a mainnet tx behind it.

| Memo | Claim | What the proof measures | Status |
| --- | --- | --- | --- |
| §1, §2, §4, appendix | A transfer burn, 1 bp on xgas, retires supply without a committee. | `totalXMoneyBurned` and the `0xdead` balance before and after transfers that are not the depositor's own. | `PENDING` |
| §2, `S* = M / (b × v)` | Supply stops growing where mint equals burn. | xMoney minted by `enter` versus xMoney burned. This deployment has no discretionary mint, so M is only the vault's deposit mint. | `PENDING` |
| §3.4, §5, §6.4 | The burn accrues to holders. §5 prices that, at velocity 12, as 0.12% a year and "no fundamental premium." §6.4 requires the offering to say holder return equals burn times velocity times share, under 1% a year at plausible numbers. | Realized annualized change in NAV per remaining xMoney, and the holder's exit value against the 1000.428045 USDT0 deposited. | `PENDING` |
| §4 reserve policy, appendix r/s | Full reserve: one dollar of reserve per unit, published as r/s. | `getReserveNAV` and the vault's USDT0 and USDC balances. One whole token of any listed USD stable counts as $1 (`10^(18-decimals)`). Enter still rakes 1 bp and burns 1 bp, so the first mint is slightly under one xMoney per dollar that arrived. | `PENDING` |
| §1 levy router, §3.2, §4 | A share of every fee path goes to named accounts. xgas is 1 bp fanout. | Fanout balance, the 2/3 buyback and 1/3 treasury split, and xMoney the buyback sends to `0xdead`. | `PENDING` |
| §4 exemptions, §7 | Bridge-bound transfers are tax-exempt, because the bridge must mint exactly what it receives. | L2 USDT0 credited to the depositor equals 1000.428045. The exemption is on the gas token's bridge path. This seed moves USDT0, which is the reserve, through the standard Orbit gateway. | `PENDING` |
| §4, §7 | Today the vault mints only against deposits. Fee constants are fixed at deploy. | No mint function other than `enter`. Supply increases only when reserve arrives. | `PENDING` |
| §4 upgrade key, §7, appendix | The vault owner is a 24h timelock. The chain-owner key on 466302 upgrades the bridge, inbox, and outbox instantly. Surrendered discretion is the credibility dial. | Vault owner is the timelock from the deploy JSON. Rollup owner is the upgrade executor. Record the delay and whether the executor is open. | `PENDING` |
| §1 public reads | Supply, reserve, burn total, and reserve ratio are readable by anyone. | The measurement JSON below, with tx hashes and `https://plasmascan.to` links. | `PENDING` |

## Scoring the $1000 against 4.29%

The memo's own table is the baseline, not a result this chain has produced. At a 1 bp burn and velocity 12, holder yield is 0.12% a year. That does not beat 4.29%. Matching 4.29% from the 1 bp transfer burn alone needs other people's transfers of about 1.175 times circulating supply per day:

`4.29% / 365 / 0.0001 ≈ 1.175`

A sole depositor who transfers xMoney to themselves pays the burn and receives the NAV increase on what remains. Their claim on the reserve does not grow by that amount. Gas they pay in XPL is a cost. The enter rake leaves the vault, and a buyback that re-enters pays the rake again. For one holder that path is slightly negative.

The report has to show both numbers:

- Gross: annualized change in NAV per remaining xMoney.
- Net: USDT0 received on exit, minus 1000.428045, minus XPL the depositor spent, minus the retryable value still locked if it has not been refunded.

If the activity is funded by the deployer, the report says so and the net is the number that gets compared with 4.29%. Annualizing a few seconds of self-transfers is not that comparison. The activity script and the measurement script are not in the repo yet. Their output replaces the `PENDING` rows. It does not replace the memo.

## What this deployment does not test

The memo's kit is wider than this launch. These claims stay untested here:

- The child's gas token is XPL. The memo's reference chain uses $xMoney itself as gas, so the burn is on the gas token. Here the 1 bp burn is on the vault's xMoney ERC-20. XPL transfers do not burn.
- No chain factory, no per-period mint cap, no deploy-time burn dial. The rates are the constants in `XMoneyMultiReserveVault`.
- No Ethereum-mainnet ERC-20 of the unit, no fund spawner, no Tier 1–4 shelf.
- No sanctions gate, no audit, no tax-acceptance statute.
- Seigniorage, the borrowing-cost channel, and repatriation are not observable from these contracts.
- Tempo is not a parent for this design.

The Arbitrum Expansion Program point in [orbit-on-plasma-tempo.md](orbit-on-plasma-tempo.md) is unchanged: Plasma is its own L1, and the license question is open.
