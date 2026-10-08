# xGas AMM: the therig-proof v4 fork and PonsV2

`v4-core/` is Uniswap v4-core (commit e50237c4, 2025-01-21) with one patch: the
`JitToll` baked into `PoolManager.sol`. Everything a router, hook or LP sees is the
stock v4 interface. The toll is invisible to integrations and impossible to opt out
of, because it lives in the singleton and not in a hook.

## What therig actually does (Robinhood chain 4663, see refit/github/REVELATIONS.md)

1. Launches a token on Pons and claims the creator fees Pons pays the launcher.
2. Spawns its own v4 pools on the shared PoolManager for that token: a 0-fee control
   pool plus 5% and 10% "extraction" pools at 1.15x, 1.5x, 2x ... 50x the curve price,
   all wired to its own hook so every arb fill is counted.
3. Walks price by adding thin liquidity, swapping through it, and removing it in one
   transaction. Arbs bridge curve <-> pools and pay the 10% LP fee to the rig.
4. Recycles inventory off-chart through the same JIT shape (`recycleJIT`).
5. Repeats every 2 seconds, funded by the creator fees.

"Price is a function of LP": whoever can spawn pools and place liquidity for free sets
the price surface. The defense has to make placing and removing liquidity cost the same
as trading, and make touching the same token repeatedly in one transaction ruinous.

## The toll (src/amm/JitToll.sol, enforced in PoolManager)

| rule | effect |
|---|---|
| LP add / remove pay the pool's swap fee + 10 bp | a 0-fee pool costs 10 bp per LP action; a 10% pool costs 10.1% to add and 10.1% to remove |
| every swap pays the pool fee + 10 bp floor | 0-fee pools cannot exist as free arb rails |
| n-th reference to the same token in one tx pays (fee + 10 bp) * n² | add(1x) → swap(4x) → remove(9x, +1 same-block = 16x); capped at 100% |
| remove in the block the position was added | counts as one extra reference, so bundled add/remove across txs is still JIT |
| native xMoney is never counted | A → xMoney → B is one reference per token, not two |
| toll accrues to `protocolFeesAccrued` | collected by the `protocolFeeController` (FanoutSink / XGAS.DEV buyback), never by the pool's hook or LPs |

Worked example on therig's own loop, in a 0-fee control pool: add pays 10 bp, the walk
swap pays 40 bp of output, the remove pays 160 bp of principal, and its four ladder
pools on the same token in the same `tick()` escalate to 25x, 36x, 49x and 64x. The
rig's whole edge was sub-10 bp per fill.

What the toll does not do: it cannot reach a second PoolManager or a v2/v3-style AMM
someone deploys on the L4. That gap is closed at the token layer (below), not here.

## PonsV2: what "therig-proof" means for the launchpad

Not built yet. These are the rules the contracts must satisfy; each one closes a step
of the loop above.

1. **No creator-fee claim.** Curve fees go burn / FanoutSink / XGAS.DEV buyback, as NGU
   already does (1 + 1 + 2 bp). Step 1 of the loop has nothing to fund it.
2. **Curve-only transfers before graduation.** Until the curve graduates, the token's
   `_update` only allows mint / burn by the curve and transfers to or from the curve.
   Nobody can seed a pool, on any AMM, for a token that is still on the curve. Step 2
   is impossible during the phase where the curve is the price oracle.
3. **Graduation seeds one pool, on this PoolManager, and the position is unremovable.**
   The launcher opens the pool at the curve's final price, LPs the reserve plus the
   remaining supply full-range, and holds the position itself with no remove path.
   Fees accrued to it are collected to the sinks. There is no "real pool" to arb
   against an extractor's ladder that is thinner than the extractor's own capital.
4. **Post-graduation transfer counter.** `NguToken`-style tokens keep a transient
   per-tx transfer counter and tax the n-th transfer in a tx at 10 bp * n², in kind,
   to 0xdead. This is the only layer that reaches AMMs we do not control. It cannot see
   inside a foreign v4's flash accounting, which is exactly why rule 3 keeps the real
   liquidity on ours.
5. **Monotone curve.** Keep NGU's floor and last-price monotonicity: a buy followed by a
   sell cannot move the curve down, so "walk the curve" is a donation, not an attack.

Open decisions before building PonsV2: constant-product Pons-style curve with a
graduation threshold, or NGU's monotone curve with an optional graduation; and whether
graduation is a launcher parameter or a fixed reserve target.

## Testing

```
cd contracts && forge test --match-path 'test/amm/*' -vv
```

Forge clears transient storage between the test contract's top-level calls, so two
router calls behave like two transactions. Same-transaction sequences go through the
`JitBot` in `test/amm/JitToll.t.sol`, which runs them inside one `unlock`.

## Deploy

```
PRIVATE_KEY=... AMM_FEE_COLLECTOR=<FanoutSink or splitter> \
forge script script/DeployAmm.s.sol --rpc-url https://xgas.dev/rpc --broadcast
```

License: v4-core is BUSL-1.1 until its change date; the patch does not alter that.
