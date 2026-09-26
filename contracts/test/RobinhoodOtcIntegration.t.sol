// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RobinhoodEthOtc} from "../src/RobinhoodEthOtc.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {Outcome} from "../src/interfaces/IOtcArbitration.sol";

/// @dev WETH stand-in: holds the wrapped ETH so global ETH conservation can be checked.
contract IntegWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Shared deployment + accounting helpers for the real escrow wired to the real arbitration.
abstract contract IntegBase is Test {
    RobinhoodEthOtc esc;
    OtcArbitration arb;
    IntegWETH weth;
    address fanout = makeAddr("feeFanout");

    uint256 constant PRICE = 300_000; // $3,000.00 per ETH, in cents

    function _deploy() internal {
        vm.warp(1_700_000_000);
        weth = new IntegWETH();
        arb = new OtcArbitration();
        esc = new RobinhoodEthOtc(address(weth), fanout, address(arb));
        arb.bind(address(esc));
    }

    /// escrow: balance == Sell-order ETH + ETH of Open/Paid/Disputed trades + credits + deferred fee
    function _escrowAccounted() internal view returns (uint256 sum) {
        RobinhoodEthOtc.Order[] memory os = esc.getOrders(0, type(uint256).max);
        for (uint256 i; i < os.length; ++i) {
            if (os[i].side == RobinhoodEthOtc.Side.Sell) sum += os[i].remainingEth;
        }
        RobinhoodEthOtc.Trade[] memory ts = esc.getTrades(0, type(uint256).max);
        for (uint256 i; i < ts.length; ++i) {
            RobinhoodEthOtc.TradeStatus s = ts[i].status;
            if (
                s == RobinhoodEthOtc.TradeStatus.Open || s == RobinhoodEthOtc.TradeStatus.Paid
                    || s == RobinhoodEthOtc.TradeStatus.Disputed
            ) sum += ts[i].ethAmount;
        }
        sum += esc.totalEthOwed() + esc.pendingFanout();
    }

    function _assertEscrowSolvent() internal view {
        assertEq(address(esc).balance, _escrowAccounted(), "escrow balance != accounted");
    }

    /// arbitration: balance + slashes not yet deducted == stake + claimable + bonds + unsettled rewards
    function _assertArbSolvent() internal view {
        assertEq(
            address(arb).balance + arb.slashesUnsettled(),
            arb.totalStaked() + arb.totalClaimable() + arb.bondsHeld() + arb.rewardsUnsettled(),
            "arbitration balance != accounted"
        );
    }

    function _commitment(uint256 tid, uint8 vote, bytes32 salt, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode(tid, vote, salt, who));
    }

    function _salt(uint256 tid, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", tid, who));
    }

    function _status(uint256 tid) internal view returns (RobinhoodEthOtc.TradeStatus) {
        return esc.getTrade(tid).status;
    }

    function _arbOutcome(uint256 tid) internal view returns (uint8 o) {
        (,,,,,,,, o,,,) = arb.disputeOf(tid);
    }

    function _arbResolved(uint256 tid) internal view returns (bool r) {
        (,,,,,,, r,,,,) = arb.disputeOf(tid);
    }

    function _arbStake(address a) internal view returns (uint256 s) {
        (s,,,) = arb.arbiterOf(a);
    }

    function _arbClaimable(address a) internal view returns (uint256 c) {
        (,, c,) = arb.arbiterOf(a);
    }
}

// ============================================================================ scenario tests

