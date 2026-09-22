// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {XMoneyEscrow} from "../src/XMoneyEscrow.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

contract XMoneyEscrowTest is Test {
    XMoneyEscrow public escrow;

    address payable public alice = payable(address(0x1111));
    address payable public bob = payable(address(0x2222));
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The L4 rake lands in a FanoutSink that bridges to the Robinhood fanout; the sink IS the fanout here.
    address public constant PARENT_FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public FANOUT;

    function setUp() public {
        FANOUT = address(new FanoutSink(PARENT_FANOUT));
        escrow = new XMoneyEscrow(FANOUT);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function test_sellAskFlowNativeXMoney() public {
        // Alice posts Sell Ask for 1,000 xMoney at $1.02/unit
        vm.prank(alice);
        uint256 orderId = escrow.createSellAsk{value: 1000 ether}("alice_x", 1000 ether, 10200, 10 ether, 500 ether);
        assertEq(orderId, 0);
        assertEq(address(escrow).balance, 1000 ether);

        // Bob fills 200 xMoney from Alice's Ask
        vm.prank(bob);
        uint256 tradeId = escrow.fillSellAsk(0, 200 ether, "bob_x");
        (, , , , , , , uint256 expectedCents, , , ) = escrow.trades(tradeId);
        assertEq(expectedCents, 20400); // 200 * $1.02 = $204.00

        uint256 bobBalBefore = bob.balance;
        uint256 deadBalBefore = DEAD.balance;
        uint256 fanoutBalBefore = FANOUT.balance;

        // Only the seller can release
        vm.prank(bob);
        vm.expectRevert(XMoneyEscrow.Unauthorized.selector);
        escrow.releaseTrade(tradeId);

        // Alice confirms fiat on X Money and releases xMoney
        vm.prank(alice);
        escrow.releaseTrade(tradeId);

        uint256 expectedBurn = (200 ether * 1) / 10000;
        uint256 expectedRake = (200 ether * 1) / 10000;
        uint256 expectedNet = 200 ether - expectedBurn - expectedRake;

        assertEq(DEAD.balance - deadBalBefore, expectedBurn);
        assertEq(FANOUT.balance - fanoutBalBefore, expectedRake);
        assertEq(bob.balance - bobBalBefore, expectedNet);
        assertEq(escrow.totalXMoneyBurned(), expectedBurn);
        assertEq(escrow.totalXMoneyRakedToFanout(), expectedRake);
        assertEq(escrow.totalSettledVolumeXMoney(), 200 ether);

        // Alice cancels the rest and gets 800 back
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        escrow.cancelOrder(0);
        assertEq(alice.balance - aliceBefore, 800 ether);
        assertEq(address(escrow).balance, 0);
    }

    function test_drainedAskDeactivatesAndTimeoutFundsReclaimable() public {
        vm.prank(alice);
        escrow.createSellAsk{value: 10 ether}("alice_x", 10 ether, 10200, 5 ether, 10 ether);
        vm.prank(bob);
        uint256 t = escrow.fillSellAsk(0, 10 ether, "bob_x");
        (, , , uint256 avail, , , , bool active) = escrow.orders(0);
        assertEq(avail, 0); assertFalse(active);
        // bob never pays: alice times it out; funds return to the (inactive) order and she can reclaim them
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(alice); escrow.cancelTradeTimeout(t);
        uint256 before = alice.balance;
        vm.prank(alice); escrow.cancelOrder(0);
        assertEq(alice.balance - before, 10 ether);
        vm.prank(alice); vm.expectRevert(XMoneyEscrow.OrderNotActive.selector); escrow.cancelOrder(0);
    }

    function test_sellAskValueMismatchReverts() public {
        vm.prank(alice);
        vm.expectRevert(XMoneyEscrow.ValueMismatch.selector);
        escrow.createSellAsk{value: 999 ether}("alice_x", 1000 ether, 10200, 10 ether, 500 ether);
    }

    function test_buyBidFlowNativeXMoney() public {
        // Alice posts Buy Bid (wants up to 1,000 xMoney at $0.98/unit)
        vm.prank(alice);
        uint256 orderId = escrow.createBuyBid("alice_x", 1000 ether, 9800, 10 ether, 500 ether);
        assertEq(orderId, 0);

        // Bob fills Alice's Buy Bid by depositing 300 xMoney into escrow
        vm.prank(bob);
        uint256 tradeId = escrow.fillBuyBid{value: 300 ether}(0, 300 ether, "bob_x");
        assertEq(address(escrow).balance, 300 ether);

        uint256 aliceBalBefore = alice.balance;
        uint256 deadBalBefore = DEAD.balance;
        uint256 fanoutBalBefore = FANOUT.balance;

        // Bob confirms fiat on X Money from Alice and releases
        vm.prank(bob);
        escrow.releaseTrade(tradeId);

        uint256 expectedBurn = (300 ether * 1) / 10000;
        uint256 expectedRake = (300 ether * 1) / 10000;
        uint256 expectedNet = 300 ether - expectedBurn - expectedRake;

        assertEq(DEAD.balance - deadBalBefore, expectedBurn);
        assertEq(FANOUT.balance - fanoutBalBefore, expectedRake);
        assertEq(alice.balance - aliceBalBefore, expectedNet);
    }

    function test_bidTimeoutRefundsSeller() public {
        vm.prank(alice);
        escrow.createBuyBid("alice_x", 1000 ether, 9800, 10 ether, 500 ether);

        vm.prank(bob);
        uint256 tradeId = escrow.fillBuyBid{value: 100 ether}(0, 100 ether, "bob_x");

        vm.prank(bob);
        vm.expectRevert(XMoneyEscrow.TradeDeadlineNotPassed.selector);
        escrow.cancelTradeTimeout(tradeId);

        vm.warp(block.timestamp + 16 minutes);
        uint256 before = bob.balance;
        vm.prank(bob);
        escrow.cancelTradeTimeout(tradeId);
        assertEq(bob.balance - before, 100 ether);
    }
}
