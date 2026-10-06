# xGas changelog brief — 2026-10-06 (for the Supercycle bot)

## LIVE
- Withdrawals L4 → Robinhood are automatic. The host executes the Outbox claim itself once the covering assertion confirms. Flow: withdrawEth on L4 → wait for assertion (minutes; fast-confirm 2-of-3 Safe) → X Money ERC-20 lands at your address on Robinhood. No button, no POST.
- Validator 3 added (xgas-l4-val3, sjc). All three fast-confirm Safe owners now run, so exits no longer wait on a single approver.
- XSwap V2 solver is funded and switched on (wallet 0x8796…D2f6). Route: X Money → native ETH on Base, up to 10 X Money per order, 50 per UTC day. Fees: 1 bp X Money transfer burn, 10 bp site fee, 50 bp protocol fee, all taken from the winning solver ask at settlement. 100% solver bond, 30-minute challenge window, 2-minute bidding.

## LANDING (same session)
- MCP: XSwap V2 new orders OPEN. prepare_xswap_out / prepare_xswap_in prepare V2 site-fee orders on intents 0xdf63…d238 / asks 0x2f50…87fc, collector 0x5a5e…d33e. Legacy escrows (5D78/a999, f8B4/0a33) stay exit-only: refund, cancel, settle, withdraw. xswap_terms reports v2.new_orders_open = true.
- xgas.dev copy pass: Enter/Exit box says where money lands ("L4 gas" vs "X Money on Robinhood") and shows withdrawal state in words (pending → claimable → done).

## UNCHANGED, worth repeating to users
- "Enter Rollup → L4" mints X Money straight to the L4 as gas. To hold X Money ERC-20 on Robinhood you withdraw back from the L4. There is no direct mint-to-Robinhood.
- X Money ERC-20 (Robinhood 4663): 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E
- Chain 466302 is the live L4. 466301 is retired, exit-only.
- Still alpha, unaudited. Only amounts you can afford to lose.
