// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

contract FomoAttritionL4Test is Test {
    FomoAttritionL4 public game;

    address payable public alice = payable(address(0xAAAA));
    address payable public bob = payable(address(0xBBBB));
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The L4 rake lands in a FanoutSink that bridges to the Robinhood fanout; the sink IS the fanout here.
    address public constant PARENT_FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public FANOUT;

    function setUp() public {
        FANOUT = address(new FanoutSink(PARENT_FANOUT));
        game = new FomoAttritionL4(FANOUT);
        // Native $xMoney on Orbit L4
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function test_buyKeysAndDividendsInNativeXMoney() public {
        uint256 cost = game.getKeyPrice() * 10;
        vm.prank(alice);
        game.buyKeys{value: cost}("alice_x", 10);

        assertEq(game.totalKeys(), 10);
        assertEq(game.currentLeader(), alice);
        assertEq(game.currentLeaderXHandle(), "alice_x");
        assertEq(DEAD.balance, cost / 10000);
        assertEq(FANOUT.balance, cost / 10000);

        uint256 bobCost = game.getKeyPrice() * 10;
        vm.prank(bob);
        game.buyKeys{value: bobCost + 1 ether}("bob_x", 10); // overpay -> refunded
        assertEq(bob.balance, 1000 ether - bobCost);

        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        game.claimDividends();

        assertTrue(alice.balance > aliceBalBefore);
        assertTrue(game.totalBurned() > 0);
        assertTrue(game.totalFanoutRaked() > 0);

        // Nothing left to claim
        vm.prank(alice);
        vm.expectRevert(FomoAttritionL4.NoDividendsToClaim.selector);
        game.claimDividends();
    }

    function test_revertsOnUnderpayment() public {
        uint256 cost = game.getKeyPrice() * 5;
        vm.prank(alice);
        vm.expectRevert(FomoAttritionL4.InsufficientPayment.selector);
        game.buyKeys{value: cost - 1}("alice_x", 5);
    }

    function test_winJackpotInNativeXMoneyOnExpiration() public {
        uint256 cost = game.getKeyPrice() * 5;
        vm.prank(alice);
        game.buyKeys{value: cost}("alice_champ", 5);

        uint256 pot = game.jackpotPot();
        assertTrue(pot > 0);

        vm.expectRevert(FomoAttritionL4.RoundNotExpired.selector);
        game.claimJackpot();

        vm.warp(game.roundDeadline() + 1);

        uint256 aliceBalBefore = alice.balance;
        game.claimJackpot();

        uint256 expectedNet = pot - (pot / 10000) * 2;
        assertEq(alice.balance - aliceBalBefore, expectedNet);
        assertEq(game.roundId(), 2);
        assertEq(game.jackpotPot(), 0);
        assertEq(game.totalKeys(), 0);

        // New round accepts buys again
        uint256 c2 = game.getKeyPrice();
        vm.prank(bob);
        game.buyKeys{value: c2}("bob_x", 1);
        assertEq(game.currentLeader(), bob);

        // A round-1 player can buy into round 2 without underflowing on stale reward debt
        uint256 c3 = game.getKeyPrice();
        vm.prank(alice);
        game.buyKeys{value: c3}("alice_champ", 1);
        assertEq(game.currentLeader(), alice);
        (uint256 aliceKeysR2,,,) = game.players(alice);
        assertEq(aliceKeysR2, 1);
    }

    function test_pastRoundDividendsStayClaimable() public {
        uint256 cA = game.getKeyPrice() * 10;
        vm.prank(alice);
        game.buyKeys{value: cA}("alice", 10);
        uint256 cB = game.getKeyPrice() * 10;
        vm.prank(bob);
        game.buyKeys{value: cB}("bob", 10); // alice earns dividends from this
        uint256 owedR1 = game.pendingDividendsOf(alice);
        assertGt(owedR1, 0);

        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot(); // round 2 starts; round 1 accumulator frozen
        assertEq(game.pendingDividendsOf(alice), 0);              // nothing in round 2 yet
        assertEq(game.pendingDividendsOfRound(1, alice), owedR1); // round 1 still owed

        uint256 before = alice.balance;
        vm.prank(alice);
        game.claimDividendsForRound(1);
        assertEq(alice.balance - before, owedR1 - (owedR1 / 10000) * 2);

        vm.prank(alice);
        vm.expectRevert(FomoAttritionL4.NoDividendsToClaim.selector);
        game.claimDividendsForRound(1);
    }
}