contract RobinhoodOtcIntegrationTest is IntegBase {
    address maker = makeAddr("maker");
    address taker = makeAddr("taker");
    address[5] judges;
    address whale = makeAddr("whaleJudge");

    uint256 TOTAL; // every wei in the system, fixed after setUp

    function setUp() public {
        _deploy();
        vm.deal(maker, 100 ether);
        vm.deal(taker, 100 ether);
        for (uint256 i; i < 5; ++i) {
            judges[i] = makeAddr(string.concat("judge", vm.toString(i)));
            vm.deal(judges[i], 1 ether);
            vm.prank(judges[i]);
            arb.stake{value: 0.1 ether}();
        }
        vm.deal(whale, 5 ether);
        vm.prank(whale);
        arb.stake{value: 3 ether}();
        vm.warp(block.timestamp + arb.STAKE_AGE()); // every arbiter above may vote on disputes opened from now on
        TOTAL = _systemEth();
    }

    function _systemEth() internal view returns (uint256 t) {
        t = maker.balance + taker.balance + whale.balance + address(esc).balance + address(arb).balance
            + address(weth).balance;
        for (uint256 i; i < 5; ++i) {
            t += judges[i].balance;
        }
    }

    function _checkAll() internal view {
        _assertEscrowSolvent();
        _assertArbSolvent();
        assertEq(_systemEth(), TOTAL, "ETH created or destroyed");
        assertEq(esc.pendingFanout(), 0);
    }

    // ---------------------------------------------------------------- helpers

    function _sellTrade(uint256 eth) internal returns (uint256 oid, uint256 tid) {
        vm.prank(maker);
        oid = esc.postSell{value: 2 * eth}("maker_x", PRICE, eth / 10, eth);
        vm.prank(taker);
        tid = esc.takeSell(oid, eth, "taker_x");
    }

    function _buyTrade(uint256 eth) internal returns (uint256 oid, uint256 tid) {
        // maker wants ETH and pays dollars; the taker escrows ETH as the seller
        vm.prank(maker);
        oid = esc.postBuy("maker_x", 2 * eth, PRICE, eth / 10, eth);
        vm.prank(taker);
        tid = esc.takeBuy{value: eth}(oid, "taker_x");
    }

    function _paid(uint256 tid) internal {
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        vm.prank(t.buyer);
        esc.markPaid(tid, "X Money ref 123");
    }

    function _disputed(uint256 tid) internal returns (uint256 bond) {
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        bond = esc.bondFor(t.ethAmount);
        vm.prank(t.seller);
        esc.dispute{value: bond}(tid, "no dollars arrived");
    }

    function _commit(uint256 tid, address j, uint8 vote) internal {
        vm.prank(j);
        arb.commitVote(tid, _commitment(tid, vote, _salt(tid, j), j));
    }

    function _reveal(uint256 tid, address j, uint8 vote) internal {
        vm.prank(j);
        arb.revealVote(tid, vote, _salt(tid, j));
    }

    function _toReveal(uint256 tid) internal {
        (,,,, uint64 commitEnd,,,,,,,) = arb.disputeOf(tid);
        vm.warp(uint256(commitEnd) + 1);
    }

    function _toResolve(uint256 tid) internal {
        (,,,,, uint64 revealEnd,,,,,,) = arb.disputeOf(tid);
        vm.warp(uint256(revealEnd) + 1);
    }

    function _resolveToEnd(uint256 tid) internal {
        while (!_arbResolved(tid)) {
            _toResolve(tid);
            arb.resolve(tid);
        }
    }

    // ---------------------------------------------------------------- happy paths

    function test_sell_markPaid_release_feeToFanout() public {
        (uint256 oid, uint256 tid) = _sellTrade(1 ether);
        assertEq(esc.getTrade(tid).expectedCents, 300_000);
        _paid(tid);
        uint256 b0 = taker.balance;
        vm.prank(maker);
        esc.release(tid);
        assertEq(taker.balance - b0, 0.999 ether);
        assertEq(weth.balanceOf(fanout), 0.001 ether); // the whole 0.1% fee
        assertEq(address(arb).balance, arb.totalStaked()); // nothing to arbitration
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        _checkAll();
    }

    function test_sell_claimAfterReleaseWindow() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 paidAt = esc.getTrade(tid).paidAt;
        vm.warp(paidAt + esc.RELEASE_WINDOW());
        vm.prank(taker);
        vm.expectRevert(RobinhoodEthOtc.ReleaseWindowOpen.selector);
        esc.claim(tid);
        vm.warp(paidAt + esc.RELEASE_WINDOW() + 1);
        vm.prank(taker);
        esc.claim(tid);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Claimed));
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        _checkAll();
    }

    function test_buy_markPaid_release() public {
        (, uint256 tid) = _buyTrade(1 ether);
        // maker is the buyer (pays dollars), taker is the seller (escrowed ETH)
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        assertEq(t.buyer, maker);
        assertEq(t.seller, taker);
        _paid(tid);
        uint256 b0 = maker.balance;
        vm.prank(taker);
        esc.release(tid);
        assertEq(maker.balance - b0, 0.999 ether);
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        _checkAll();
    }

    function test_buy_claimAfterReleaseWindow() public {
        (, uint256 tid) = _buyTrade(0.5 ether);
        _paid(tid);
        vm.warp(block.timestamp + esc.RELEASE_WINDOW() + 1);
        uint256 b0 = maker.balance;
        vm.prank(maker);
        esc.claim(tid);
        assertEq(maker.balance - b0, 0.4995 ether);
        _checkAll();
    }

    function test_cancelUnpaid_bothDirections_ordersSurvive() public {
        (uint256 soid, uint256 stid) = _sellTrade(1 ether);
        (uint256 boid, uint256 btid) = _buyTrade(1 ether);
        vm.warp(block.timestamp + esc.PAY_WINDOW() + 1);
        uint256 t0 = taker.balance;
        esc.cancelUnpaid(stid); // anyone
        esc.cancelUnpaid(btid);
        assertEq(esc.getOrder(soid).remainingEth, 2 ether); // back onto the Sell order
        assertTrue(esc.getOrder(soid).active);
        assertEq(taker.balance - t0, 1 ether); // Buy taker gets the escrow back, no fee
        assertEq(esc.getOrder(boid).remainingEth, 2 ether); // Buy order gets the capacity back
        assertEq(weth.balanceOf(fanout), 0);
        _checkAll();
    }

    // ---------------------------------------------------------------- disputes, every outcome

    function test_dispute_buyerPaid_wholeBondToMajority_minoritySlashed() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 bond = _disputed(tid);
        assertEq(bond, 0.05 ether);
        assertEq(arb.bondsHeld(), bond);
        _checkAll();

        vm.prank(taker);
        arb.submitEvidence(tid, "/api/robinhood/evidence/abc.png");
        vm.prank(maker);
        arb.submitEvidence(tid, "nothing on my X Money statement");

        _commit(tid, judges[0], 1);
        _commit(tid, judges[1], 1);
        _commit(tid, judges[2], 2);
        _toReveal(tid);
        _reveal(tid, judges[0], 1);
        _reveal(tid, judges[1], 1);
        _reveal(tid, judges[2], 2);
        _toResolve(tid);

        uint256 buyer0 = taker.balance;
        uint256 seller0 = maker.balance;
        arb.resolve(tid);

        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Resolved));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(_arbOutcome(tid), uint8(Outcome.BuyerPaid));
        assertEq(taker.balance - buyer0, 0.999 ether);
        assertEq(maker.balance, seller0); // bond forfeited
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        assertFalse(esc.flagged(taker));
        assertEq(arb.openDisputeIds().length, 0);

        // reward = bond + minority reserve (10% of 0.1) = 0.06, split by weight 0.1 : 0.1
        assertEq(_arbClaimable(judges[0]), 0.03 ether);
        assertEq(_arbClaimable(judges[1]), 0.03 ether);
        assertEq(_arbStake(judges[2]), 0.09 ether);
        _checkAll();

        uint256 j0 = judges[0].balance;
        vm.prank(judges[0]);
        arb.claimArbiterReward();
        assertEq(judges[0].balance - j0, 0.03 ether);
        arb.settle(tid, judges[2]); // anyone may apply the slash
        (uint256 rawStake,,,,,,) = arb.accountOf(judges[2]);
        assertEq(rawStake, 0.09 ether);
        _checkAll();
    }

    function test_dispute_buyerDidNotPay_sellTrade_refillsOrder_flags_halfBondPaysArbiters() public {
        (uint256 oid, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 bond = _disputed(tid);

        _commit(tid, judges[0], 2);
        _commit(tid, judges[1], 2);
        _commit(tid, judges[2], 1);
        _commit(tid, judges[3], 2); // commits but never reveals: slashed
        _toReveal(tid);
        _reveal(tid, judges[0], 2);
        _reveal(tid, judges[1], 2);
        _reveal(tid, judges[2], 1);
        _toResolve(tid);

        uint256 seller0 = maker.balance;
        uint256 remainingBefore = esc.getOrder(oid).remainingEth;
        arb.resolve(tid);

        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));
        assertEq(esc.getOrder(oid).remainingEth, remainingBefore + 1 ether); // back onto the order
        assertEq(maker.balance - seller0, bond - bond / 2); // half the bond back, no fee on returned ETH
        assertTrue(esc.flagged(taker));
        // reward = bond / 2 + slashes (judge2 minority + judge3 no-reveal) = 0.025 + 0.02, two winners
        assertEq(_arbClaimable(judges[0]), 0.0225 ether);
        assertEq(_arbClaimable(judges[1]), 0.0225 ether);
        assertEq(_arbStake(judges[2]), 0.09 ether);
        assertEq(_arbStake(judges[3]), 0.09 ether);
        _checkAll();

        // a flagged buyer can not take Sell orders or post Buy orders, but can still sell ETH
        vm.prank(taker);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.takeSell(oid, 0.5 ether, "taker_x");
        vm.prank(taker);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.postBuy("taker_x", 1 ether, PRICE, 0.1 ether, 1 ether);
        vm.prank(taker);
        esc.postSell{value: 1 ether}("taker_x", PRICE, 0.1 ether, 1 ether);
        _checkAll();
    }

    function test_dispute_buyerDidNotPay_buyTrade_returnsEthToTaker() public {
        (, uint256 tid) = _buyTrade(1 ether);
        _paid(tid); // maker (buyer) claims to have paid
        uint256 bond = _disputed(tid); // taker (seller) disputes
        _commit(tid, judges[0], 2);
        _commit(tid, judges[1], 2);
        _commit(tid, judges[2], 2);
        _toReveal(tid);
        _reveal(tid, judges[0], 2);
        _reveal(tid, judges[1], 2);
        _reveal(tid, judges[2], 2);
        _toResolve(tid);
        uint256 t0 = taker.balance;
        arb.resolve(tid);
        assertEq(taker.balance - t0, 1 ether + (bond - bond / 2)); // escrow and half the bond back
        assertTrue(esc.flagged(maker));
        // the other half of the bond pays the three winners (the last one to settle also takes the dust)
        uint256 total;
        for (uint256 j; j < 3; ++j) {
            arb.settle(tid, judges[j]);
            (,, uint256 cl,,,,) = arb.accountOf(judges[j]);
            total += cl;
        }
        assertEq(total, bond / 2);
        _checkAll();

        // the flagged maker's remaining Buy order can no longer be taken
        vm.prank(taker);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.takeBuy{value: 0.5 ether}(0, "taker_x");
    }

    function test_dispute_majorityByWeight_whaleWeighsItsWholeStake() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 bond = _disputed(tid);
        // three small judges say BuyerPaid (weight 0.3), the whale says BuyerDidNotPay (weight 3, no cap)
        _commit(tid, judges[0], 1);
        _commit(tid, judges[1], 1);
        _commit(tid, judges[2], 1);
        _commit(tid, whale, 2);
        (, uint256 w,) = arb.commitOf(tid, whale);
        assertEq(w, 3 ether);
        _toReveal(tid);
        _reveal(tid, judges[0], 1);
        _reveal(tid, judges[1], 1);
        _reveal(tid, judges[2], 1);
        _reveal(tid, whale, 2);
        _toResolve(tid);
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));
        // whale takes half the bond + three 0.01 slashes
        assertEq(_arbClaimable(whale), bond / 2 + 0.03 ether);
        assertEq(_arbStake(judges[0]), 0.09 ether);
        assertEq(_arbStake(whale), 3 ether); // the 10% reserve (0.3 ETH) was at risk, not lost
        _checkAll();
    }

    function test_dispute_tie_extends_thenDecidedInExtension() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        _disputed(tid);
        _commit(tid, judges[0], 1);
        _commit(tid, judges[1], 2);
        _toReveal(tid);
        _reveal(tid, judges[0], 1);
        _reveal(tid, judges[1], 2);
        _toResolve(tid);
        arb.resolve(tid); // 2 revealers, tie: extension
        (,,,,,, uint16 extensions, bool resolved,,,,) = arb.disputeOf(tid);
        assertEq(extensions, 1);
        assertFalse(resolved);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Disputed));
        _checkAll();

        // committers whose stake predates the dispute join in the extension; round-1 revealed votes carry over
        _commit(tid, judges[2], 1);
        _commit(tid, judges[3], 1);
        _toReveal(tid);
        _reveal(tid, judges[2], 1);
        _reveal(tid, judges[3], 1);
        _toResolve(tid);
        uint256 b0 = taker.balance;
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(taker.balance - b0, 0.999 ether);
        // reward = bond 0.05 + judge1 slash 0.01, three winners of equal weight
        assertEq(_arbClaimable(judges[0]), 0.02 ether);
        assertEq(_arbStake(judges[1]), 0.09 ether);
        _checkAll();
    }

    function test_dispute_noQuorum_longStop_ethAndBondBackToSeller_noFlag() public {
        (uint256 oid, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 bond = _disputed(tid);
        (,,, uint64 openedAt,,,,,,,,) = arb.disputeOf(tid);
        _commit(tid, judges[0], 1); // never reveals
        uint256 s0 = maker.balance;
        uint256 b0 = taker.balance;
        uint256 rem0 = esc.getOrder(oid).remainingEth;
        _resolveToEnd(tid);
        assertGe(block.timestamp, uint256(openedAt) + arb.LONG_STOP());
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(taker.balance, b0); // nothing split: the buyer gets no ETH
        assertEq(esc.getOrder(oid).remainingEth, rem0 + 1 ether); // ETH back onto the Sell order
        assertEq(maker.balance - s0, bond + 0.01 ether); // whole bond + the non-revealer's reserve
        assertFalse(esc.flagged(taker));
        assertEq(_arbStake(judges[0]), 0.09 ether);
        assertEq(_arbClaimable(judges[0]), 0);
        assertEq(weth.balanceOf(fanout), 0);
        _checkAll();
    }

    function test_dispute_longStop_cancelledOrder_paysSellerDirectly() public {
        (uint256 oid, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        uint256 bond = _disputed(tid);
        vm.prank(maker);
        esc.cancelOrder(oid);
        uint256 s0 = maker.balance;
        _resolveToEnd(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(maker.balance - s0, 1 ether + bond);
        _checkAll();
    }

    function test_dispute_freshStakeCannotVote_sybilsBarred() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        _disputed(tid);
        // the seller funds a fresh address after the dispute opened
        address sybil = makeAddr("sellerSybil");
        vm.prank(maker);
        payable(sybil).transfer(5 ether);
        vm.prank(sybil);
        arb.stake{value: 5 ether}();
        vm.prank(sybil);
        vm.expectRevert(bytes("stake too new"));
        arb.commitVote(tid, _commitment(tid, 2, _salt(tid, sybil), sybil));
        _checkAll();
    }

    function test_dispute_blocksReleaseAndClaim_untilResolved() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        _disputed(tid);
        vm.prank(maker);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.release(tid);
        vm.warp(block.timestamp + esc.RELEASE_WINDOW() + 1);
        vm.prank(taker);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.claim(tid);
        // only arbitration can resolve on the escrow
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.onDisputeResolved(tid, Outcome.BuyerPaid);
        // parties can not vote on their own dispute
        vm.prank(maker);
        arb.stake{value: 0.1 ether}();
        vm.prank(maker);
        vm.expectRevert(bytes("party"));
        arb.commitVote(tid, bytes32(uint256(1)));
        _checkAll();
    }

    function test_arbiter_unstakeLockedByOpenVote_thenWithdraws() public {
        (, uint256 tid) = _sellTrade(1 ether);
        _paid(tid);
        _disputed(tid);
        _commit(tid, judges[0], 1);
        _commit(tid, judges[1], 1);
        _commit(tid, judges[2], 1);
        uint256 t0 = block.timestamp;
        vm.prank(judges[0]);
        arb.requestUnstake();
        // an unstake request stops new commits, not the reveal of an existing one
        _toReveal(tid);
        _reveal(tid, judges[0], 1);
        _reveal(tid, judges[1], 1);
        _reveal(tid, judges[2], 1);
        vm.warp(t0 + arb.UNSTAKE_DELAY()); // delay over, but the dispute is not resolved yet
        vm.prank(judges[0]);
        vm.expectRevert(bytes("votes locked"));
        arb.withdrawStake();
        arb.resolve(tid);
        uint256 j0 = judges[0].balance;
        vm.prank(judges[0]);
        arb.withdrawStake(); // settles the win first; the reward stays claimable
        assertEq(judges[0].balance - j0, 0.1 ether);
        uint256 c = _arbClaimable(judges[0]);
        assertGt(c, 0);
        vm.prank(judges[0]);
        arb.claimArbiterReward();
        assertEq(judges[0].balance - j0, 0.1 ether + c);
        _checkAll();
    }

    function test_manyTrades_mixedOutcomes_conserveEverything() public {
        (, uint256 seed) = _sellTrade(5 ether);
        vm.prank(maker);
        esc.release(seed);
        uint256[] memory tids = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            if (i % 2 == 0) (, tids[i]) = _sellTrade(0.4 ether);
            else (, tids[i]) = _buyTrade(0.4 ether);
            _paid(tids[i]);
            _disputed(tids[i]);
        }
        uint8[4] memory want = [1, 2, 1, 2];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 3; ++j) {
                _commit(tids[i], judges[j], want[i]);
            }
        }
        _toReveal(tids[0]);
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 3; ++j) {
                _reveal(tids[i], judges[j], want[i]);
            }
        }
        _toResolve(tids[0]);
        for (uint256 i; i < 4; ++i) {
            arb.resolve(tids[i]);
            assertEq(uint8(esc.tradeOutcome(tids[i])), want[i]);
            _checkAll();
        }
        for (uint256 j; j < 3; ++j) {
            vm.prank(judges[j]);
            arb.claimArbiterReward();
        }
        _checkAll();
        assertEq(arb.rewardsUnsettled(), 0);
        assertEq(arb.slashesUnsettled(), 0);
    }
}

