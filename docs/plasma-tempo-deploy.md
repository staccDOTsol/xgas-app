# Plasma and Tempo reserve vaults

Single-reserve $xMoney for chains where $xMoney is not the gas token. The Orbit child of Plasma, where XPL is gas and both USDT0 and USDC back the child vault, is [orbit-on-plasma-tempo.md](orbit-on-plasma-tempo.md).

No testnet. No private keys in the repo. `forge script` below does not pass `--broadcast`.

## Assets

| Chain | Chain id | Reserve | Decimals | Source |
| --- | ---: | --- | ---: | --- |
| Plasma | 9745 | USDT0 `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` | 6 | Read on `https://rpc.plasma.to`: name USDT0, symbol USDT0, decimals 6. Transfer of 1000 USDT0 on a fork moved exactly 1000 USDT0. |
| Plasma | 9745 | USDC `0x2d661C89D812261039AF9764eceaAee884f5F67F` | 6 | [Circle's USDC address list](https://developers.circle.com/stablecoins/usdc-contract-addresses). Same RPC: name USDC, symbol USDC, decimals 6. Used by the child vault, not by `DeployPlasma`. |
| Tempo | 4217 | OUSD `0x20c0000000000000000000006a37DA5C996874BE` | 6 | [Tempo's OUSD guide](https://tempo.xyz/developers/docs/guide/ousd). pathUSD (`0x20C0000000000000000000000000000000000000`) is the routing and fallback fee token, not the reserve. |

`XMoneyErc20Vault` reads `decimals()` once and stores `scaleFactor = 10 ** (18 - decimals)`. Both reserves are 6 decimals, so the scale is `1e12`, the same factor USDG uses. A fee-on-transfer reserve mints against the balance that actually stayed in the vault.

Economics, matching `XMoney.enterRollupToL3`: 1 bp of reserve received is raked to the fanout on enter and on exit, 1 bp of the xMoney minted on entry is burned, 1 bp of an ordinary transfer is burned. `ReserveFeeFanout.distribute` sends 2/3 to `ReserveBuyback` and 1/3 to treasury. The buyback enters the vault and sends the minted xMoney to `0xdead`. Nothing in this stack is payable. `FanoutSink` and `XgasDevBuyback` are not reused: the sink's `ArbSys.withdrawEth` (`0x64`) has no code on Plasma, and Tempo's CALLVALUE and BALANCE are always 0.

The owner is a 24 hour `XMoneyTimelock`. The executor role is open (`address(0)`).

## Deploy

Environment variables are addresses, not keys: `DEPLOYER`, `OWNER`, `KEEPER`, `FANOUT_TREASURY`.

Plasma:

```bash
cd contracts
export DEPLOYER=0x1111111111111111111111111111111111111111
export OWNER=0x2222222222222222222222222222222222222222
export KEEPER=0x3333333333333333333333333333333333333333
export FANOUT_TREASURY=0x4444444444444444444444444444444444444444

forge script script/DeployPlasma.s.sol --rpc-url plasma --sender "$DEPLOYER"
```

A real deploy adds `--private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --verify`. Do not add those until you intend to publish. The deployer needs XPL for gas. Verification is Etherscan API v2, chain id 9745 (`PLASMA_ETHERSCAN_API_KEY`). `forge verify-bytecode --chain 9745` can mis-normalize the chain name to `plasma`; prefer `--verifier custom --verifier-url https://api.etherscan.io/v2/api?chainid=9745`.

Tempo (the `tempo` profile is required; TIP-20 precompiles do not execute on the default EVM):

```bash
cd contracts
FOUNDRY_PROFILE=tempo forge script script/DeployTempo.s.sol \
  --rpc-url tempo \
  --sender "$DEPLOYER"
```

A real Tempo deploy also needs `--tempo.fee-token 0x20C0000000000000000000000000000000000000` (pathUSD, the fallback fee token) or OUSD, and `--verifier sourcify --verifier-url https://contracts.tempo.xyz`. Gas for a non-TIP-20 deploy is paid in pathUSD. The deployer needs that fee token, not a native balance.

## Fork results

`forge test --match-contract PlasmaReserveForkTest` against `https://rpc.plasma.to` passes: enter, transfer, exit, fanout rake, buyback, and the timelock. USDT0 whale used on the fork: `0x8741B106e9738a6971AD07DABCFe95FF66337b51`.

Measured inside the Plasma fork test (Cancun, optimizer 200, not counting the 21,000 per-transaction overhead). Five transactions: fanout, timelock, vault, buyback, link.

| Piece | Gas |
| --- | ---: |
| Fanout | 459,970 |
| Timelock | 1,642,899 |
| Vault | 1,508,696 |
| Buyback | 548,799 |
| Link buyback | 48,073 |
| Stack | 4,208,437 |
| enter | 257,769 |
| transfer | 75,512 |
| exit | 102,578 |

At the observed Plasma `eth_gasPrice` of 9,003,180 wei, the stack is about **0.0000379 XPL**. `baseFeePerGas` on that fork was 8 wei; do not multiply by the base fee. 1 XPL funds this deploy many times over at the live price.

```bash
FOUNDRY_PROFILE=tempo EXPECT_TEMPO_VM=true forge test --match-contract TempoReserveForkTest
```

A default `forge test` skips that suite. OUSD is a TIP-20 precompile and `decimals()` raises `OpcodeNotFound` on the default VM, and that error is not catchable, so the suite stays behind `EXPECT_TEMPO_VM`. Under the tempo profile the run at block 44,817,769 (base fee 600,000,000 attodollars) measured:

| Piece | Gas |
| --- | ---: |
| Fanout | 2,759,862 |
| Timelock | 8,971,899 |
| Vault | 8,015,804 |
| Buyback | 3,522,068 |
| Link | 280,273 |
| Stack | 23,549,906 |
| enter | 2,100,377 |
| transfer | 310,612 |
| exit | 347,158 |

Fee units are `ceil(gasPrice * gasUsed / 1e12)` of a 6-decimal stable. At that base fee the stack is about 0.014130 OUSD/pathUSD. At the 12e9 attodollar cap it is about 0.282599. The timelock (~9.0M gas) is under Tempo's 30M transaction cap. OUSD whale: `0x1E3423c85FE006D27091b9482cAa9520c250f4C6`.

Native value on Tempo stays 0. The legacy sink cannot flush, and there is no XPL-style deposit on Tempo. See the Orbit note for why Tempo is not a parent of an XPL-native child.
