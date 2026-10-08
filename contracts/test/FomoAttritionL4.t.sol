// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

/// @dev A winner that rejects native $xMoney outright.
contract RejectingWinner {
    function buy(FomoAttritionL4 game, uint256 n) external payable {
        game.buyKeys{value: msg.value}("rejector", n);
    }

    function withdraw(FomoAttritionL4 game, address payable to) external {
        game.withdrawJackpot(to);
    }

    receive() external payable {
        revert("no xMoney");
    }
}

/// @dev A winner whose receive burns every unit of gas it is given.
contract GasBurnerWinner {
    function buy(FomoAttritionL4 game, uint256 n) external payable {
        game.buyKeys{value: msg.value}("burner", n);
    }

    receive() external payable {
        while (true) {}
    }
}

/// @dev A winner that tries to re-enter withdrawJackpot while being paid.
contract ReentrantWithdrawer {
    FomoAttritionL4 public game;
    bool public accept;

    function buy(FomoAttritionL4 g, uint256 n) external payable {
        game = g;
        g.buyKeys{value: msg.value}("reenter", n);
    }

    function withdrawToSelf() external {
        accept = true;
        game.withdrawJackpot(payable(address(this)));
    }

    receive() external payable {
        if (!accept) revert("not yet");
        game.withdrawJackpot(payable(address(this))); // must revert -> whole withdraw reverts
    }
}

