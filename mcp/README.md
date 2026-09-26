# xgas-mcp

An MCP server over the xGas stack: the USDG vault bridge on Robinhood Chain (4663),
the P2P OTC desk and NGU curves on xGas Orbit L4 (466301), a teller layer that routes
between dollars and $xMoney, and XSwap: X Money in, anything on any EVM chain out, and the other way round.

52 tools, all grounded in a deployment file and the live chains. Over stdio you get all 52.
The hosted endpoint at `/mcp` serves 48 to anyone and 51 to a caller signed in with X (never
`claim_exit`, which spends the host's own gas); the site's `/api/connector` serves 42 to an
anonymous browser and the same 51 to a signed-in one. `GET https://xgas.dev/api/mcp` returns these
counts live from the registry, so trust it over this paragraph if they ever differ.

By default nothing is custodial: the connector prepares transactions and your own wallet signs
them. The three `wallet_*` tools are the one exception. They do nothing until Privy is configured,
and the wallet they drive is custodial: the host signs for it with `PRIVY_APP_SECRET`.

## Use it without cloning

Hosted, no install: point a host at the remote server.

```
https://xgas.dev/mcp
```

Or run it locally over stdio:

```bash
npx -y xgas-mcp
```

## Run it

```bash
npm install
npm start          # stdio
npm run check      # smoke test over real MCP stdio, against the live chains
npm run e2e        # a whole X Money swap on an anvil fork: open, bid, accept, claim, confirm, withdraw
```

Host config:

```json
{
  "mcpServers": {
    "xgas": { "command": "npx", "args": ["-y", "xgas-mcp"] }
  }
}
```

Environment overrides, all optional:

| Variable | Default | Use |
|---|---|---|
| `XGAS_DEPLOYMENT` | `../src/contracts/l4-deployment.json` | point at another deployment file |
| `XGAS_PARENT_RPC` | `parentRpcUrl` from the deployment | parent chain RPC |
| `XGAS_RPC` | `publicRpcUrl` from the deployment | xGas L4 RPC |
| `XGAS_API` | `https://xgas.dev` | the host that runs the Outbox executor and serves `/api/l4-info` |
| `XGAS_NGU_LAUNCHER` | unset | the NguLauncher address, until it is in the deployment file |
| `XGAS_MCP_DATA` | `/data` or `~/.xgas-mcp` | where idempotency keys and ramp state live |
| `XSWAP_INTENTS` | `0xf8B4…9a35` | the X-Money-in escrow on the parent chain |
| `XSWAP_ASKS` | `0x0a33…Cd13` | the X-Money-out escrow on the parent chain |

## XSwap: X Money in, anything out

`quote_xswap` and `prepare_xswap_out` escrow X Money against an order (chain, asset, amount, recipient) hashed the way every solver hashes it. Solvers bid the price down,
the lowest ask wins, and whatever the bidding saves comes back to the payer as credit.
`prepare_xswap_in` is the other direction: an ask is a price, not an escrow, and the
buyer's X Money is held before the seller sends anything.

Solving is permissionless. There is no allow-list: `prepare_xswap_action` will prepare a
bid and a claim for any address, the bond is the permission, and losing a dispute is the
cost. `xswap_reputation` is only ever the sum of finished jobs, and it says "new here"
rather than pretending a number it does not have.

The connector cannot see the destination chain. It never claims an asset arrived; the
challenge window and the bond are what stand in for that.

## Design rules

**Non-custodial by default.** Every write comes back as an unsigned transaction
envelope; `submit_*` is a relay for an already-signed payload. Two keys sit on the host,
and neither is yours:

- the Privy app secret behind the opt-in agent wallet (below), which makes that wallet custodial;
- `L3_EXECUTOR_KEY`. The host uses it to execute already-claimable Outbox withdrawals for
  users (a permissionless call; it just pays the gas) and as the XGAS.DEV buyback keeper. It is
  also the chain owner key: it holds `EXECUTOR_ROLE` on the UpgradeExecutor, so it can upgrade
  and reconfigure the rollup. It is an admin key, not a narrow executor key.

**Quote, review, approve, submit.** Each `prepare_*` returns the approval screen
a non-custodial connector owes you: exact action, asset, amount, counterparty (address and X
handle where known), every fee with the net, the finality timeline, and what cannot
be undone. Nothing auto-approves.

**Idempotency.** Every `submit_*` takes a key. A repeat returns the first hash
instead of sending a second transaction.

**Reads are free.** Balances, NAV, quotes, the order book and withdrawal status
need no approval and no signature.

**Dead ends are answers.** An empty order book, a sold-out curve, a warp route that
was never deployed: each comes back as a stated result with the recourse, never as
a silent failure or an invented number.

**The fiat leg is instructions, not a transaction.** OTC dollar payments happen
between X handles on X Money. The connector watches the escrow and says so; it
never claims the money moved.

## Tool surface

**Chain and account:** `get_chain_info`, `get_balance`, `get_vault_nav`, `get_fee_schedule`

**Bridge in (USDG → $xMoney):** `quote_enter`, `prepare_enter`, `submit_enter`, `get_enter_status`

**Bridge out ($xMoney → USDG):** `quote_exit`, `prepare_exit`, `submit_exit`,
`get_exit_status`, `claim_exit`, `prepare_redeem`, `submit_redeem`

**OTC desk:** `list_orders`, `get_order`, `get_trade`, `quote_trade`, `post_ask`,
`post_bid`, `take_ask`, `take_bid`, `release_trade`, `reclaim_timeout`,
`cancel_order`, `submit_otc`

**NGU curves:** `list_ngu_tokens`, `get_ngu_token`, `quote_ngu_buy`,
`prepare_ngu_buy`, `quote_ngu_sell`, `prepare_ngu_sell`, `prepare_ngu_donate`,
`launch_ngu_token`, `submit_ngu`

**Ramps:** `ramp_quote`, `ramp_start`, `ramp_status`

**XSwap:** `xswap_chains`, `xswap_terms`, `quote_xswap`, `prepare_xswap_out`,
`prepare_xswap_in`, `xswap_status`, `list_my_xswaps`, `xswap_reputation`,
`prepare_xswap_action`, `submit_xswap`

**Agent wallet (opt-in, custodial):** `wallet_status`, `wallet_create`, `wallet_execute`

## Things the chain taught us, that the spec had wrong

- **The deployed vault is older than `contracts/src/XMoney.sol`.** `0xa924…a97E`
  has no `enterRollupToL3`, `setL4RetryableParams`, `l4GasLimit`, `l4MaxFeePerGas`
  or `totalXMoneyBridgedToL4`. The connector exposes only what the bytecode
  actually has, and reads the lifetime counters tolerantly.
- **Exiting costs more than the exit rake.** The Outbox pays out of the Bridge,
  which is a transfer *out* of the bridge system, so the 0.01% xMoney tax applies
  on top of the 0.01% USDG rake. `quote_exit` charges both.
- **`NguToken.buy` refunds overpayment.** The spec said it refunds nothing.
  `prepare_ngu_buy` therefore sends a small buffer (default 1%) so a buyer who gets
  front-run by one curve step does not revert with `Underpaid`.
- **`src/contracts/nguAbis.ts` declared `basePrice` as `uint16`.** Reading it threw
  "not in safe integer range" against a real 1e16 price. Fixed to `uint256`.

## Verification

`npm run check` exercises the real MCP stdio transport against both live chains.

The NGU tools have no launcher on xGas yet, so they were verified against a local
anvil at chain id 466301 with a real `NguLauncher` and curve: buy with buffer,
sell with `minOut`, donate, and an idempotent replay. `scripts/ngu-roundtrip.mjs`
reruns that; its header has the setup commands. The predicted post-donation floor
matched the chain exactly, and the sell basis correctly flipped from `floor` to
`lastPrice` once the donation lifted the floor above the last paid price.

## Status

All three items the spec left open are closed.

1. **Wallet connection.** `server.js` serves the read and prepare tools at
   `GET /api/connector` and `POST /api/connector/:tool`. An anonymous browser gets
   42 of the 52: every `submit_*`, `claim_exit` and `wallet_*` is refused with 403,
   because the browser sends through the wallet. A caller signed in with X gets 51,
   everything but `claim_exit`. `web3Client.ts` gained `callConnector`, `isEnvelope` and
   `executeEnvelope`, which walks a prepared envelope through the existing
   `sendOnChainTx` one step at a time, waiting for each. The site and the connector now
   share one source of truth for quotes, fees and approval copy.
2. **Exit ETAs.** `quote_exit`, `prepare_exit` and `get_exit_status` read
   `confirmPeriodBlocks` off the rollup and measure the parent's cadence over the
   last 1000 blocks, rather than hardcoding either. They state the caveat that the
   window starts at the assertion covering the withdrawal, not at the withdrawal.
3. **NguLauncher** is deployed at `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B`
   and set in `l4.nguLauncher`; its curves pay 0.04% (0.01% burn + 0.01%
   FanoutSink + 0.02% XGAS.DEV buyback). The first launcher,
   `0xEA2cE320B5CDbF14bc734FeB60c78097e146f1B0` (block 35), is kept in
   `l4.legacy2bp.nguLauncher`: its curves predate the buyback and keep 0.01% +
   0.01% forever. `list_ngu_tokens` lists both (current first); launches only go
   through the current one. The NGU tools read `BUYBACK_BPS()` per token and treat
   a revert as no buyback.

## The agent wallet (optional, and custodial)

An agent has no browser and no wallet, so `prepare_*` on its own is a dead end for one. Set
`PRIVY_APP_ID` and `PRIVY_APP_SECRET` and three more tools appear:

- `wallet_status` : the address it signs as, and what it holds on both chains
- `wallet_create` : make the wallet once, then fund it
- `wallet_execute` : run any `prepare_*` tool and actually send it, with `confirm: true` and an idempotency key

Privy signs; this connector broadcasts (Privy's own RPC has never heard of chain 466301).
Privy signs whenever this host asks with `PRIVY_APP_SECRET`, so whoever runs the host can sign
for every wallet it has made. That is what custodial means here, and it is why the wallet is
opt-in. Everything else in this connector stays unsigned until your own wallet signs it.

Over stdio there is one caller and it gets one wallet. Over HTTP there are as many callers as
there are people signed in, and each gets their own: the X sign-in is the gate, the wallet is
filed under that X id, and no tool can reach anyone else's. Signed out, the HTTP surface is
reads and prepares only. `MCP_AUTH_TOKEN` is for our own tooling, not for users.

A model has no cookie, so a signed-in person can mint a connector token (`POST /api/connector/token`)
and hand it to their own host as `Authorization: Bearer <token>`. It carries only their X id, lasts
180 days, and can be revoked: `POST /api/connector/revoke` while signed in with X (or the button on
the site) kills every token that person has minted, at once.

| Variable | Use |
|---|---|
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | turn the wallet tools on |
| `PRIVY_WALLET_ID`, `PRIVY_WALLET_ADDRESS` | pin a specific wallet instead of the local store |
| `MCP_AUTH_TOKEN` | operator token for our own tooling; users use their X sign-in instead |
