// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {JitToll} from "../../src/amm/JitToll.sol";

import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {TestERC20} from "./utils/TestERC20.sol";
import {PoolSwapTest} from "./utils/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "./utils/PoolModifyLiquidityTest.sol";


/// @dev The extractor: any sequence of LP / swap ops inside ONE unlock, i.e. one transaction.
///      This is the shape therig's `_walkInternal` and `recycleJIT` take.
contract JitBot is IUnlockCallback {
    using TransientStateLibrary for PoolManager;

    struct Op {
        bool isLp; // true: modifyLiquidity(liq); false: swap(zeroForOne, amount)
        int256 liq;
        bool zeroForOne;
        int256 amount;
    }

    PoolManager immutable pm;
    PoolKey key;
    Op[] ops;
    uint256 public refsNativeSeen;
    uint256 public refsTokenSeen;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    receive() external payable {}

    function run(PoolKey memory k, Op[] memory o) external {
        key = k;
        delete ops;
        for (uint256 i; i < o.length; i++) ops.push(o[i]);
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        for (uint256 i; i < ops.length; i++) {
            Op memory o = ops[i];
            if (o.isLp) {
                pm.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-60, 60, o.liq, bytes32(0)), "");
            } else {
                pm.swap(
                    key,
                    IPoolManager.SwapParams(
                        o.zeroForOne,
                        o.amount,
                        o.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                    ),
                    ""
                );
            }
        }
        refsNativeSeen = pm.refsThisTx(CurrencyLibrary.ADDRESS_ZERO);
        refsTokenSeen = pm.refsThisTx(key.currency1);
        _close(key.currency0);
        _close(key.currency1);
        return "";
    }

    function _close(Currency c) internal {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            uint256 owe = uint256(-d);
            if (c.isAddressZero()) {
                pm.settle{value: owe}();
            } else {
                pm.sync(c);
                IERC20Minimal(Currency.unwrap(c)).transfer(address(pm), owe);
                pm.settle();
            }
        } else if (d > 0) {
            pm.take(c, address(this), uint256(d));
        }
    }
}

