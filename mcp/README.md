# xgas-mcp

> **Warning: highly alpha, untested, unaudited software.** The contracts behind these tools can have bugs and funds can be lost. Only use what you can afford to lose.

An MCP server over the xGas stack: the USDG vault bridge on Robinhood Chain (4663),
the P2P OTC desk and NGU curves on xGas Orbit L4 (466302, rollup mode), a teller layer that routes
between dollars and $xMoney, and XSwap: X Money in, anything on any EVM chain out, and the other way round.

53 tools, all grounded in a deployment file and the live chains. Over stdio you get all 53.
The hosted endpoint at `/mcp` serves 48 to anyone and 52 to a caller signed in with X (never
`claim_exit`, which spends the host's own gas); the site's `/api/connector` serves 42 to an
anonymous browser and the same 52 to a signed-in one. `GET https://xgas.dev/api/mcp` returns these
counts live from the registry, so trust it over this paragraph if they ever differ.

By default nothing is custodial: the connector prepares transactions and your own wallet signs
them. The four `wallet_*` tools are the one exception. They do nothing until Privy is configured,
and the wallet they drive is custodial: the host signs for it with `PRIVY_APP_SECRET`. What an agent
can send from it on its own is capped and allowlisted by the host (see "The agent wallet" below).

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
| `XGAS_DEPOSITS_PAUSED` | unset (deposits open, through EarlyDepositor or the vault) | set to `1` to make `prepare_enter` and `submit_enter` refuse |
| `XGAS_MCP_DATA` | `/data` or `~/.xgas-mcp` | where idempotency keys and ramp state live |
| `XSWAP_INTENTS` | `xswap.intents` from the deployment, else v1 `0xf8B4…9a35` (paused) | the X-Money-in escrow on the parent chain |
| `XSWAP_ASKS` | `xswap.asks` from the deployment, else v1 `0x0a33…Cd13` (paused) | the X-Money-out escrow on the parent chain |
| `XSWAP_ENABLED` | ignored for the known legacy escrows | A host flag cannot re-enable fee-free legacy funding. V2 new orders are a source gate (`XSWAP_V2.enabled`), open since 0.6.3. |
| `XSWAP_OWNER` | `xswap.owner` from the deployment | the owner new swaps require `owner()` to equal on both escrows |

## Chain 466302

xGas relaunched as an Arbitrum Orbit chain in rollup mode: every batch is posted to Robinhood
Chain, and there is no data availability committee. The retired chain 466301 takes no deposits;
its exits and Outbox claims keep working, and the deployment file keeps its addresses under
`legacy466301`.

- **Exits and the fast confirmer.** The fast confirmer is a Safe whose owners are the validator
  keys (`fastConfirmSafe` in the deployment file). `quote_exit` reads its owners and threshold
  live and says what that means: while enough of those keys are online a withdrawal is usually
  claimable minutes after the assertion that covers it, and any threshold of them can confirm any
  assertion, including a wrong one. A confirmed assertion is final. The chain owner key can also
  upgrade the rollup and force-confirm.
- **Validation is permissionless.** The validator whitelist is disabled. Anyone who runs a node
  and posts the stake can assert and challenge. If the xGas validators stop, exits do not depend
  on them, but they then wait the full challenge window.
- **Deposits go through EarlyDepositor until the vault switch.** The XMoney vault
  (`0xa924…a97E`) still points `enterRollup` at the retired 466301 inbox until its timelocked
  `setBridgeSystem` executes (executable 2026-09-27 08:33Z). Every enter tool reads
  `vault.inbox()` live:
  - while it is not this chain's inbox (`0xa708…8146`), `prepare_enter` builds
    `USDG.approve(EarlyDepositor, exact amount)` then `EarlyDepositor.deposit(amount, recipient)`.
    EarlyDepositor (`l3.earlyDepositor`, `0x36e5…4d431`; no owner, holds nothing between calls)
    mints from the vault with `enterRollupToL2`, sends the $xMoney to the 466302 inbox and opens one
    retryable to the recipient. `quote_enter` charges what that costs: the 0.01% USDG rake, the
    0.01% entry burn, the 0.01% xMoney transfer tax on the helper-to-inbox transfer (the new inbox
    is not tax-exempt until the switch), and the L3 gas for the auto-redeem. It quotes a
    guaranteed minimum (the ticket's call value) and an estimate (the deposit minus about 21.2k gas
    at the current L3 base fee, since unused gas is refunded to the recipient).
  - once it is, `prepare_enter` builds `USDG.approve(vault)` then `vault.enterRollup(amount, recipient)`,
    with no transfer tax.
  - if neither route can be shown to reach 466302, nothing is prepared.
  The approve is for the exact amount and is skipped when the allowance already covers it.
  `get_enter_status` reads both an `EarlyDeposit` and a `RollupEntered`.
- **The EIP-7702 alias warning.** Do not deposit by calling `inbox.depositERC20` directly from a
  smart account, from an EIP-7702 delegated EOA, or through a relayer or bundler: when the caller
  has code or is not `tx.origin`, the Inbox credits the *aliased* address (yours plus
  `0x1111000000000000000000000000000000001111`), which your key does not control on xGas. Both
  routes above name the recipient explicitly, so the deposit lands at the recipient. The recipient
  must be an EOA or an EIP-7702 delegated EOA: EarlyDepositor rejects any other contract
  (`RecipientIsContract`), because a Safe or similar address has no key on xGas, and
  `prepare_enter` refuses one before you sign. EarlyDepositor also leaves the ticket's refund
  addresses unaliased, so a 7702 recipient gets its gas refund too. Through the vault a 7702
  recipient's refund goes to the aliased address, and the approval screen says so.
- **RPC chain check.** On start (stdio and hosted) the connector reads `eth_chainId` from the
  configured xGas RPC and parent RPC. If either is not the deployment's chain (466302, parent
  4663), it logs loudly and every write tool (`prepare_*`, `submit_*`, OTC and NGU writes,
  `claim_exit`, `ramp_start`, `wallet_execute`) refuses with the reason. Read tools keep working
  so the problem can be seen. An unreachable RPC also blocks writes and is re-checked after 15 s.
