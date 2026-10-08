# xGas Orbit 466302 Fireball cutover (staged)

This plan keeps every existing xGas position on its current contract. It does not
change `mcp/deployment.json` or `src/contracts/l4-deployment.json`. Until all
steps below are complete, `src/contracts/fireball-relaunch.json` stays
`"active": false` and new creation routes remain on the historical contracts.

## Verified state (2026-10-04)

- Robinhood Fireball fanout `0x0a87Da84277232720e0908CC7470e3A7f925748f`
  has 15 registered outputs. The xMoney token
  `0xa924C725B64cC346f275269EFA4Bd0538cfBa97E` is not registered or
  active there, and its fanout balance is zero. A read-only `eth_call` of
  `ensureAsset(xMoney)` from an ordinary address succeeds.
- The current L4 sink `0xfeb38ce50e1F49438acAa39b2Da513d2F1DE548f`
  irrevocably targets the historical `0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8`
  fanout. Its balance is zero at this snapshot. In-flight old withdrawals must
  still be executed against that old destination.
- The old L4 escrow has one active order, ID 0, with 1 xMoney available. It
  must remain readable, fillable/cancellable, and releasable after the new
  contract is launched. It currently has no trades. The old NGU launcher has
  one token, `0x66ba3Bcc4B75D4bB356072A52713925f24A250b5`. The old FOMO
  contract is at round 1, with zero keys and no jackpot owed at this snapshot.
- The xMoney vault on Robinhood hardcodes the earlier `0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e`
  fanout for USDG entry/exit rake. Changing L4 fee producers cannot alter
  those immutable vault payments; any full vault migration needs a separate
  bridge/backing design.

## Ordered deployment

1. Recheck both chain IDs, all addresses, registered output count, xMoney
   balance and asset state with
   `FIREBALL_FANOUT_PARENT=0x0a87Da84277232720e0908CC7470e3A7f925748f node scripts/plan-fireball-relaunch.mjs --verify`.
   Resolve any changed state before proceeding. Coordinate one signer and
   nonce owner for each chain; do not broadcast from two workers at once.
2. On Robinhood, call `fanout.ensureAsset(xMoney)` **before** any xMoney reaches
   the new fanout. Verify `isAssetActive(xMoney)` afterward. If a balance has
   appeared unexpectedly, stop and reconcile quarantine/booking; do not
   treat the balance as automatically earned by the current output cohort.
3. Deploy `DeployFireballBridgeForwarder` on Robinhood, then verify its
   immutable `xMoney()` and `fanout()` and save its address in a staged record.
   The script rejects deployment until xMoney is active. This address is the
   new L4 sink's parent destination, not the fanout itself.
4. On L4, deploy `DeployOrbitL4Fireball` one step at a time: `sink`, then
   `escrow`, `fomo`, `router`, `ngu`. Use the real parent forwarder in
   `FIREBALL_FORWARDER_PARENT`, the new L4 sink in `FIREBALL_L4_SINK`, and
   preserve the existing buyback sink. Check each receipt and immutable
   wiring. Never retarget or replace existing contracts.
5. Add a fee keeper behind the inactive cutover flag. It must flush the new
   L4 sink once it holds at least 0.01 native xMoney; wait for the assertion;
   execute its confirmed Outbox withdrawal to the parent forwarder; then call
   `forward()` to book the actual xMoney received in the Fireball product-fee
   ledger. Outbox delivery has no token callback. Serialize this keeper's
   Robinhood signer transactions with the existing buyback keeper and user
   withdrawal executor to avoid nonce collisions. Persist/retry each stage.
6. Make escrow/FOMO/NGU/router UI and API routing version-aware: new actions
   use new contracts, and existing orders, trades, rounds and tokens retain
   actions against their original contracts. In particular, the active old
   escrow order ID 0 cannot be lost behind an empty new order list.
7. Only after a live end-to-end fee transfer is traceable through sink,
   Outbox, forwarder and new fanout should the staged manifest become active.
   Verify `/api/l4-info`, the site, and old position actions after cutover.

## Tests and limits

- `forge test --match-contract FireballBridgeFeeForwarderTest`: four passing
  unit tests for transfer tax, no-output guard, failure rollback and old sink
  immutability.
- `FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract FireballBridgeFeeForwarderForkTest`:
  one passing test against the live parent token/fanout, including exact
  balance-delta booking.
- `FORK_L4_URL=https://xgas.dev/rpc forge test --match-contract FireballOrbitL4ForkTest`:
  one passing L4 fork test for all successor constructor wiring and the
  untouched historical contracts.
- Forks do not prove the real cross-chain assertion/Outbox lifecycle. Keep
  public creation gated until a live, confirmed withdrawal and `forward()`
  have been observed.