// ============================================================================ stateful invariant across both contracts

contract IntegHandler is Test {
    RobinhoodEthOtc esc;
    OtcArbitration arb;
    address[] public traders;
    address[] public judges;
    mapping(uint256 => mapping(address => uint8)) public committedVote;

    uint256 public resolvedCount;
    uint256 public disputedCount;
    uint256 public longStops;

    constructor(RobinhoodEthOtc esc_, OtcArbitration arb_, address[] memory traders_, address[] memory judges_) {
        esc = esc_;
        arb = arb_;
        traders = traders_;
        judges = judges_;
    }

    function _trader(uint256 s) internal view returns (address) {
        return traders[s % traders.length];
    }

    function _judge(uint256 s) internal view returns (address) {
        return judges[s % judges.length];
    }

    function _tid(uint256 s) internal view returns (bool ok, uint256 tid) {
        uint256 n = esc.tradesLength();
        if (n == 0) return (false, 0);
        return (true, s % n);
    }

    /// first trade at or after a random start whose status is `want` (scans at most 32)
    function _find(uint256 s, RobinhoodEthOtc.TradeStatus want) internal view returns (bool, uint256) {
        uint256 n = esc.tradesLength();
        if (n == 0) return (false, 0);
        uint256 lim = n < 32 ? n : 32;
        for (uint256 k; k < lim; ++k) {
            uint256 tid = (s % n + k) % n;
            if (esc.getTrade(tid).status == want) return (true, tid);
        }
        return (false, 0);
    }

    function _openDispute(uint256 s) internal view returns (bool, uint256) {
        uint256[] memory ids = arb.openDisputeIds();
        if (ids.length == 0) return (false, 0);
        return (true, ids[s % ids.length]);
    }

    function postSell(uint256 who, uint256 amt, uint256 price) external {
        address m = _trader(who);
        amt = bound(amt, 0.01 ether, 3 ether);
        price = bound(price, 1_000, 1_000_000);
        vm.prank(m);
        try esc.postSell{value: amt}("seller_x", price, amt / 4, amt) {} catch {}
    }

    function postBuy(uint256 who, uint256 amt, uint256 price) external {
        address m = _trader(who);
        amt = bound(amt, 0.01 ether, 3 ether);
        price = bound(price, 1_000, 1_000_000);
        vm.prank(m);
        try esc.postBuy("buyer_x", amt, price, amt / 4, amt) {} catch {}
    }

    function take(uint256 orderSeed, uint256 who, uint256 amt) external {
        uint256 n = esc.ordersLength();
        if (n == 0) return;
        uint256 oid = orderSeed % n;
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        if (!o.active) return;
        uint256 hi = o.maxEth < o.remainingEth ? o.maxEth : o.remainingEth;
        if (hi < o.minEth) return;
        amt = bound(amt, o.minEth, hi);
        address t = _trader(who);
        if (t == o.maker) t = traders[(who % traders.length + 1) % traders.length];
        vm.prank(t);
        if (o.side == RobinhoodEthOtc.Side.Sell) {
            try esc.takeSell(oid, amt, "taker_x") {} catch {}
        } else {
            try esc.takeBuy{value: amt}(oid, "taker_x") {} catch {}
        }
    }

    function markPaid(uint256 s) external {
        (bool ok, uint256 tid) = _find(s, RobinhoodEthOtc.TradeStatus.Open);
        if (!ok) return;
        vm.prank(esc.getTrade(tid).buyer);
        try esc.markPaid(tid, "ref") {} catch {}
    }

    function release(uint256 s) external {
        (bool ok, uint256 tid) = _tid(s);
        if (!ok) return;
        vm.prank(esc.getTrade(tid).seller);
        try esc.release(tid) {} catch {}
    }

    function claim(uint256 s) external {
        (bool ok, uint256 tid) = _tid(s);
        if (!ok) return;
        vm.prank(esc.getTrade(tid).buyer);
        try esc.claim(tid) {} catch {}
    }

    function cancelUnpaid(uint256 s) external {
        (bool ok, uint256 tid) = _tid(s);
        if (!ok) return;
        try esc.cancelUnpaid(tid) {} catch {}
    }

    function cancelOrder(uint256 s) external {
        uint256 n = esc.ordersLength();
        if (n == 0) return;
        uint256 oid = s % n;
        vm.prank(esc.getOrder(oid).maker);
        try esc.cancelOrder(oid) {} catch {}
    }

    function dispute(uint256 s) external {
        (bool ok, uint256 tid) = _find(s, RobinhoodEthOtc.TradeStatus.Paid);
        if (!ok) return;
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        uint256 bond = esc.bondFor(t.ethAmount);
        vm.prank(t.seller);
        try esc.dispute{value: bond}(tid, "unpaid") {
            disputedCount++;
        } catch {}
    }

    function commit(uint256 s, uint256 j, uint256 voteSeed) external {
        (bool ok, uint256 tid) = _openDispute(s);
        if (!ok) return;
        address a = _judge(j);
        uint8 v = uint8(1 + (voteSeed % 2));
        vm.prank(a);
        try arb.commitVote(tid, keccak256(abi.encode(tid, v, keccak256(abi.encode(tid, a)), a))) {
            committedVote[tid][a] = v;
        } catch {}
    }

    function reveal(uint256 s, uint256 j) external {
        (bool ok, uint256 tid) = _openDispute(s);
        if (!ok) return;
        address a = _judge(j);
        uint8 v = committedVote[tid][a];
        if (v == 0) return;
        vm.prank(a);
        try arb.revealVote(tid, v, keccak256(abi.encode(tid, a))) {} catch {}
    }

    function resolve(uint256 s) external {
        (bool ok, uint256 tid) = _openDispute(s);
        if (!ok) return;
        _tryResolve(tid);
    }

    function _tryResolve(uint256 tid) internal {
        try arb.resolve(tid) {
            (,,,,,,, bool r, uint8 o,,,) = arb.disputeOf(tid);
            if (r) {
                resolvedCount++;
                if (o == uint8(Outcome.LongStop)) longStops++;
            }
        } catch {}
    }

    /// A whole dispute in one step: open a Sell or Buy trade, mark paid, dispute, then random commits and
    /// reveals round after round until it resolves (quorum or the long-stop). Reaches every outcome.
    function disputeFlow(uint256 seed, uint256 amt) external {
        address seller = _trader(seed);
        address buyer = traders[(seed % traders.length + 1) % traders.length];
        amt = bound(amt, 0.01 ether, 2 ether);
        uint256 tid;
        if ((seed >> 8) % 2 == 0) {
            vm.prank(seller);
            uint256 oid = esc.postSell{value: amt}("seller_x", 300_000, amt, amt);
            vm.prank(buyer);
            try esc.takeSell(oid, amt, "buyer_x") returns (uint256 t) {
                tid = t;
            } catch {
                return; // flagged or busy buyer
            }
        } else {
            vm.prank(buyer);
            try esc.postBuy("buyer_x", amt, 300_000, amt, amt) returns (uint256 oid) {
                vm.prank(seller);
                try esc.takeBuy{value: amt}(oid, "seller_x") returns (uint256 t) {
                    tid = t;
                } catch {
                    return; // busy buyer
                }
            } catch {
                return; // flagged buyer
            }
        }
        vm.prank(buyer);
        esc.markPaid(tid, "ref");
        uint256 bond = esc.bondFor(amt);
        vm.prank(seller);
        esc.dispute{value: bond}(tid, "unpaid");
        disputedCount++;

        // a quarter of the flows have a thin arbiter set (at most two judges ever vote): no quorum, long-stop
        uint256 active = (seed >> 16) % 4 == 0 ? 2 : judges.length;
        for (uint256 round; round < 10; ++round) {
            uint256 bits = uint256(keccak256(abi.encode(seed, round)));
            bool quiet = round > 0 && (bits >> 250) & 1 == 1; // some rounds nobody new shows up
            for (uint256 j; j < active && !quiet; ++j) {
                if ((bits >> (j * 3)) & 3 == 0) continue; // 1 in 4 judges sit out
                uint8 v = uint8(1 + ((bits >> (j * 3 + 2)) & 1));
                address a = judges[j];
                if (committedVote[tid][a] != 0) continue;
                vm.prank(a);
                try arb.commitVote(tid, keccak256(abi.encode(tid, v, keccak256(abi.encode(tid, a)), a))) {
                    committedVote[tid][a] = v;
                } catch {}
            }
            (,,,, uint64 commitEnd, uint64 revealEnd,,,,,,) = arb.disputeOf(tid);
            vm.warp(uint256(commitEnd) + 1);
            for (uint256 j; j < judges.length; ++j) {
                address a = judges[j];
                uint8 v = committedVote[tid][a];
                if (v == 0 || (bits >> (100 + j)) & 7 == 0) continue; // 1 in 8 never reveal (this round)
                vm.prank(a);
                try arb.revealVote(tid, v, keccak256(abi.encode(tid, a))) {} catch {}
            }
            vm.warp(uint256(revealEnd) + 1);
            _tryResolve(tid);
            (,,,,,,, bool r,,,,) = arb.disputeOf(tid);
            if (r) break;
        }
    }

    function claimReward(uint256 j) external {
        vm.prank(_judge(j));
        try arb.claimArbiterReward() {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 30 hours));
    }
}