/// @dev Forge clears transient storage between the test contract's top-level calls, so two
///      router calls behave like two transactions (that is what the cross-tx tests want).
///      Same-transaction sequences go through JitBot, which runs them inside one unlock.
///      Expected rates are computed from the live counter, never assumed.
///      (Every call inside one test function shares a transaction, so the transient
///      reference counters accumulate across calls: that is the JIT shape under test.
///      Expected rates are computed from the live counter, never assumed.
contract JitTollTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 constant ONE = 1e6;
    int24 constant LOWER = -60;
    int24 constant UPPER = 60;

    PoolManager pm;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;
    TestERC20 tokenA;
    TestERC20 tokenB;
    Currency c0;
    Currency c1;
    PoolKey key3000; // 0.30% pool
    PoolKey key0; // 0-fee pool
    PoolKey keyNative; // xMoney / token
    JitBot bot;

    receive() external payable {}

    function setUp() public {
        pm = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(pm);
        lpRouter = new PoolModifyLiquidityTest(pm);
        tokenA = new TestERC20(1e30);
        tokenB = new TestERC20(1e30);
        (address lo, address hi) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        c0 = Currency.wrap(lo);
        c1 = Currency.wrap(hi);
        tokenA.approve(address(swapRouter), type(uint256).max);
        tokenA.approve(address(lpRouter), type(uint256).max);
        tokenB.approve(address(swapRouter), type(uint256).max);
        tokenB.approve(address(lpRouter), type(uint256).max);

        key3000 = PoolKey(c0, c1, 3000, 60, IHooks(address(0)));
        key0 = PoolKey(c0, c1, 0, 60, IHooks(address(0)));
        keyNative = PoolKey(CurrencyLibrary.ADDRESS_ZERO, c1, 0, 60, IHooks(address(0)));
        pm.initialize(key3000, SQRT_PRICE_1_1);
        pm.initialize(key0, SQRT_PRICE_1_1);
        pm.initialize(keyNative, SQRT_PRICE_1_1);
        vm.deal(address(this), 1000 ether);
        bot = new JitBot(pm);
        tokenA.transfer(address(bot), 1e27);
        tokenB.transfer(address(bot), 1e27);
        vm.deal(address(bot), 100 ether);
        vm.recordLogs();
    }

    // ───────────────────────── helpers ─────────────────────────

    function _lp(PoolKey memory k, int256 liq) internal returns (BalanceDelta) {
        return _lp(k, liq, 0);
    }

    function _lp(PoolKey memory k, int256 liq, uint256 value) internal returns (BalanceDelta) {
        return lpRouter.modifyLiquidity{value: value}(
            k, IPoolManager.ModifyLiquidityParams(LOWER, UPPER, liq, bytes32(0)), ""
        );
    }

    function _swapExactIn(PoolKey memory k, bool zeroForOne, uint256 amountIn) internal returns (BalanceDelta) {
        return swapRouter.swap(
            k,
            IPoolManager.SwapParams(
                zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    /// @dev principal amounts for adding `liq` in [LOWER, UPPER] at price 1, rounded up like the pool does
    function _principal(uint128 liq) internal pure returns (uint256 a0, uint256 a1) {
        a0 = SqrtPriceMath.getAmount0Delta(SQRT_PRICE_1_1, TickMath.getSqrtPriceAtTick(UPPER), liq, true);
        a1 = SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(LOWER), SQRT_PRICE_1_1, liq, true);
    }

    struct TollLog {
        uint8 kind;
        uint256 refs;
        uint24 rate;
        uint128 amount0;
        uint128 amount1;
    }

    function _lastToll() internal returns (TollLog memory t) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Toll(bytes32,address,uint8,uint256,uint24,uint128,uint128)");
        bool found;
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == sig) {
                (t.kind, t.refs, t.rate, t.amount0, t.amount1) =
                    abi.decode(logs[i - 1].data, (uint8, uint256, uint24, uint128, uint128));
                found = true;
                break;
            }
        }
        assertTrue(found, "no Toll event");
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : uint256(uint128(x));
    }

    // ───────────────────────── rule 1: LP add / remove pay fee + 10 bp ─────────────────────────

    function test_addLiquidityPaysPoolFeePlusFloor() public {
        uint128 liq = 1e18;
        (uint256 p0, uint256 p1) = _principal(liq);
        uint256 n = _max(pm.refsThisTx(c0), pm.refsThisTx(c1)) + 1;
        uint24 r = JitToll.rate(3000, n);
        assertEq(r, uint24(4000 * n * n), "0.30% + 10 bp, escalated");

        uint256 acc0 = pm.protocolFeesAccrued(c0);
        uint256 bal0 = c0.balanceOf(address(this));
        BalanceDelta d = _lp(key3000, int256(uint256(liq)));

        uint256 t0 = p0 * r / ONE;
        uint256 t1 = p1 * r / ONE;
        assertEq(pm.protocolFeesAccrued(c0) - acc0, t0, "toll0 accrued to protocol");
        assertEq(pm.protocolFeesAccrued(c1), t1, "toll1 accrued to protocol");
        assertEq(_abs(d.amount0()), p0 + t0, "LP paid principal + toll");
        assertEq(bal0 - c0.balanceOf(address(this)), p0 + t0, "wallet debited principal + toll");

        TollLog memory log = _lastToll();
        assertEq(log.kind, JitToll.KIND_ADD);
        assertEq(log.rate, r);
    }

    function test_removeLiquidityNextBlockPaysFeePlusFloorOnce() public {
        uint128 liq = 1e18;
        _lp(key3000, int256(uint256(liq)));
        vm.roll(block.number + 1);

        uint256 before0 = pm.protocolFeesAccrued(c0);
        uint256 n = _max(pm.refsThisTx(c0), pm.refsThisTx(c1)) + 1; // no same-block bonus
        BalanceDelta d = _lp(key3000, -int256(uint256(liq)));
        TollLog memory log = _lastToll();
        assertEq(log.kind, JitToll.KIND_REMOVE);
        assertEq(log.refs, n, "next-block remove is not JIT");
        assertEq(log.rate, JitToll.rate(3000, n));
        // what came back = principal - toll, and the toll is exactly rate * principal
        uint256 out0 = uint256(uint128(d.amount0()));
        uint256 toll0 = pm.protocolFeesAccrued(c0) - before0;
        assertEq(toll0, (out0 + toll0) * log.rate / ONE, "toll is rate of the withdrawn principal");
    }

    // ───────────────────────── rule 2: same-tx references escalate n^2 ─────────────────────────

    function test_zeroFeePoolSwapPaysFloorThenEscalates() public {
        _lp(key0, 1e21);
        uint256 amountIn = 1e15;

        for (uint256 i; i < 3; i++) {
            uint256 n = _max(pm.refsThisTx(c0), pm.refsThisTx(c1)) + 1;
            uint256 acc1 = pm.protocolFeesAccrued(c1);
            BalanceDelta d = _swapExactIn(key0, true, amountIn);
            uint256 out = uint256(uint128(d.amount1()));
            uint256 toll = pm.protocolFeesAccrued(c1) - acc1;
            TollLog memory log = _lastToll();
            assertEq(log.kind, JitToll.KIND_SWAP);
            assertEq(log.refs, n);
            assertEq(log.rate, JitToll.rate(0, n), "0-fee pool: 10 bp * n^2");
            assertEq(toll, (out + toll) * log.rate / ONE, "toll taken from the output leg");
            assertGt(toll, 0);
        }
    }

    function test_swapTollIsOnTopOfPoolFee() public {
        _lp(key3000, 1e21);
        uint256 n = _max(pm.refsThisTx(c0), pm.refsThisTx(c1)) + 1;
        uint256 acc1 = pm.protocolFeesAccrued(c1);
        BalanceDelta d = _swapExactIn(key3000, true, 1e15);
        TollLog memory log = _lastToll();
        uint24 r = JitToll.rate(3000, n);
        assertEq(log.rate, r);
        // extra over the pool fee = r - 3000; the pool's 0.30% went to LPs, not here
        uint256 out = uint256(uint128(d.amount1()));
        uint256 toll = pm.protocolFeesAccrued(c1) - acc1;
        assertEq(toll, (out + toll) * (r - 3000) / ONE);
    }

    function test_rateCapsAt100Percent() public pure {
        assertEq(JitToll.rate(0, 1), 1_000);
        assertEq(JitToll.rate(0, 2), 4_000);
        assertEq(JitToll.rate(0, 10), 100_000);
        assertEq(JitToll.rate(100_000, 3), 909_000);
        assertEq(JitToll.rate(100_000, 4), 1_000_000);
        assertEq(JitToll.rate(500_000, 100), 1_000_000);
    }

    // ───────────────────────── rule 3: atomic and same-block JIT ─────────────────────────

    function test_atomicJitAddSwapRemoveIsCrushed() public {
        _lp(key0, 1e21); // standing liquidity from someone else (its own tx)

        JitBot.Op[] memory ops = new JitBot.Op[](3);
        ops[0] = JitBot.Op(true, 1e20, false, 0); // JIT add: ref 1
        ops[1] = JitBot.Op(false, 0, true, -1e15); // the swap it brackets: ref 2
        ops[2] = JitBot.Op(true, -1e20, false, 0); // JIT remove: ref 3, +1 same block = 4
        uint256 bal0 = c0.balanceOf(address(bot));
        uint256 bal1 = c1.balanceOf(address(bot));
        bot.run(key0, ops);

        TollLog memory log = _lastToll();
        assertEq(log.kind, JitToll.KIND_REMOVE);
        assertEq(log.refs, 4, "same-tx refs plus the same-block bonus");
        assertEq(log.rate, JitToll.rate(0, 4));
        assertEq(log.rate, 16_000, "160 bp on the remove of a 0-fee pool");
        // add paid 10 bp, swap paid 40 bp, remove paid 160 bp: the bot is down on both legs
        assertLt(c0.balanceOf(address(bot)), bal0);
        assertLt(c1.balanceOf(address(bot)) + 1e15, bal1 + 1e15 * 9990 / 10000, "worse than a plain 10 bp swap");
    }

    function test_manyReferencesReachTheCap() public {
        _lp(key0, 1e21);
        JitBot.Op[] memory ops = new JitBot.Op[](40);
        for (uint256 i; i < 40; i++) {
            ops[i] = JitBot.Op(false, 0, i % 2 == 0, -1e12);
        }
        bot.run(key0, ops);
        TollLog memory log = _lastToll();
        assertEq(log.refs, 40);
        assertEq(log.rate, 1_000_000, "capped at 100%: the 40th swap gets nothing back");
    }

    function test_crossTxSameBlockRemoveIsStillJit() public {
        // add in one tx, remove in another, same block: the bundle shape
        _lp(key3000, 1e18);
        _lp(key3000, -1e18);
        TollLog memory log = _lastToll();
        assertEq(log.refs, 2, "1 ref in this tx + 1 for the same-block add");
        assertEq(log.rate, JitToll.rate(3000, 2));
    }

    function test_sameBlockRemoveCountsExtraReference() public {
        _lp(key3000, 1e18);
        uint256 n = _max(pm.refsThisTx(c0), pm.refsThisTx(c1)) + 1;
        _lp(key3000, -1e18);
        TollLog memory log = _lastToll();
        assertEq(log.refs, n + 1, "same block add + remove = one extra reference");
    }

    // ───────────────────────── native xMoney is exempt from the count ─────────────────────────

    function test_nativeIsNotCounted() public {
        JitBot.Op[] memory ops = new JitBot.Op[](3);
        ops[0] = JitBot.Op(true, 1e18, false, 0);
        ops[1] = JitBot.Op(false, 0, false, -1e15); // token -> xMoney
        ops[2] = JitBot.Op(false, 0, true, -1e15); // xMoney -> token
        bot.run(keyNative, ops);
        assertEq(bot.refsNativeSeen(), 0, "native never counted");
        assertEq(bot.refsTokenSeen(), 3, "the token is, once per op");
        TollLog memory log = _lastToll();
        assertEq(log.refs, 3);
        assertEq(log.rate, JitToll.rate(0, 3));
        assertGt(log.amount1, 0, "swap toll on the unspecified (token) leg");
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
