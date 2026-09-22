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
    address dead = 0x000000000000000000000000000000000000dEaD;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant BASE = 1 ether;
    uint16 constant STEP = 100;
    uint16 constant BETA = 9000;

    function setUp() public {
        launcher = new NguLauncher(fanout);
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
        assertEq(token.reserve(), BASE - BASE / 10000 - BASE / 10000);
    }

    function test_buyRoutesBurnAndRake() public {
        vm.prank(alice);
        token.buy{value: BASE}(1, address(0));
        assertEq(dead.balance, BASE / 10000);
        assertEq(fanout.balance, BASE / 10000);
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
        uint256 expected = basis - (basis * 1) / 10000 - (basis * 1) / 10000;
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
        assertEq(q, token.lastPrice() - (token.lastPrice() * 2) / 10000);
    }

    function test_maxLossBps() public view {
        assertEq(token.maxLossBps(), 1002);
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
