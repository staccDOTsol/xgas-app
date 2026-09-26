// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {NguToken} from "../src/NguToken.sol";
import {NguLauncher} from "../src/NguLauncher.sol";

/// @dev Compiler note (forge 1.8.3): combining `.balance` reads of multiple
///      addresses with the payout assertion in one test miscompiles (phantom
///      value in assertEq). Keep balance-delta checks in their own tests.
contract NguTokenTest is Test {
    NguLauncher launcher;
    NguToken token;
    address fanout = address(0xFEE);
    address buyback = address(0xB8B);
    address dead = 0x000000000000000000000000000000000000dEaD;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant BASE = 1 ether;
    uint16 constant STEP = 100;
    uint16 constant BETA = 9000;

    function setUp() public {
        launcher = new NguLauncher(fanout, buyback);
        address t = launcher.launch("NGU", "NGU", 1000, BASE, STEP, BETA, 0);
        token = NguToken(payable(t));
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function test_launchRegistersToken() public view {
        assertTrue(launcher.isNguToken(address(token)));
        assertEq(launcher.allTokensLength(), 1);
        assertEq(token.maxSupply(), 1000);
        assertEq(token.basePrice(), BASE);
        assertEq(token.lastPrice(), BASE);
        assertEq(token.floor(), 0);
    }

    function test_launchWithSeed() public {
        address t = launcher.launch{value: 10 ether}("S", "S", 100, BASE, STEP, BETA, 5);
        NguToken s = NguToken(payable(t));
        assertEq(s.supply(), 5);
        assertEq(s.reserve(), 10 ether);
        assertEq(s.floor(), 2 ether);
        assertEq(s.balanceOf(address(this)), 5 ether);
    }

    function test_launchBadBetaReverts() public {
        vm.expectRevert(NguToken.BadParams.selector);
        launcher.launch("B", "B", 100, BASE, STEP, 4000, 0);
        vm.expectRevert(NguToken.BadParams.selector);
        launcher.launch("B", "B", 100, BASE, STEP, 9600, 0);
    }

    function test_firstBuyAtBasePrice() public {
        assertEq(token.quoteBuy(1), BASE);
        vm.prank(alice);
        token.buy{value: BASE}(1, address(0));
        assertEq(token.balanceOf(alice), 1 ether);
        assertEq(token.supply(), 1);
        assertEq(token.lastPrice(), BASE);
        assertEq(token.reserve(), BASE - BASE / 10000 - BASE / 10000 - (BASE * 2) / 10000);
    }

    function test_buyRoutesBurnAndRake() public {
        vm.prank(alice);
        token.buy{value: BASE}(1, address(0));
        assertEq(dead.balance, BASE / 10000);
        assertEq(fanout.balance, BASE / 10000);
    }

    function test_buyRoutesBuyback() public {
        vm.prank(alice);
        token.buy{value: BASE}(1, address(0));
        assertEq(buyback.balance, (BASE * 2) / 10000);
    }

    function test_buyPriceRises() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        uint256 f = token.floor();
        uint256 stepPrice = (BASE * 10100) / 10000;
        uint256 betaPrice = (f * 10_000) / 9000;
        uint256 expected = stepPrice > betaPrice ? stepPrice : betaPrice;
        assertEq(token.nextPrice(), expected);
        assertEq(token.quoteBuy(1), expected);
    }

    function test_buyOverpaymentRefunded() public {
        vm.prank(alice);
        uint256 balBefore = alice.balance;
        token.buy{value: 5 ether}(1, address(0));
        assertEq(alice.balance, balBefore - BASE);
    }

    function test_buyUnderpaidReverts() public {
        vm.prank(alice);
        vm.expectRevert(NguToken.Underpaid.selector);
        token.buy{value: BASE - 1}(1, address(0));
    }

    function test_buyBeyondMaxSupplyReverts() public {
        address t = launcher.launch("C", "C", 10, BASE, STEP, BETA, 0);
        NguToken c = NguToken(payable(t));
        vm.prank(alice);
        c.buy{value: 100 ether}(5, address(0));
        vm.prank(alice);
        c.buy{value: 100 ether}(5, address(0));
        assertEq(c.minted(), 10);
        vm.prank(alice);
        vm.expectRevert(NguToken.SoldOut.selector);
        c.buy{value: 10 ether}(1, address(0));
    }

    function test_buyZeroOrTooManyReverts() public {
        vm.prank(alice);
        vm.expectRevert(NguToken.BadParams.selector);
        token.buy{value: 1}(0, address(0));
        vm.expectRevert(NguToken.BadParams.selector);
        token.buy{value: 100 ether}(51, address(0));
    }

    function test_sellRedeemsAtFloor() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(5, address(0));
        uint256 f = token.floor();
        uint256 q = token.quoteSell(2);
        vm.prank(alice);
        uint256 payout = token.sell(2, payable(address(0)), 0);
        assertEq(payout, q);
        assertEq(token.balanceOf(alice), 3 ether);
        assertEq(token.supply(), 3);
        assertGe(token.floor(), f - 1);
    }

    function test_sellPayoutSplit() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        uint256 basis = token.floor() < token.lastPrice() ? token.floor() : token.lastPrice();
        uint256 expected = basis - (basis * 1) / 10000 - (basis * 1) / 10000 - (basis * 2) / 10000;
        vm.prank(alice);
        uint256 payout = token.sell(1, payable(bob), 0);
        assertEq(payout, expected);
    }

    function test_sellRoutesBurnAndRake() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        uint256 deadBefore = dead.balance;
        uint256 fanoutBefore = fanout.balance;
        uint256 basis = token.floor() < token.lastPrice() ? token.floor() : token.lastPrice();
        uint256 burnAmt = (basis * 1) / 10000;
        uint256 rakeAmt = (basis * 1) / 10000;
        vm.prank(alice);
        token.sell(1, payable(bob), 0);
        assertEq(dead.balance - deadBefore, burnAmt);
        assertEq(fanout.balance - fanoutBefore, rakeAmt);
    }

    function test_sellRoutesBuyback() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        uint256 buybackBefore = buyback.balance;
        uint256 basis = token.floor() < token.lastPrice() ? token.floor() : token.lastPrice();
        vm.prank(alice);
        token.sell(1, payable(bob), 0);
        assertEq(buyback.balance - buybackBefore, (basis * 2) / 10000);
    }

    function test_quoteBuyMatchesBuyAcrossManyUnits() public {
        uint256 q = token.quoteBuy(20);
        vm.prank(alice);
        uint256 cost = token.buy{value: 100 ether}(20, address(0));
        assertEq(cost, q);
    }

    function test_sellSlippageReverts() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        vm.prank(alice);
        vm.expectRevert(NguToken.Slippage.selector);
        token.sell(1, payable(address(0)), type(uint256).max);
    }

    function test_sellWithoutBalanceReverts() public {
        vm.prank(bob);
        vm.expectRevert();
        token.sell(1, payable(address(0)), 0);
    }

    function test_floorNeverDropsAcrossMixedFlow() public {
        uint256 lastFloor;
        uint256 lastPx;
        for (uint256 i; i < 6; i++) {
            vm.prank(alice);
            token.buy{value: 60 ether}(3, address(0));
            assertGe(token.floor(), lastFloor);
            assertGe(token.nextPrice(), lastPx);
            lastFloor = token.floor();
            lastPx = token.nextPrice();
            vm.prank(alice);
            token.sell(1, payable(address(0)), 0);
            assertGe(token.floor(), lastFloor - 1);
            lastFloor = token.floor();
        }
    }

    function test_donateRaisesFloorWithoutMinting() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(2, address(0));
        uint256 fBefore = token.floor();
        uint256 sBefore = token.supply();
        vm.prank(bob);
        token.donate{value: 5 ether}();
        assertGt(token.floor(), fBefore);
        assertEq(token.supply(), sBefore);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_sellCappedAtLastPriceAfterDonation() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(1, address(0));
        token.donate{value: 10 ether}();
        assertGt(token.floor(), token.lastPrice());
        uint256 q = token.quoteSell(1);
        uint256 lp = token.lastPrice();
        assertEq(q, lp - (lp * 1) / 10000 - (lp * 1) / 10000 - (lp * 2) / 10000);
    }

    function test_maxLossBps() public view {
        // Empty curve: the one buyer is the whole reserve, so only fees are lost (1 - 0.9996^2, rounded up).
        assertEq(token.maxLossBps(), 8);
    }

    /// @dev Buy one unit at nextPrice, sell it straight back, revert. Returns the realized loss
    ///      in bps (rounded up, as maxLossBps rounds) and asserts maxLossBps predicted it exactly.
    function _probeRoundTrip(NguToken t) internal returns (uint256 lossBps) {
        uint256 predicted = t.maxLossBps();
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        uint256 cost = t.buy{value: 100 ether}(1, address(0));
        vm.prank(bob);
        uint256 payout = t.sell(1, payable(address(0)), 0);
        vm.revertToState(snap);
        lossBps = ((cost - payout) * 10_000 + cost - 1) / cost;
        assertEq(predicted, lossBps);
    }

    /// @dev 1ST-like: base 0.01, step 1%, beta 90%, no seed. floor / beta sets the price for
    ///      the first buys, then the step term takes over and the floor falls behind.
    function test_maxLossBpsTracksCurveWhenStepBinds() public {
        address a = launcher.launch("1ST", "1ST", 1000, 0.01 ether, 100, 9000, 0);
        NguToken t = NguToken(payable(a));
        bool sawBeta;
        bool sawStep;
        for (uint256 i; i < 246; i++) {
            uint256 f = t.floor();
            uint256 p1 = (t.lastPrice() * 10_100) / 10_000;
            uint256 p2 = t.supply() == 0 ? 0 : (t.reserve() * 10_000) / (9000 * t.supply());
            if (t.minted() > 0 && p2 > p1) sawBeta = true;
            if (t.minted() > 0 && p1 > p2) sawStep = true;
            uint256 loss = _probeRoundTrip(t);
            if (f > 0) assertLe(f * 10_000, t.nextPrice() * 9000 + 10_000); // floor <= beta * price
            if (i == 245) assertGt(loss, 5000);
            vm.prank(alice);
            t.buy{value: 10 ether}(1, address(0));
        }
        assertTrue(sawBeta && sawStep);
        // Floor well under half of the last price; the old formula said 1004 here.
        assertLt(t.floor() * 2, t.lastPrice());
        assertGt(t.maxLossBps(), 5000);
    }

    /// @dev cc40-like: base 0.23, 1000 seed tokens backed by 40 $xMoney. The floor starts
    ///      at ~17% of price, so a round trip loses ~83% from the very first buy.
    function test_maxLossBpsTracksSeededCurve() public {
        vm.deal(address(this), 100 ether);
        address a = launcher.launch{value: 40 ether}("cc40", "cc40", 2000, 0.23 ether, 100, 9000, 1000);
        NguToken t = NguToken(payable(a));
        for (uint256 i; i < 30; i++) {
            uint256 loss = _probeRoundTrip(t);
            assertGt(loss, 8000);
            vm.prank(alice);
            t.buy{value: 10 ether}(1, address(0));
        }
        // A donation lifts the floor until floor / beta sets the price; the gap closes toward 1 - beta.
        vm.prank(bob);
        t.donate{value: 400 ether}();
        uint256 lossAfter = _probeRoundTrip(t);
        assertLt(lossAfter, 1004);
    }

    function test_warpEscrowIsSupplyNeutral() public {
        vm.prank(alice);
        token.buy{value: 10 ether}(5, address(0));
        uint256 fBefore = token.floor();
        uint256 rBefore = token.reserve();
        address escrow = address(0xE5C207);
        vm.prank(alice);
        token.transfer(escrow, 2 ether);
        assertEq(token.floor(), fBefore);
        assertEq(token.reserve(), rBefore);
        assertEq(token.totalSupply(), 5 ether);
    }
}
