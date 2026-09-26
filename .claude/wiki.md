## xgas Orbit L3 = in-process anvil; app must run on exactly ONE Fly machine with a /data volume
**SUPERSEDED — see "xgas Orbit L3 is a real Arbitrum Orbit chain (Fly app xgas-l3)"**
The "L3" (chain 466301) is an anvil child process inside server.js, state at /data/anvil-state.json + /data/bridge-ledger.json (volume `xgas_l3_data`, iad). Two machines = two diverging chains (that was the "bridged xMoney never shows up" bug on Sep 18 2026). Deploy with `fly deploy --ha=false`.
**Why:** anvil holds all L3 balances/orders/game state in memory; Fly's proxy round-robins requests across machines.

## L3 contracts are deployed by server.js at boot from contracts/l3-artifacts (not by forge)
**SUPERSEDED — see "xgas Orbit L3 is a real Arbitrum Orbit chain (Fly app xgas-l3)"**
Escrow/Fomo/Router deploy from anvil dev account #0 at nonces 0/1/2 → 0x5FbDB2…0aa3 / 0xe7f1…0512 / 0x9fE4…a6e0; served via GET /api/l3-info. After ANY contract change run `cd contracts && forge build && cd .. && npm run artifacts` (contracts/foundry.toml points at /Users/stacc/nft-range/lib, so nothing compiles in Docker; contracts/out is dockerignored).
**Why:** the runtime image has foundry's anvil but no solc libs; committed minimal artifacts are the only bytecode source.

## L3 balances are derived from L2 vault events, never seeded by hand
**SUPERSEDED — see "xgas Orbit L3 is a real Arbitrum Orbit chain (Fly app xgas-l3)"**
server.js replays RollupEntered/RollupExited on vault 0xa72Ab087…CB7c from block 66548458 (ledger dedupes by tx hash). Cash-out = POST /api/bridge/exit (debit L3, pending) → L2 exitRollup → /confirm, or /cancel refunds. Public /rpc only forwards an allowlist of eth_* methods; anvil_*/evm_*/eth_sendTransaction are blocked so nobody can mint L3 xMoney.
**Why:** an earlier version hard-seeded 29.994 xMoney for 0x26E8…5158; on-chain truth is 4.999 bridged. Known gap: the L2 vault mints an ERC20 claim AND the L3 credits native gas (double representation) — fixing that needs a new L2 vault.