- **L4 contracts.** Anything missing from `l4.*` is reported by `get_chain_info`, and every
  `prepare_*` refuses to build a transaction with no target rather than hand a wallet a contract
  creation.

## XSwap: X Money in, anything out

**V2 transition (October 2026):** The reviewed Robinhood V2 collector is `0x5a5e18e5003d75f9705252b2c3436c1b61e6d33e`; its intents and asks escrows are `0xdf6398ff5a694a03d85a614812490143c4e5d238` and `0x2f507a18043002d8f5d6d3022efd6265be7a87fc`. The connector verifies their runtime hashes, owner, collector link and live terms before a V2 preparation. **New V2 orders are open since 2026-10-06**: `prepare_xswap_out` and `prepare_xswap_in` prepare V2 site-fee orders (10 bp of the winning solver ask, charged only at settlement), and `prepare_xswap_action` bids, claims, accepts and delivers on them. The solver network fills X Money → native ETH on Base today (10 X Money per order, 50 per UTC day); other routes wait for a solver to bid and refund after the deadline if none does. The gate is `XSWAP_V2.enabled` in `src/config.mjs`, opened after the V2 solver review and the fork lifecycle run (`npm run e2e:v2`). The current 5D/a999 and retired f8/0a escrows remain readable; refund, cancel, settle, confirm and per-contract withdrawal can be prepared for existing orders. Legacy open, ask, bid and claim transactions, including approval to a legacy escrow through `submit_xswap`, are refused. `quote_xswap` now treats its entered X Money amount as the gross wallet debit cap and shows the 1 bp transfer burn, 10 bp site fee and 50 bp protocol fee. `prepare_xswap_action action=withdraw` accepts `contract` to pull credit from a specific known escrow.

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