contract FomoAttritionL4Test is Test {
    FomoAttritionL4 public game;

    address payable public alice = payable(address(0xAAAA));
    address payable public bob = payable(address(0xBBBB));
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The L4 rake lands in a FanoutSink that bridges to the Robinhood fanout; the sink IS the fanout here.
    address public constant PARENT_FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public FANOUT;
    address public BUYBACK;

    function setUp() public {
        FANOUT = address(new FanoutSink(PARENT_FANOUT));
        BUYBACK = address(new FanoutSink(makeAddr("xgasDevBuyback")));
        game = new FomoAttritionL4(FANOUT, BUYBACK);
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
        assertEq(BUYBACK.balance, (cost * 2) / 10000);
        assertEq(game.totalBuyback(), (cost * 2) / 10000);

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
        uint256 carried = game.nextRoundSeed();
        assertGt(carried, 0);
        game.claimJackpot();

        uint256 expectedNet = pot - (pot / 10000) * 2 - (pot * 2) / 10000;
        assertEq(alice.balance - aliceBalBefore, expectedNet);
        assertEq(game.roundId(), 2);
        assertEq(game.jackpotPot(), carried); // round 1's remainder opens round 2's pot
        assertEq(game.nextRoundSeed(), 0);
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
        assertEq(alice.balance - before, owedR1 - (owedR1 / 10000) * 2 - (owedR1 * 2) / 10000);

        vm.prank(alice);
        vm.expectRevert(FomoAttritionL4.NoDividendsToClaim.selector);
        game.claimDividendsForRound(1);
    }

    // ---------------------------------------------------------------------------------------------
    // Dividend + remainder accounting
    // ---------------------------------------------------------------------------------------------

    function _fees(uint256 amt) internal pure returns (uint256) {
        return amt / 10000 + amt / 10000 + (amt * 2) / 10000;
    }

    function _assertLedger() internal view {
        assertEq(
            address(game).balance,
            game.jackpotPot() + game.nextRoundSeed() + game.dividendReserve() + game.totalJackpotOwed(),
            "ledger"
        );
    }

    function test_soleBuyerEarnsTheirOwnDividendShare() public {
        uint256 cost = game.getKeyPrice() * 10;
        vm.prank(alice);
        game.buyKeys{value: cost}("alice", 10);

        uint256 div = (cost * 5500) / 10000;
        uint256 owed = game.pendingDividendsOf(alice);
        // Old code: 0 (the buyer's rewardDebt was reset after the raise and the 55% was stranded).
        assertApproxEqAbs(owed, div, 1);
        assertLe(owed, game.dividendReserve());
        _assertLedger();

        uint256 before = alice.balance;
        vm.prank(alice);
        game.claimDividends();
        assertEq(alice.balance - before, owed - _fees(owed));
        _assertLedger();
    }

    function test_buyerSharesOwnPurchaseProRata() public {
        uint256 cA = game.getKeyPrice() * 10;
        vm.prank(alice);
        game.buyKeys{value: cA}("alice", 10);
        uint256 cB = game.getKeyPrice() * 30;
        vm.prank(bob);
        game.buyKeys{value: cB}("bob", 30);

        uint256 dA = (cA * 5500) / 10000;
        uint256 dB = (cB * 5500) / 10000;
        assertApproxEqAbs(game.pendingDividendsOf(alice), dA + (dB * 10) / 40, 2);
        assertApproxEqAbs(game.pendingDividendsOf(bob), (dB * 30) / 40, 2);
        assertLe(game.pendingDividendsOf(alice) + game.pendingDividendsOf(bob), game.dividendReserve());
        assertApproxEqAbs(game.pendingDividendsOf(alice) + game.pendingDividendsOf(bob), dA + dB, 3);

        // A repeat buyer settles old keys first, then shares in the new buy with all their keys.
        uint256 aliceBefore = game.pendingDividendsOf(alice);
        uint256 cA2 = game.getKeyPrice() * 10;
        vm.prank(alice);
        game.buyKeys{value: cA2}("alice", 10);
        uint256 dA2 = (cA2 * 5500) / 10000;
        assertApproxEqAbs(game.pendingDividendsOf(alice), aliceBefore + (dA2 * 20) / 50, 3);
        assertApproxEqAbs(game.pendingDividendsOf(bob), (dB * 30) / 40 + (dA2 * 30) / 50, 3);
        _assertLedger();
    }

    function test_remainderCarriesIntoNextRoundJackpot() public {
        uint256 cost = game.getKeyPrice() * 7;
        vm.prank(alice);
        game.buyKeys{value: cost}("alice", 7);

        uint256 jackpot = (cost * 3500) / 10000;
        assertEq(game.jackpotPot(), jackpot);
        // 9.96% remainder plus index truncation dust, to the wei.
        assertEq(game.nextRoundSeed(), cost - _fees(cost) - jackpot - game.dividendReserve());
        assertApproxEqAbs(game.nextRoundSeed(), (cost * 996) / 10000, 2);
        _assertLedger();

        uint256 seed1 = game.nextRoundSeed();
        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot();
        assertEq(game.roundId(), 2);
        assertEq(game.jackpotPot(), seed1);
        assertEq(game.nextRoundSeed(), 0);
        _assertLedger();

        // Round 2's winner takes the carried seed plus round 2's own 35%.
        uint256 c2 = game.getKeyPrice() * 3;
        vm.prank(bob);
        game.buyKeys{value: c2}("bob", 3);
        uint256 pot2 = seed1 + (c2 * 3500) / 10000;
        assertEq(game.jackpotPot(), pot2);
        vm.warp(game.roundDeadline() + 1);
        uint256 bobBefore = bob.balance;
        game.claimJackpot();
        assertEq(bob.balance - bobBefore, pot2 - _fees(pot2));
        _assertLedger();
    }

    function test_plainTransferIsAJackpotDonation() public {
        vm.prank(bob);
        (bool ok, ) = address(game).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(game.jackpotPot(), 5 ether);
        _assertLedger();
    }

    /// @dev Random buys, claims and round ends across 4 players. After every step:
    ///      balance == jackpot + carried + dividendReserve == funded - buy fees - paid out (exact),
    ///      and the sum of every claimable balance never exceeds dividendReserve (rounding dust only).
    function testFuzz_ledgerIsExact(uint256 seed) public {
        address payable[4] memory ps = [alice, bob, payable(address(0xCCCC)), payable(address(0xDDDD))];
        for (uint256 i; i < 4; i++) vm.deal(ps[i], 100_000 ether);

        RejectingWinner rejector = new RejectingWinner();
        vm.deal(address(this), 100_000 ether);
        uint256 owedToRejector;
        uint256 fundedNet;   // sum over buys of cost minus the 4 bp legs
        uint256 paidGross;   // jackpots won + dividends claimed, before their 4 bp legs
        uint256 steps = 24;
        for (uint256 i; i < steps; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 10;
            address payable who = ps[(r >> 8) % 4];
            if (kind < 6) {
                uint256 n = 1 + ((r >> 16) % 40);
                uint256 cost = game.getKeyPrice() * n;
                vm.prank(who);
                game.buyKeys{value: cost + 1 ether}("p", n);
                fundedNet += cost - _fees(cost);
            } else if (kind < 8) {
                uint256 owed = game.pendingDividendsOf(who);
                if (owed > 0) {
                    vm.prank(who);
                    game.claimDividends();
                    paidGross += owed;
                }
            } else if (kind < 9 || game.totalKeys() == 0) {
                // A winner that rejects $xMoney takes the lead: its prize must defer, not stall.
                uint256 n = 1 + ((r >> 16) % 5);
                uint256 cost = game.getKeyPrice() * n;
                rejector.buy{value: cost}(game, n);
                fundedNet += cost - _fees(cost);
            } else {
                vm.warp(game.roundDeadline() + 1);
                uint256 pot = game.jackpotPot();
                bool deferred = game.currentLeader() == address(rejector);
                uint256 roundBefore = game.roundId();
                game.claimJackpot();
                assertEq(game.roundId(), roundBefore + 1, "round advances");
                if (deferred) {
                    owedToRejector += pot - _fees(pot);
                    paidGross += _fees(pot); // only the legs left the contract
                } else {
                    paidGross += pot;
                }
            }
            _assertLedger();
            assertEq(game.jackpotOwed(address(rejector)), owedToRejector, "owed");
            assertEq(game.totalJackpotOwed(), owedToRejector, "total owed");
            assertEq(
                fundedNet - paidGross,
                game.jackpotPot() + game.nextRoundSeed() + game.dividendReserve() + game.totalJackpotOwed(),
                "funded - paid"
            );
            // The rejector earns dividends too; it just cannot take them by push.
            uint256 claimable = _sumClaimable(ps) + _sumClaimableOf(address(rejector));
            assertLe(claimable, game.dividendReserve(), "claimable <= reserve");
            assertLe(game.dividendReserve() - claimable, 4 * steps, "dust");
        }

        // Everyone drains every round; no claim can fail for lack of funds.
        for (uint256 rd = 1; rd <= game.roundId(); rd++) {
            for (uint256 j; j < 4; j++) {
                uint256 owed = game.pendingDividendsOfRound(rd, ps[j]);
                if (owed == 0) continue;
                vm.prank(ps[j]);
                game.claimDividendsForRound(rd);
                paidGross += owed;
            }
        }
        _assertLedger();
        assertEq(
            fundedNet - paidGross,
            game.jackpotPot() + game.nextRoundSeed() + game.dividendReserve() + game.totalJackpotOwed()
        );
        // What is left is the rejector's unclaimable-by-push dividends plus rounding dust.
        uint256 rejectorDivs = _sumClaimableOf(address(rejector));
        assertLe(rejectorDivs, game.dividendReserve());
        assertLe(game.dividendReserve() - rejectorDivs, 4 * steps);

        // The rejector pulls everything it is owed to an address that can take it.
        if (owedToRejector > 0) {
            address payable sink = payable(makeAddr("rejectorSink"));
            rejector.withdraw(game, sink);
            assertEq(sink.balance, owedToRejector);
            assertEq(game.totalJackpotOwed(), 0);
            _assertLedger();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Winners that cannot take a push
    // ---------------------------------------------------------------------------------------------

    function test_rejectingWinnerDefersPrizeAndRoundAdvances() public {
        RejectingWinner w = new RejectingWinner();
        vm.deal(address(this), 100 ether);
        uint256 cost = game.getKeyPrice() * 5;
        w.buy{value: cost}(game, 5);
        assertEq(game.currentLeader(), address(w));

        uint256 pot = game.jackpotPot();
        uint256 carried = game.nextRoundSeed();
        uint256 net = pot - _fees(pot);
        uint256 deadBefore = DEAD.balance;
        vm.warp(game.roundDeadline() + 1);

        vm.expectEmit(true, false, false, true, address(game));
        emit FomoAttritionL4.JackpotDeferred(address(w), 1, net);
        game.claimJackpot(); // old code: reverted TransferFailed forever

        assertEq(game.roundId(), 2, "round advanced");
        assertEq(game.jackpotPot(), carried, "seed opened round 2");
        assertEq(game.currentLeader(), address(0));
        assertEq(game.jackpotOwed(address(w)), net);
        assertEq(game.totalJackpotOwed(), net);
        assertEq(address(w).balance, 0);
        assertEq(DEAD.balance - deadBefore, pot / 10000, "fee legs still paid");
        _assertLedger();

        // Round 2 plays normally.
        uint256 c2 = game.getKeyPrice();
        vm.prank(bob);
        game.buyKeys{value: c2}("bob", 1);
        assertEq(game.currentLeader(), bob);
        _assertLedger();

        // The winner pulls to another address.
        address payable sink = payable(makeAddr("sink"));
        vm.expectEmit(true, true, false, true, address(game));
        emit FomoAttritionL4.JackpotWithdrawn(address(w), sink, net);
        w.withdraw(game, sink);
        assertEq(sink.balance, net);
        assertEq(game.jackpotOwed(address(w)), 0);
        assertEq(game.totalJackpotOwed(), 0);
        _assertLedger();

        vm.expectRevert(FomoAttritionL4.NothingOwed.selector);
        w.withdraw(game, sink);
    }

    function test_withdrawToRejectingAddressRevertsAndKeepsCredit() public {
        RejectingWinner w = new RejectingWinner();
        vm.deal(address(this), 100 ether);
        w.buy{value: game.getKeyPrice() * 2}(game, 2);
        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot();
        uint256 owed = game.jackpotOwed(address(w));
        assertGt(owed, 0);

        vm.expectRevert(FomoAttritionL4.TransferFailed.selector);
        w.withdraw(game, payable(address(w)));
        assertEq(game.jackpotOwed(address(w)), owed, "credit kept");

        vm.expectRevert(FomoAttritionL4.ZeroAddress.selector);
        w.withdraw(game, payable(address(0)));
        _assertLedger();
    }

    function test_gasBurningWinnerCannotStallTheRound() public {
        GasBurnerWinner w = new GasBurnerWinner();
        vm.deal(address(this), 100 ether);
        w.buy{value: game.getKeyPrice() * 3}(game, 3);
        uint256 pot = game.jackpotPot();
        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot{gas: 1_000_000}();
        assertEq(game.roundId(), 2);
        assertEq(game.jackpotOwed(address(w)), pot - _fees(pot));
        _assertLedger();
    }

    function test_withdrawJackpotIsNotReentrant() public {
        ReentrantWithdrawer w = new ReentrantWithdrawer();
        vm.deal(address(this), 100 ether);
        w.buy{value: game.getKeyPrice() * 2}(game, 2);
        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot(); // push rejected (accept == false) -> deferred
        uint256 owed = game.jackpotOwed(address(w));
        assertGt(owed, 0);

        vm.expectRevert(FomoAttritionL4.TransferFailed.selector); // inner Reentrancy bubbles as a failed send
        w.withdrawToSelf();
        assertEq(game.jackpotOwed(address(w)), owed);
        _assertLedger();
    }

    function test_nobodyElseCanWithdrawAWinnersPrize() public {
        RejectingWinner w = new RejectingWinner();
        vm.deal(address(this), 100 ether);
        w.buy{value: game.getKeyPrice() * 2}(game, 2);
        vm.warp(game.roundDeadline() + 1);
        game.claimJackpot();
        vm.prank(bob);
        vm.expectRevert(FomoAttritionL4.NothingOwed.selector);
        game.withdrawJackpot(bob);
    }

    function _sumClaimableOf(address who) internal view returns (uint256 sum) {
        for (uint256 rd = 1; rd <= game.roundId(); rd++) sum += game.pendingDividendsOfRound(rd, who);
    }

    function _sumClaimable(address payable[4] memory ps) internal view returns (uint256 sum) {
        for (uint256 rd = 1; rd <= game.roundId(); rd++) {
            for (uint256 j; j < 4; j++) sum += game.pendingDividendsOfRound(rd, ps[j]);
        }
    }
}
