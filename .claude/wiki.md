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