## xgas Orbit L3 is a real Arbitrum Orbit chain (Fly app xgas-l3)
Chain 466301 = AnyTrust Orbit chain created 2026-09-18 via the canonical RollupCreator on Robinhood (#4663). All addresses live in src/contracts/l3-deployment.json (rollup 0x5Ba5…83a8, inbox 0x67E5…87b4, outbox 0x4d47…E78f, bridge 0x8b58…4E5f, seqInbox 0x16Da…AeD7). Node = Fly app `xgas-l3` (one machine, volume xgas_l3_node, image from ~/.xgas-orbit/fly-l3: DAS + nitro in one container; node config is the NODE_CONFIG_B64 secret; WIPE_CHAIN=1 env wipes /data/nitro on boot — unset after use). Public RPC https://xgas-l3.fly.dev. Operator keys + DAS pubkey: ~/.xgas-orbit/keys.json (chainOwner 0xC3D6…B14F, batchPoster 0xACE3…aEFF, validator 0x0d61…A647); rollup.json has core contracts. Batch poster and validator need ETH on Robinhood topped up (validator also WETH for the 0.0001 stake).
**Why:** the anvil "L3" was a single server; this one posts batches + assertions to Robinhood, so state is verifiable and exits go through the Outbox.

## xMoney gas token is 0xa924…a97E (tax token) — legacy 0xa72A…CB7c is retired
The Orbit ERC20Bridge mints exactly what it receives, so a fee-on-transfer gas token breaks it. XMoney.sol keeps the 0.01% tax everywhere except transfers INTO inbox/bridge (tax retained by the bridge as backing); half the vault's entry burn is minted to the bridge as buffer. enterRollup mints + creates a retryable ticket to the L3 recipient in one tx (deployFactoriesToL2 was false at rollup creation because factories would have been taxed). Legacy holders use XMoney.migrate(). Never re-enable a transfer tax on bridge-bound transfers.
**Why:** discovered when createRollup simulation reverted with the legacy token as nativeToken.

## Withdrawals: ArbSys.withdrawEth on L3 → Outbox on Robinhood (server executes) → vault.exitRollup
server.js tracks L2ToL1Tx events, computes sendCount from the latest confirmed assertion (AssertionCreated log → L3 block sendCount), builds the proof with NodeInterface.constructOutboxProof and executes Outbox.executeTransaction with L2_EXECUTOR_KEY (chain owner key, Fly secret on xgas-app). Fast confirmation is enabled with the single validator as anyTrustFastConfirmer.
**Why:** real Orbit exits need an outbox proof; users shouldn't have to compute it.

## XMoney owner is a 24h TimelockController (0x70A0…B47B) — proposers: chain owner + 0x26E8…5158
Any owner call on XMoney (setBridgeSystem, setL3RetryableParams) must be scheduled on the timelock and executed after 86400s; executor role is open (address(0)). Source, chain-info.json and RUN-A-NODE.md are served from /public on xgas.dev; /das/* proxies the AnyTrust REST server for third-party nodes.
**Why:** closes the "owner can redirect deposits" vector raised in the Holder HQ review without freezing the retryable gas params.

## Web app moved to Fly app `xgas` (personal org of jarett@dcssquared.com) on 2026-09-26
Old `xgas-app` and `xgas-l3` live in a Fly account this machine's flyctl can't reach. New app `xgas` (volume `xgas_data`) talks to the L4 over the public https://xgas-l3.fly.dev since `.internal` DNS doesn't cross orgs (L4_RPC_INTERNAL/DAS_REST_INTERNAL secrets). The /das proxy is broken because :9877 isn't public on xgas-l3. xgas.dev DNS lives in Vercel (`vercel dns ls xgas.dev`) → 66.241.125.193 / 2a09:8280:1::19c:3fa5:0.
**Why:** X sign-in needed X_CLIENT_SECRET set and the old account was unreachable.

## Layer count: xgas is an L3 by the standard count, despite "L4" branding
Robinhood Chain (#4663) settles straight to Ethereum (its l1BlockNumber tracks Ethereum's head; L2BEAT lists it as an Orbit L2). `parent-chain-is-arbitrum: true` in chain-info.json only means the parent runs ArbOS; it adds no layer. The deployed vault still uses `*L3*` function names (`l3GasLimit`, `setL3RetryableParams`, `totalXMoneyBridgedToL3`); only repo source was renamed to L4, so MCP calls to `totalXMoneyBridgedToL4` revert.
**Why:** found 2026-09-26 during litepaper research; public copy that says "L4" will get corrected by anyone who checks.

## Rollup confirmPeriodBlocks (50400) counts ETHEREUM blocks (~7 days), not Robinhood blocks
BoLD on an Arbitrum parent uses L1 block numbers. mcp/src/tools/bridge.mjs quote_exit multiplies by Robinhood's 0.101s block time and promises ~1h25m. Real exits only go fast because validator 0x0d61 is also anyTrustFastConfirmer; if it stops asserting (it stopped 2026-09-21), exits wait. The host only executes Outbox claims on POST /api/withdrawals/execute (unauthenticated, CORS *), never automatically.
**Why:** a user withdrawal (position 4, 9.449 xMoney) was stuck behind the idle validator on 2026-09-26.

## The executor key is the chain-owner key, which holds UpgradeExecutor EXECUTOR_ROLE
0xC3D6 (L2_EXECUTOR_KEY per this wiki) can instantly upgrade Bridge/Inbox/Outbox via ProxyAdmin 0x357b and forceConfirm on the rollup: no timelock on that path. The 24h timelock only owns the XMoney vault. mcp/README.md's "the only key can only execute Outbox withdrawals" is false; don't repeat it in copy.
**Why:** verified on-chain 2026-09-26; the trust disclosure in OrbitXMoneyOtc.tsx omits it.

## XGAS.DEV flywheel: L4 fees can double, the XMoney vault's cannot
0x006D…dFa3 (XGAS.DEV, Robinhood) is the burn target. L4 contracts (escrow/fomo/router/NGU) add BUYBACK_BPS=2 → a second FanoutSink whose parent destination is XgasDevBuyback on Robinhood, which redeems xMoney→USDG, swaps USDG→ETH (pool 0xbac3…e551, deepest ETH/USDG v4) → XGAS.DEV (graduation pool 0x33c7…5bc1, hook 0xE5e7…) and calls burn(). XMoney.sol (0xa924) fees are `constant` and it's the rollup's nativeToken, so vault/transfer fees stay 0.01%. `execute` is keeper-only on purpose: a permissionless trigger can be sandwiched atomically (pump, trigger, dump).
**Why:** 39 v4 pools contain XGAS.DEV; most are junk with 80%+ fees. The L4 leg moves only while assertions confirm (see validator note above).

## staccpad.fun/rpc is a pruned load-balancer; fork tests and log scans need rpc.mainnet.chain.robinhood.com
Forks against staccpad.fun/rpc fail randomly with "Unknown state. First available state is 1" and eth_getLogs rate-limits at ~50k blocks. `FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<head-2000> forge test --match-path '*fork*'` is deterministic.
**Why:** the XgasDevBuyback fork suite flaked 3 runs in a row until switched.

## Relaunch: chain 466302 (rollup mode, permissionless validation) created 2026-09-26
Rollup 0x5868266C0c0663f4bc39329B525884f137BAD93E, inbox 0xa708…8146, bridge 0x2290…B6fb, UpgradeExecutor 0x43E8…b9F9, fast-confirm 2-of-3 Safe 0x17fC…2cBC (owners = validators 1-3), fee pricer 0xf13a…3195; createRollup tx 0x79e5c8e5… at Robinhood block 72937914. Validator whitelist DISABLED (tx 0xfed50688…). Full addresses + scripts + NEW operator keys (0600) live in ~/.xgas-orbit/relaunch-466302/ (rollup-466302.json, keys-new.json); never only in /tmp. Old chain 466301 holders were refunded in USDG by the founder (92.25 USDG, 26 Sep); deposits paused in UI/MCP until the vault's setBridgeSystem (24h timelock) points at the new inbox/bridge.
**Why:** old AnyTrust chain's DAS + validator lived in an unreachable Fly account; exits stalled 5 days. Robinhood's public RPC keeps only ~11 min of state, so nitro configs need node.bold.rpc-block-number=latest (not finalized).

## Landmine: direct depositERC20 from a MetaMask smart account (EIP-7702) lands at the ALIASED address
Robinhood sees code (0xef0100…) on 7702-delegated EOAs, so the Orbit inbox's depositERC20 credits applyL1ToL2Alias(sender) (sender + 0x1111…1111) on the L3, not the sender. Recover with inbox.sendContractTransaction(gas, maxFee, to, value, 0x) from the same wallet (always acts as the alias). vault.enterRollup is safe: it passes an explicit l3Recipient.
**Why:** founder's 0.05 xMoney smoke deposit on 466302 (26 Sep) landed at 0x37f9…6269; any UI that uses depositERC20 directly must warn or use createRetryableTicket with an explicit recipient.

## xgas.dev is served from worktree branch r4-466302 (/Users/stacc/xgas-app-r4) since 2026-09-26 09:43 UTC
**SUPERSEDED: r4-466302 was cherry-picked into main at 09:5x UTC (commits 7049d79, f054866, 65fac6e); deploy from main again.** Live site/hosted MCP point at chain 466302. L3 apps: escrow 0x842E…6754, router 0xc4a5…9a2E (receive() reverts), NguLauncher 0x6067…f7F8, FanoutSink 0xfeb3…548f, buyback sink 0x70A0…B47B (these hexes collide with unrelated Robinhood/466301 contracts by nonce coincidence), fixed FOMO 0xB907…09F1 deployed but UNLISTED (claimJackpot push-to-winner can lock a round; needs jackpotOwed fallback). Deposits before the vault switch go through EarlyDepositor 0x36e5…D431 on Robinhood (reviewed; 0x9916…acbd is the unfixed first deploy, unused). Stale app secrets L4_RPC_INTERNAL/DAS_REST_INTERNAL were unset; server logs "[boot] L4 RPC … is chain 466302". Main's working tree has NOT been reconciled with the branch: cherry-pick the r4 commits before deploying from main again, or the site reverts to 466301.
**Why:** relaunch had to ship before the 24h timelock; deploying main now would silently roll the site back.

## Nitro on Robinhood: RPC and BoLD landmines (chain 466302)
Sequencer cannot use node.inbox-reader.read-mode=safe (fatal with sequencer); dRPC returns "Unknown block" at latest, so validators use read-mode safe on dRPC (lb.drpc.live/robinhood/<key>, Fly secret on xgas-l4-val1/val2). Public Robinhood RPC 429s a BoLD staker: staker is OFF on xgas-l4, runs in xgas-l4-val1 (ewr, MakeNodes, posting interval 1m) and xgas-l4-val2 (ord, ResolveNodes). Defensive strategy never fast-confirms or posts edges. use-finality-data=true makes a brand-new chain wait for its creation block to finalize; use-finality-data=false without check-batch-finality=false stalls BoLD ("finalized block not found"). An empty chain stays at block 0 until the first delayed message.
**Why:** each of these cost an outage hour on 26 Sep; the user said never use Alchemy (key over monthly capacity).

## Chain 466302 admin facts not in code
ArbOwner precompile calls need ~2.6M gas (L1 data component): estimate, never hard-code 500k. deploy-l3-apps.mjs budgets at 1x base but sets maxFee 2x: deploy at 0.1 gwei. minimumAssertionPeriod = 25 L1 blocks (tx 0xc41d8597…). ValidatorFeeSplitter 0xa924c725…a97e on L3 (owner 0xC3D6, treasury 0x26E8, payees validators 1-3) receives network+infra fees. Live FOMO is 0xa8d8…f151 (jackpotOwed pull fallback); 0xB907… is retired. Founder 0x26E8 7702 delegation is OFF. EarlyDepositor leaves a 1 bp bridge deficit per pre-switch deposit: after the vault switch (scheduled task xgas-vault-switch-466302, 2026-09-27T08:34:30Z) top up bridge with bridgeDeficit()+5e12 wei. OTC escrow on 466302 has no dispute path yet.
**Why:** easy to re-derive wrong; the 2x maxFee bug stranded a deploy mid-run.

## Plaid payment check + passkey step-up live from branch plaid-payment-check (5a61fdf), NOT in main (deployed 26 Sep)
server/plaid.mjs + src/components/PlaidCheck.tsx: read-only check that a desk trade's X Money dollars moved (exact cents, direction, memo "xgas #id"); receipts at /api/robinhood/plaid-receipt/:id for disputes. Dormant until Fly secrets PLAID_CLIENT_ID/PLAID_SECRET (PLAID_ENV defaults to sandbox). Main's working tree held another session's uncommitted paymaster WIP (server.js), so the branch was not merged: merge it into main before deploying main, or a later deploy drops Plaid. Access tokens are AES-GCM sealed with PLAID_TOKEN_KEY or a key derived from SESSION_SECRET: rotating either orphans every link.
**Why:** the deploy from the worktree was left to the user; two unmerged lines of work deploying from different checkouts is how the site silently rolls back.

## X Money is a Plaid institution: ins_137835 (url https://www.x.com), seen in the Plaid dashboard 26 Sep 2026
So a desk party can link their X Money wallet itself through Plaid Link, not only the bank behind it; the Plaid payment check (server/plaid.mjs) can then see X Money P2P transfers at the source. It supports TRANSACTIONS and TRANSACTIONS_REFRESH (plus AUTH, BALANCE, IDENTITY, IDENTITY_MATCH, SIGNAL, PAY_BY_BANK and the CRA products). Unverified until a real production link: whether X Money's transaction descriptions carry the payment note (the "xgas #id" memo) and the counterparty handle.
**Why:** this was the open question behind "Plaid for the X Money API"; it decides whether the fiat leg can be verified directly.

## Sequencer parent RPC is dRPC (xgas-l4 PARENT_CHAIN_RPC_URL), since 26 Sep 15:58 UTC
The public Robinhood RPC started returning 429 to the sequencer's inbox reader; deposits (delayed messages) stopped being sequenced for ~70 min (bridge count 16 vs read 8, L4 head frozen). Switching the xgas-l4 secret PARENT_CHAIN_RPC_URL to the dRPC endpoint fixed it within a minute. Symptom to watch: "error reading inbox ... 429" in `fly logs -a xgas-l4`, or bridge.delayedMessageCount() > sequencerInbox.totalDelayedMessagesRead().
**Why:** the site now polls Robinhood a lot (SSE watcher, paymaster price/debits, OG cards), which likely shares egress with the sequencer; never put the sequencer back on the public RPC.