contract RobinhoodOtcIntegrationInvariantTest is IntegBase {
    IntegHandler handler;
    address[] traders;
    address[] judges;
    uint256 TOTAL;

    function setUp() public {
        _deploy();
        for (uint256 i; i < 4; ++i) {
            traders.push(makeAddr(string.concat("trader", vm.toString(i))));
            vm.deal(traders[i], 1_000 ether);
        }
        for (uint256 i; i < 5; ++i) {
            judges.push(makeAddr(string.concat("arbiter", vm.toString(i))));
            vm.deal(judges[i], 10 ether);
            vm.prank(judges[i]);
            arb.stake{value: 0.1 ether + i * 0.3 ether}(); // 0.1 .. 1.3 ETH, all of it counts as weight
        }
        vm.warp(block.timestamp + arb.STAKE_AGE());
        handler = new IntegHandler(esc, arb, traders, judges);
        TOTAL = _systemEth();

        bytes4[] memory sels = new bytes4[](15);
        sels[0] = IntegHandler.postSell.selector;
        sels[1] = IntegHandler.postBuy.selector;
        sels[2] = IntegHandler.take.selector;
        sels[3] = IntegHandler.markPaid.selector;
        sels[4] = IntegHandler.release.selector;
        sels[5] = IntegHandler.claim.selector;
        sels[6] = IntegHandler.cancelUnpaid.selector;
        sels[7] = IntegHandler.cancelOrder.selector;
        sels[8] = IntegHandler.dispute.selector;
        sels[9] = IntegHandler.commit.selector;
        sels[10] = IntegHandler.reveal.selector;
        sels[11] = IntegHandler.resolve.selector;
        sels[12] = IntegHandler.claimReward.selector;
        sels[13] = IntegHandler.warp.selector;
        sels[14] = IntegHandler.disputeFlow.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    function _systemEth() internal view returns (uint256 t) {
        t = address(esc).balance + address(arb).balance + address(weth).balance;
        for (uint256 i; i < traders.length; ++i) {
            t += traders[i].balance;
        }
        for (uint256 i; i < judges.length; ++i) {
            t += judges[i].balance;
        }
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_escrowSolvent() public view {
        _assertEscrowSolvent();
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_arbitrationSolvent() public view {
        _assertArbSolvent();
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noEthCreatedOrDestroyed() public view {
        assertEq(_systemEth(), TOTAL);
        assertEq(esc.pendingFanout(), 0); // the fee leg never fails with these receivers
        assertEq(weth.balanceOf(address(esc)), 0); // wrapped fees always leave the escrow
        assertEq(address(weth).balance, weth.balanceOf(fanout)); // every fee wei reached the Fee Fanout
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_disputeStateAgrees() public view {
        uint256 n = esc.tradesLength();
        uint256 held;
        for (uint256 tid; tid < n; ++tid) {
            RobinhoodEthOtc.TradeStatus s = _status(tid);
            (,, uint256 bond, uint64 openedAt,,,, bool resolved, uint8 outcome,,,) = arb.disputeOf(tid);
            if (s == RobinhoodEthOtc.TradeStatus.Disputed) {
                assertTrue(openedAt != 0 && !resolved, "disputed trade without an open dispute");
                held += bond;
            } else if (s == RobinhoodEthOtc.TradeStatus.Resolved) {
                assertTrue(resolved, "resolved trade, unresolved dispute");
                assertEq(uint8(esc.tradeOutcome(tid)), outcome, "outcome mismatch");
                RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
                if (outcome == uint8(Outcome.BuyerDidNotPay)) assertTrue(esc.flagged(t.buyer), "loser not flagged");
            } else {
                assertEq(openedAt, 0, "dispute for an undisputed trade");
            }
        }
        assertEq(arb.bondsHeld(), held, "bonds held != open disputes");
        assertEq(arb.openDisputeIds().length, handler.disputedCount() - handler.resolvedCount());
    }

    /// The randomized handler is not vacuous: 60 dispute flows reach all three outcomes, conserve ETH and keep
    /// both contracts solvent.
    function test_disputeFlow_reachesEveryOutcome() public {
        for (uint256 s; s < 60; ++s) {
            handler.disputeFlow(uint256(keccak256(abi.encode("flow", s))), 0.01 ether + s * 0.03 ether);
        }
        uint256[4] memory seen;
        uint256 n = esc.tradesLength();
        for (uint256 tid; tid < n; ++tid) {
            if (_status(tid) == RobinhoodEthOtc.TradeStatus.Resolved) seen[uint8(esc.tradeOutcome(tid))]++;
        }
        assertGt(seen[1], 0, "no BuyerPaid");
        assertGt(seen[2], 0, "no BuyerDidNotPay");
        assertGt(seen[3], 0, "no LongStop");
        assertEq(handler.longStops(), seen[3]);
        _assertEscrowSolvent();
        _assertArbSolvent();
        assertEq(_systemEth(), TOTAL);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_atMostOneOpenTradePerBuyer() public view {
        RobinhoodEthOtc.Trade[] memory ts = esc.getTrades(0, type(uint256).max);
        for (uint256 i; i < traders.length; ++i) {
            uint256 open;
            for (uint256 j; j < ts.length; ++j) {
                if (ts[j].buyer == traders[i] && ts[j].status == RobinhoodEthOtc.TradeStatus.Open) open++;
            }
            assertLe(open, 1);
        }
    }
}