### Paused: nobody can resolve a dispute on the v1 contracts

The v1 escrows on Robinhood (intents `0xf8B4F14eF9A08e334CA9fc026C6e5E9a79B39a35`, asks
`0x0a33001A28A82d50ECC5c166dd5DCb8f5efaCd13`, and an earlier intents
`0x3d4428cB247792e9183332c95A6A3C37b89E8301`) all have `owner()` =
`0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38`. That is forge-std's `DEFAULT_SENDER`,
derived from the string "foundry default caller", and no one holds a key for it. The deploy
script (nft-range `script/DeployXSwap.s.sol`) did this:

```solidity
address owner = vm.envOr("PROTOCOL_OWNER", msg.sender); // read BEFORE broadcasting
vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
new XSwapIntents(xmoney, owner, treasury);
```

`PROTOCOL_OWNER` was unset and no `--sender` was passed, so `msg.sender` inside `run()` was the
default sender. The key `0x26E8…5158` paid for the deploys (txs `0x7c335d0e…`, `0x33b3293d…`),
but the default sender became the owner. So `resolve()`, `setParams()` and `transferOwnership()`
can never be called there: a disputed swap would stay frozen forever, escrow and bond both.
Both contracts held 0 xMoney and 0 ETH when this was found.

While the connector points at those addresses:

- `prepare_xswap_out`, `prepare_xswap_in`, and `prepare_xswap_action` with `bid`, `claim`,
  `accept` or `delivered` refuse with the reason. `wallet_execute` goes through the same
  handlers, so it refuses too, and `submit_xswap` will not relay a signed `open`, `ask`, `bid`,
  `claim`, `accept` or `delivered` to a v1 address or to a paused escrow.
- `xswap_terms`, `quote_xswap` (marked as a quote only), `xswap_status`, `list_my_xswaps`,
  `xswap_reputation`, and the ways out (`refund`, `cancel`, `settle`, `confirm`, `withdraw`) keep
  working. `dispute` still prepares, but on a contract nobody can rule on it is not listed as a way
  out anywhere: `xswap_terms`, every refusal and the dispute screen say it freezes the escrow and the
  bond for good (its only effect is that the other side is never paid).
- `xswap_terms` reads `owner()` live and says who resolves disputes: nobody (and why), a Safe
  (threshold and signers), or one key, plus any pending handover. Once there is an owner it lists
  what that owner can do (rule on a disputed swap, and only that swap's money; `setParams` within
  the contract's bounds; a two-step handover on the redeploy) and what it cannot (touch any other
  swap, anyone's credit, pause, upgrade, renounce), and that parameter changes reach swaps already
  in flight.
- `list_my_xswaps` no longer passes a swap's memo through. It keeps the five order fields,
  type-checked, and says whether they hash to the on-chain want/give hash.

### Redeploy and switch on

`contracts/script/DeployXSwap.s.sol` deploys `contracts/src/xswap/` with an owner someone can
sign for. `OWNER` is required and never defaults to `msg.sender`; the script refuses
`address(0)` and the default sender, accepts the broadcasting key itself, a Safe (it must answer
`getThreshold()` / `getOwners()`), or another EOA typed twice (`OWNER_CONFIRM`), and reads
`owner()` back after deploying. The deployer is always `vm.addr(PRIVATE_KEY)`: `deploy()` takes no
deployer argument (it used to, and passing one equal to `OWNER` skipped the `OWNER_CONFIRM` guard).
Recommended owner: a Safe, else the founder wallet `0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158`
broadcasting from its own key.

The source is v1 with two changes. xMoney burns 1 bp of every transfer, and v1 booked the amount
sent instead of the amount that arrived, so it owed more than it held and the last withdrawal
would revert. The redeploy books what arrives. And ownership is `Ownable2Step` with
`renounceOwnership()` disabled: `transferOwnership(new)` only names a pending owner, which takes over
when it calls `acceptOwnership()`. A mistyped address, or a Safe that only exists on another chain,
can never accept, so the old owner keeps ruling instead of nobody. Moving to a Safe later is
`transferOwnership(safe)` on both contracts, then `acceptOwnership()` from the Safe on both. `contracts/test/XSwap.fork.t.sol` runs on a
Robinhood fork (real xMoney): the v1 owner is the default sender, the script's owner checks,
`resolve` works for the owner and reverts for everyone else on both contracts, and every
account that is owed can withdraw.

```bash
cd contracts
forge test --match-path test/XSwap.fork.t.sol          # FORK_URL defaults to the Robinhood RPC
# dry run: simulates against the chain, sends nothing
OWNER=0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158 PRIVATE_KEY=... \
  forge script script/DeployXSwap.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com
# then the same with --broadcast
```

The script prints an `xswap` block. Put it in `src/contracts/l4-deployment.json` (and so in the
package's `deployment.json` at the next release). The connector reads `xswap.intents`,
`xswap.asks` and `xswap.owner` from it. New swaps stay off until `XSWAP_ENABLED=1` on the host,
or `"enabled": true` in that block, and only with an expected owner configured (`xswap.owner` or
`XSWAP_OWNER`; without one XSwap stays off). Each new swap then checks `owner()` on both escrows:
it must be a key or a working Safe (a contract that does not answer like one is refused, as the
deploy script refuses it), never the default sender or zero, and it must match that owner.

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

**Agent wallet (opt-in, custodial):** `wallet_status`, `wallet_create`, `wallet_execute`,
`wallet_approval_status`

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

`npm test` runs the agent wallet tests offline: the caps, the allowlist, approval expiry and single use,
and that `confirm: true` alone no longer sends anything over the cap or off the allowlist.

`npm run check:deployment` checks the app's deployment file, and `prepublishOnly` runs the same
check on the copy it packs. It exits non-zero on the wrong chain id, a missing core address, any
null or empty `l4.*` app address, a missing `l3.earlyDepositor`, or a `_placeholders` key anywhere
in the file. `ALLOW_PLACEHOLDERS=1` turns the last three into warnings, for a local look at a chain
that is still being deployed; never publish with it.

The NGU tools have no launcher on xGas yet, so they were verified against a local
anvil at the xGas chain id (466302 now) with a real `NguLauncher` and curve: buy with buffer,
sell with `minOut`, donate, and an idempotent replay. `scripts/ngu-roundtrip.mjs`
reruns that; its header has the setup commands. The predicted post-donation floor
matched the chain exactly, and the sell basis correctly flipped from `floor` to
`lastPrice` once the donation lifted the floor above the last paid price.

## Status

All three items the spec left open are closed.

1. **Wallet connection.** `server.js` serves the read and prepare tools at
   `GET /api/connector` and `POST /api/connector/:tool`. An anonymous browser gets
   42 of the 53: every `submit_*`, `claim_exit` and `wallet_*` is refused with 403,
   because the browser sends through the wallet. A caller signed in with X gets 52,
   everything but `claim_exit`. `web3Client.ts` gained `callConnector`, `isEnvelope` and
   `executeEnvelope`, which walks a prepared envelope through the existing
   `sendOnChainTx` one step at a time, waiting for each. The site and the connector now
   share one source of truth for quotes, fees and approval copy.
2. **Exit ETAs.** `quote_exit`, `prepare_exit` and `get_exit_status` read
   `confirmPeriodBlocks` off the rollup (counted in Ethereum blocks), the fast confirmer
   and, when it is a Safe, its owners and threshold, rather than hardcoding any of it.
   They state the caveat that the window starts at the assertion covering the withdrawal,
   not at the withdrawal, and what the fast path trusts.
3. **NguLauncher** is read from `l4.nguLauncher`. On the retired chain 466301 it was
   `0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B`; on 466302 it is redeployed with the
   other L4 contracts, and until the deployment file carries it the NGU tools say it is
   not deployed. Its curves pay 0.04% (0.01% burn + 0.01%
   FanoutSink + 0.02% XGAS.DEV buyback). The first launcher,
   `0xEA2cE320B5CDbF14bc734FeB60c78097e146f1B0` (block 35), is kept in
   `l4.legacy2bp.nguLauncher`: its curves predate the buyback and keep 0.01% +
   0.01% forever. `list_ngu_tokens` lists both (current first); launches only go
   through the current one. The NGU tools read `BUYBACK_BPS()` per token and treat
   a revert as no buyback.

## The agent wallet (optional, and custodial)

An agent has no browser and no wallet, so `prepare_*` on its own is a dead end for one. Set
`PRIVY_APP_ID` and `PRIVY_APP_SECRET` and four more tools appear:

- `wallet_status` : the address it signs as, what it holds on both chains, and its spending policy
- `wallet_create` : make the wallet once, then fund it
- `wallet_execute` : run any `prepare_*` tool and send it, with `confirm: true` and an idempotency key, inside the policy below
- `wallet_approval_status` : follow an approval link `wallet_execute` returned

Privy signs; this connector broadcasts (Privy's own RPC has never heard of chain 466302).
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

### What an agent can send on its own

`confirm: true` is set by the model, so it is not a safeguard. The host enforces a policy the model
cannot change (`src/walletPolicy.mjs`). `wallet_execute` decodes every prepared step and sends at once
only when all of these hold:

- every step goes to an xgas contract from the deployment file, per chain: the vault ($xMoney ERC-20),
  USDG, EarlyDepositor, the Robinhood OTC desk and its arbitration on Robinhood; ArbSys (the exit),
  the OTC escrow, router, FOMO, NGU launcher and the XGAS.DEV paymaster on the L4. Or to the wallet
  itself;
- on NGU curves, which anyone can launch: buys only on curves this wallet launched (the launcher's
  `NguLaunched` log names it as creator), and sells of tokens it holds back to any curve (the payout
  lands here). A buy on someone else's curve is labelled "third-party curve" and needs a person,
  unless the host sets `XGAS_WALLET_MAX_THIRD_PARTY_NGU_USD`. A `donate` always needs a person: it is a
  gift. So does a launch that sends a seed with no seed tokens, which `launch_ngu_token` also refuses;
- every recipient or spender inside the calldata is the wallet itself or an allowlisted contract, and
  every call is one the policy can read and value (anything else, including XSwap, needs a person);
- the value it moves, native value plus the token amounts in the calldata, priced live (USDG at $1,
  $xMoney at the vault NAV but never under $1, ETH at the host's exchange median, NGU tokens at their
  sell-back quote), is within `XGAS_WALLET_MAX_TX_USD`, and within `XGAS_WALLET_MAX_DAY_USD` together
  with what the wallet moved in the last 24 hours. An approve and the call that spends it count once;
- it is not `release_trade`, which hands escrow to a buyer on the strength of a fiat payment only a
  person can check (unless `XGAS_WALLET_AUTO_RELEASE=1`).

Anything else comes back as a link, `https://xgas.dev/approve/<id>`, with nothing sent. It expires
after 10 minutes and works once. Only the wallet's owner can open it, signed in with X in a browser:
the session cookie, never a connector token, so the model that filed the request cannot approve it.
The page shows the decoded steps, every destination, the amounts, the USD they count as and the fees;
on approval the host sends exactly those stored steps and `wallet_approval_status` reports the hashes.
Its headlines are built from the decoded calls only (function, destination, USD); the step labels and the
request title come from the agent's tool arguments, so they appear only as quoted text marked "written by
your agent, not checked".

An idempotency key is claimed before anything is awaited and recorded as executing before the first
signature, so a parallel call or a retry with the same key is told it is in progress and never sends a
second time; a key left executing by a crash stays blocked until someone checks the chain. Every send
from one wallet, direct or approved, runs one at a time, and each spend reservation settles only itself.
Over stdio there is no page, so a request outside the policy is refused with the reasons; the operator
can raise the caps in the environment, or sign it with their own wallet through the plain `prepare_*` tool.

Third-party text in tool results (X handles on the order book, NGU names and symbols) arrives with
control and invisible characters stripped, capped, and wrapped in «», with a note that it is data and
not instructions. The server instructions tell models the same.

| Variable | Use |
|---|---|
| `XGAS_WALLET_MAX_TX_USD` | per-execution cap for sending without approval, USD (default 25) |
| `XGAS_WALLET_MAX_DAY_USD` | rolling 24-hour cap per wallet, USD (default 100; approved sends count toward it too) |
| `XGAS_WALLET_APPROVE_ALL` | `1`: every agent wallet transaction needs the owner's approval |
| `XGAS_WALLET_AUTO_RELEASE` | `1`: let `release_trade` run inside the caps without approval |
| `XGAS_WALLET_MAX_THIRD_PARTY_NGU_USD` | per-transaction cap for buys on NGU curves this wallet did not launch (default 0: always ask) |
| `XGAS_WALLET_APPROVAL_TTL_S` | approval link lifetime in seconds (default 600, 60 to 1800) |
| `XGAS_WALLET_OPERATOR_X_ID` | X user id allowed to approve for the operator wallet on the hosted page |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | turn the wallet tools on |
| `PRIVY_WALLET_ID`, `PRIVY_WALLET_ADDRESS` | pin a specific wallet instead of the local store |
| `MCP_AUTH_TOKEN` | operator token for our own tooling; users use their X sign-in instead |

## Changelog

**0.6.4**
- Package: restore the `xgas-mcp` bin entry that npm 11 dropped from 0.6.3 (`npx -y xgas-mcp` works again). No tool changes.
- Current generation: the deployment file's `fireball` block (and the host's live `/api/l4-info`) name the L4 desk
  contracts the site trades on today. The OTC desk, FOMO, router and NGU tools use those; the original `l4.*` set
  stays allowlisted for releasing, cancelling and withdrawing existing positions. Before this, the connector posted
  orders to the original escrow while the site showed the Fireball one, so bids placed through a model were only
  visible under the site's "older positions" link.

**0.6.3**
- XSwap V2 new orders OPEN: `prepare_xswap_out`, `prepare_xswap_in`, `quote_xswap` and the V2 bid/claim/accept/
  delivered actions prepare against the reviewed V2 escrows; `submit_xswap` relays them. `xswap_terms` reports
  `new_swaps_open` and `v2.new_orders_open` from the live runtime verification. Legacy escrows stay exit-only.

**0.6.2**
- Agent wallet: NGU curves someone else launched are no longer allowlisted. Buys on them need the owner
  (or `XGAS_WALLET_MAX_THIRD_PARTY_NGU_USD`), donations always need the owner, sells of held tokens still
  run. A launch with a seed but no seed tokens needs the owner, and `launch_ngu_token` refuses it.
- Agent wallet: idempotency keys are claimed synchronously and persisted as executing, reservations get
  their own refs, and sends are serialized per wallet, so parallel calls with one key cannot send twice or
  erase each other's spend from the 24-hour cap.
- Approval page: headlines come from the decoded call; agent-written labels are quoted and marked.
- XSwap: new swaps need a configured expected owner and refuse an owner contract that is not a Safe;
  `dispute` is not listed as a way out where nobody can rule. The redeploy source is `Ownable2Step` with
  `renounceOwnership()` disabled, and `DeployXSwap.deploy()` derives the deployer from the key.
