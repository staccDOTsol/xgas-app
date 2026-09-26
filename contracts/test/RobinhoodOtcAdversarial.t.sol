// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RobinhoodEthOtc} from "../src/RobinhoodEthOtc.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {Outcome} from "../src/interfaces/IOtcArbitration.sol";

/// @dev Regression tests for the adversarial review of RobinhoodEthOtc + OtcArbitration (findings F1 to F6).
///      Each test replays the reviewer's exploit against the fixed contracts and asserts that it no longer
///      works. Tests named `residual_` document behaviour that the chosen design keeps on purpose; their
///      assertions describe what still happens so nobody mistakes it for a protection.

contract AdvWETH {
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

/// @dev A seller that is a contract with no receive/fallback (e.g. a minimal smart account or vault).
contract NoReceiveSeller {
    RobinhoodEthOtc internal esc;
    OtcArbitration internal arb;

    constructor(RobinhoodEthOtc e, OtcArbitration a) payable {
        esc = e;
        arb = a;
    }

    function post(uint256 amt, uint256 price, uint256 minE, uint256 maxE) external returns (uint256) {
        return esc.postSell{value: amt}("nr_seller", price, minE, maxE);
    }

    function cancel(uint256 oid) external {
        esc.cancelOrder(oid);
    }

    function doDispute(uint256 tid, uint256 bond) external {
        esc.dispute{value: bond}(tid, "no dollars arrived");
    }

    function withdrawEscrowTo(address payable to) external {
        esc.withdrawEthTo(to);
    }

    function claimArb() external {
        arb.claimArbiterReward();
    }

    function claimArbTo(address to) external {
        arb.claimArbiterRewardTo(to);
    }
}

contract RobinhoodOtcAdversarialTest is Test {
    RobinhoodEthOtc esc;
    OtcArbitration arb;
    AdvWETH weth;
    address fanout = makeAddr("feeFanout");

    uint256 constant PRICE = 300_000; // $3,000.00 per ETH in cents
    uint8 constant BP = 1; // BuyerPaid
    uint8 constant DNP = 2; // BuyerDidNotPay

    address maker = makeAddr("maker");
    address taker = makeAddr("taker");

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new AdvWETH();
        arb = new OtcArbitration();
        esc = new RobinhoodEthOtc(address(weth), fanout, address(arb));
        arb.bind(address(esc));
        vm.deal(maker, 1000 ether);
        vm.deal(taker, 1000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _judge(string memory name, uint256 amt) internal returns (address j) {
        j = makeAddr(name);
        vm.deal(j, amt);
        vm.prank(j);
        arb.stake{value: amt}();
    }

    function _age() internal {
        vm.warp(block.timestamp + arb.STAKE_AGE());
    }

    function _salt(uint256 tid, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", tid, who));
    }

    function _commitment(uint256 tid, address j, uint8 v) internal pure returns (bytes32) {
        return keccak256(abi.encode(tid, v, _salt(tid, j), j));
    }

    function _commit(uint256 tid, address j, uint8 v) internal {
        vm.prank(j);
        arb.commitVote(tid, _commitment(tid, j, v));
    }

    function _reveal(uint256 tid, address j, uint8 v) internal {
        vm.prank(j);
        arb.revealVote(tid, v, _salt(tid, j));
    }

    function _toReveal(uint256 tid) internal {
        (,,,, uint64 ce,,,,,,,) = arb.disputeOf(tid);
        vm.warp(uint256(ce) + 1);
    }

    function _toResolve(uint256 tid) internal {
        (,,,,, uint64 re,,,,,,) = arb.disputeOf(tid);
        vm.warp(uint256(re) + 1);
    }

    function _resolved(uint256 tid) internal view returns (bool r) {
        (,,,,,,, r,,,,) = arb.disputeOf(tid);
    }

    function _resolveToEnd(uint256 tid) internal {
        while (!_resolved(tid)) {
            _toResolve(tid);
            arb.resolve(tid);
        }
    }

    function _claimable(address a) internal view returns (uint256 c) {
        (,, c,) = arb.arbiterOf(a);
    }

    function _stakeOf(address a) internal view returns (uint256 s) {
        (s,,,) = arb.arbiterOf(a);
    }

    /// honest 100 ETH trade, released: 0.1 ETH fee, all of it WETH to the Fee Fanout
    function _honestVolume() internal {
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 100 ether}("maker_x", PRICE, 1 ether, 100 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 100 ether, "taker_x");
        vm.prank(maker);
        esc.release(tid);
    }

    function _sell10(address buyer) internal returns (uint256 oid, uint256 tid) {
        vm.prank(maker);
        oid = esc.postSell{value: 10 ether}("maker_x", PRICE, 1 ether, 10 ether);
        vm.prank(buyer);
        tid = esc.takeSell(oid, 10 ether, "buyer_x");
    }

    function _dispute10(uint256 tid) internal {
        vm.prank(maker);
        esc.dispute{value: 0.5 ether}(tid, "never arrived"); // bondFor(10 ETH) = 0.5 ETH exactly
    }

    // ================================================================== F1
    /// Was: overpay the bond to the pool size, self-trade, vote BuyerDidNotPay with 3 dust arbiters, drain the
    /// arbiter reward pool. Now: the bond must be exact, there is no pool (fees go 100% to the Fee Fanout),
    /// and a BuyerDidNotPay reward is half of the attacker's own bond. The attacker ends with what it started.
    function test_F1_rewardPoolDrain_isGone() public {
        _honestVolume();
        assertEq(weth.balanceOf(fanout), 0.1 ether); // the whole fee reached the Fee Fanout
        assertEq(address(arb).balance, 0); // nothing sits in arbitration to be drained

        address aS = makeAddr("attackerSeller");
        address aB = makeAddr("attackerBuyer");
        vm.deal(aS, 1 ether);
        address[3] memory sy;
        uint256 start = 1 ether;
        for (uint256 i; i < 3; ++i) {
            sy[i] = _judge(string.concat("drainSybil", vm.toString(i)), 0.01 ether);
            start += 0.01 ether;
        }
        _age(); // the strongest version: the sybil stakes are old enough to vote

        vm.prank(aS);
        uint256 oid = esc.postSell{value: 0.001 ether}("a_s", PRICE, 0.001 ether, 0.001 ether);
        vm.prank(aB);
        uint256 tid = esc.takeSell(oid, 0.001 ether, "a_b");
        vm.prank(aB);
        esc.markPaid(tid, "nothing sent");

        assertEq(esc.bondFor(0.001 ether), 0.002 ether);
        vm.prank(aS);
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: 0.05 ether}(tid, "buyer did not pay"); // overpaying is refused
        vm.prank(aS);
        esc.dispute{value: 0.002 ether}(tid, "buyer did not pay");

        for (uint256 i; i < 3; ++i) {
            _commit(tid, sy[i], DNP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, sy[i], DNP);
        }
        _toResolve(tid);
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));

        vm.prank(aS);
        esc.cancelOrder(oid); // the 0.001 ETH went back onto the order
        for (uint256 i; i < 3; ++i) {
            vm.prank(sy[i]);
            arb.requestUnstake();
        }
        vm.warp(block.timestamp + 7 days);
        uint256 end = aS.balance + aB.balance;
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(sy[i]);
            arb.claimArbiterReward();
            arb.withdrawStake();
            vm.stopPrank();
            end += sy[i].balance;
        }
        assertEq(end, start, "the attacker only moved its own bond around");
        assertEq(weth.balanceOf(fanout), 0.1 ether); // honest fees untouched
        assertEq(address(arb).balance, 0);
    }

    /// Was: honest arbiters could not stop the drain and the attacker took ~91% of the pool.
    /// Now: honest arbiters share the attacker's half bond, so the attacker loses money.
    function test_F1b_withHonestArbiters_attackerLoses() public {
        _honestVolume();
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honest", vm.toString(i)), 0.1 ether);
        }
        address[3] memory sy;
        for (uint256 i; i < 3; ++i) {
            sy[i] = _judge(string.concat("drainWhale", vm.toString(i)), 1 ether);
        }
        _age();

        address aS = makeAddr("attackerSeller");
        address aB = makeAddr("attackerBuyer");
        vm.deal(aS, 1 ether);
        vm.prank(aS);
        uint256 oid = esc.postSell{value: 0.001 ether}("a_s", PRICE, 0.001 ether, 0.001 ether);
        vm.prank(aB);
        uint256 tid = esc.takeSell(oid, 0.001 ether, "a_b");
        vm.prank(aB);
        esc.markPaid(tid, "nothing sent");
        vm.prank(aS);
        esc.dispute{value: 0.002 ether}(tid, "buyer did not pay");

        for (uint256 i; i < 3; ++i) {
            _commit(tid, honest[i], DNP);
            _commit(tid, sy[i], DNP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, honest[i], DNP);
            _reveal(tid, sy[i], DNP);
        }
        _toResolve(tid);
        uint256 s0 = aS.balance;
        arb.resolve(tid);
        assertEq(aS.balance - s0, 0.001 ether); // half the bond back

        uint256 attackerReward;
        for (uint256 i; i < 3; ++i) {
            attackerReward += _claimable(sy[i]);
        }
        uint256 honestReward;
        for (uint256 i; i < 3; ++i) {
            honestReward += _claimable(honest[i]);
        }
        assertGt(honestReward, 0);
        assertLt(attackerReward, 0.001 ether, "the attacker can not recover the half bond it paid");
        assertEq(weth.balanceOf(fanout), 0.1 ether);
    }

    // ================================================================== F2
    /// Was: a seller outvotes honest arbiters with fresh addresses staked in the last second of the commit
    /// window, keeps the ETH and the dollars, and the honest arbiters are slashed. Now: stake that became
    /// eligible after the dispute opened can not vote at all, so the honest majority decides.
    function test_F2_lastSecondSybils_cannotVote() public {
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honestJ", vm.toString(i)), 1 ether);
        }
        _age();

        (, uint256 tid) = _sell10(taker);
        vm.prank(taker);
        esc.markPaid(tid, "sent $30,000.00, X Money ref 42"); // the buyer really paid
        _dispute10(tid);
        for (uint256 i; i < 3; ++i) {
            _commit(tid, honest[i], BP);
        }

        (,,,, uint64 ce,,,,,,,) = arb.disputeOf(tid);
        vm.warp(ce); // last second of the commit window
        for (uint256 i; i < 4; ++i) {
            address s = makeAddr(string.concat("sellerSybil", vm.toString(i)));
            vm.prank(maker);
            payable(s).transfer(1 ether);
            vm.prank(s);
            arb.stake{value: 1 ether}();
            vm.prank(s);
            vm.expectRevert(bytes("stake too new"));
            arb.commitVote(tid, _commitment(tid, s, DNP));
        }

        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, honest[i], BP);
        }
        _toResolve(tid);
        uint256 b0 = taker.balance;
        arb.resolve(tid);

        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(taker.balance - b0, 9.99 ether); // the honest buyer gets the ETH
        assertFalse(esc.flagged(taker));
        for (uint256 i; i < 3; ++i) {
            assertEq(_stakeOf(honest[i]), 1 ether); // honest arbiters are not slashed
            assertApproxEqAbs(_claimable(honest[i]), uint256(0.5 ether) / 3, 1); // they split the lying seller's bond
        }
    }

    /// Stake that ages during an extension still can not vote on that dispute: eligibility is measured
    /// against the dispute's openedAt, not the round.
    function test_F2b_sybilsStakedAfterOpening_barredInEveryExtension() public {
        address[2] memory honest;
        for (uint256 i; i < 2; ++i) {
            honest[i] = _judge(string.concat("honestE", vm.toString(i)), 1 ether);
        }
        _age();
        (, uint256 tid) = _sell10(taker);
        vm.prank(taker);
        esc.markPaid(tid, "ref");
        _dispute10(tid);
        address s = makeAddr("patientSybil");
        vm.prank(maker);
        payable(s).transfer(5 ether);
        vm.prank(s);
        arb.stake{value: 5 ether}();
        for (uint256 round; round < 3; ++round) {
            _toResolve(tid);
            arb.resolve(tid); // only 0 revealers: another round
            vm.prank(s);
            vm.expectRevert(bytes("stake too new"));
            arb.commitVote(tid, _commitment(tid, s, DNP));
        }
    }

    // ================================================================== F3
    /// Was: no quorum ended in Split: the lying seller kept the dollars plus half the ETH at zero cost.
    /// Now: there is no Split. A dispute without quorum keeps extending (up to 14 days), and any arbiter
    /// whose stake predates the dispute can still decide it. Here three arbiters arrive in round 3.
    function test_F3a_noQuorum_noSplit_laterRoundDecides() public {
        address[3] memory late;
        for (uint256 i; i < 3; ++i) {
            late[i] = _judge(string.concat("lateJ", vm.toString(i)), 0.1 ether);
        }
        _age();
        (uint256 oid, uint256 tid) = _sell10(taker);
        vm.prank(taker);
        esc.markPaid(tid, "sent $30,000.00");
        _dispute10(tid);
        vm.prank(maker);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.release(tid); // unchanged: a disputed trade waits for arbitration

        _toResolve(tid);
        arb.resolve(tid); // round 1: nobody voted, extension instead of Split
        _toResolve(tid);
        arb.resolve(tid); // round 2: same
        (,,,,,, uint16 ext, bool res,,,,) = arb.disputeOf(tid);
        assertEq(ext, 2);
        assertFalse(res);
        assertEq(uint8(esc.getTrade(tid).status), uint8(RobinhoodEthOtc.TradeStatus.Disputed));

        for (uint256 i; i < 3; ++i) {
            _commit(tid, late[i], BP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, late[i], BP);
        }
        _toResolve(tid);
        uint256 b0 = taker.balance;
        uint256 m0 = maker.balance;
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(taker.balance - b0, 9.99 ether); // all of it, not half
        assertEq(maker.balance, m0); // the lying seller loses the whole bond
        assertEq(esc.getOrder(oid).remainingEth, 0);
    }

    /// Residual by design: if no 3 revealers ever show up within 14 days, the long-stop returns the ETH to
    /// the seller and the bond with it. Nothing is split, but a lying seller facing an empty arbiter set keeps
    /// the dollars and the ETH. Honest buyers depend on arbiters being active within those 14 days.
    function test_F3a_residual_emptyArbiterSet_longStopDefaultsToSeller() public {
        (uint256 oid, uint256 tid) = _sell10(taker);
        vm.prank(taker);
        esc.markPaid(tid, "sent $30,000.00");
        _dispute10(tid);
        uint256 m0 = maker.balance;
        uint256 t0 = taker.balance;
        _resolveToEnd(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(taker.balance, t0);
        assertEq(esc.getOrder(oid).remainingEth, 10 ether);
        assertEq(maker.balance - m0, 0.5 ether);
        assertFalse(esc.flagged(taker));
    }

    /// Was: a buyer who never paid forced an exact tie with sybils (tie -> extension -> tie -> Split) and got
    /// half the ETH for $0 while its sybils lost nothing. Now: a tie only extends; a tie held until the
    /// long-stop sends the ETH back to the seller, so the fake buyer gets nothing, even with sybil stake
    /// that was aged before the dispute (the strongest version of the attack).
    function test_F3b_fakeBuyerForcedTie_getsNothing() public {
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honestT", vm.toString(i)), 0.1 ether);
        }
        address[3] memory sy;
        for (uint256 i; i < 3; ++i) {
            sy[i] = _judge(string.concat("buyerSybil", vm.toString(i)), 0.1 ether);
        }
        _age();
        address fake = makeAddr("fakeBuyer");
        (uint256 oid, uint256 tid) = _sell10(fake);
        vm.prank(fake);
        esc.markPaid(tid, "fake ref"); // nothing was sent
        _dispute10(tid);

        for (uint256 i; i < 3; ++i) {
            _commit(tid, honest[i], DNP);
            _commit(tid, sy[i], BP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, honest[i], DNP);
            _reveal(tid, sy[i], BP);
        }
        uint256 m0 = maker.balance;
        _resolveToEnd(tid); // 0.3 vs 0.3 every round until the long-stop

        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(fake.balance, 0); // no ETH for the fake buyer
        assertEq(esc.getOrder(oid).remainingEth, 10 ether); // the seller's ETH is back on its order
        assertEq(maker.balance - m0, 0.5 ether); // and the bond back
        for (uint256 i; i < 3; ++i) {
            assertEq(_claimable(sy[i]), 0); // the sybils earn nothing
        }
    }

    /// With sybils staked after the dispute opened, the tie can not even be forced: the honest arbiters
    /// decide in round 1 and the fake buyer is flagged.
    function test_F3b_freshSybilsCannotForceTie() public {
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honestF", vm.toString(i)), 0.1 ether);
        }
        _age();
        address fake = makeAddr("fakeBuyer");
        (uint256 oid, uint256 tid) = _sell10(fake);
        vm.prank(fake);
        esc.markPaid(tid, "fake ref");
        _dispute10(tid);
        for (uint256 i; i < 3; ++i) {
            address s = _judge(string.concat("freshSybil", vm.toString(i)), 0.1 ether);
            vm.prank(s);
            vm.expectRevert(bytes("stake too new"));
            arb.commitVote(tid, _commitment(tid, s, BP));
            _commit(tid, honest[i], DNP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, honest[i], DNP);
        }
        _toResolve(tid);
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));
        assertTrue(esc.flagged(fake));
        assertEq(fake.balance, 0);
        assertEq(esc.getOrder(oid).remainingEth, 10 ether);
    }

    // ================================================================== F4
    /// Was: one unpaid full take deactivated a Sell order for good; cancelUnpaid pushed the ETH to the maker.
    /// Now: cancelUnpaid puts the ETH back onto the order and reactivates it.
    function test_F4a_unpaidFullTake_orderSurvives() public {
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 5 ether}("maker_x", PRICE, 0.5 ether, 5 ether);
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        uint256 tid = esc.takeSell(oid, 5 ether, "g");
        vm.warp(block.timestamp + 31 minutes);
        esc.cancelUnpaid(tid);

        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 5 ether);
        vm.prank(taker);
        esc.takeSell(oid, 1 ether, "real_buyer"); // the next real buyer can take it
    }

    /// Was: take 4.6 of 5 (minEth 0.5), never pay: 4.6 pushed to the maker, order dead with 0.4 stranded.
    /// Now: all 5 ETH are back on the active order and nothing was pushed.
    function test_F4b_unpaidPartialTakeBelowMin_orderSurvives() public {
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 5 ether}("maker_x", PRICE, 0.5 ether, 5 ether);
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        uint256 tid = esc.takeSell(oid, 4.6 ether, "g");
        vm.warp(block.timestamp + 31 minutes);
        uint256 m0 = maker.balance;
        esc.cancelUnpaid(tid);
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 5 ether);
        assertEq(maker.balance, m0);
    }

    /// Was: Buy-order capacity used by a trade was never restored on cancelUnpaid.
    /// Now: the capacity comes back and the order is active again.
    function test_F4c_buyOrderCapacityRestoredAfterCancelUnpaid() public {
        vm.prank(maker);
        uint256 oid = esc.postBuy("maker_x", 5 ether, PRICE, 0.5 ether, 5 ether);
        vm.prank(taker);
        uint256 tid = esc.takeBuy{value: 5 ether}(oid, "seller_x");
        vm.warp(block.timestamp + 31 minutes);
        uint256 t0 = taker.balance;
        esc.cancelUnpaid(tid);
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 5 ether);
        assertEq(taker.balance - t0, 5 ether);
    }

    /// Griefing the whole book from one address no longer works: a buyer address can hold one Open trade.
    function test_F4d_oneGrieferLocksAtMostOneOrder() public {
        address griefer = makeAddr("griefer");
        vm.startPrank(maker);
        uint256 o1 = esc.postSell{value: 5 ether}("maker_x", PRICE, 0.5 ether, 5 ether);
        uint256 o2 = esc.postSell{value: 5 ether}("maker_x", PRICE, 0.5 ether, 5 ether);
        vm.stopPrank();
        vm.prank(griefer);
        esc.takeSell(o1, 5 ether, "g");
        vm.prank(griefer);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeSell(o2, 5 ether, "g");
    }

    // ================================================================== F5
    /// Changed: a fake buyer can hold only one Open trade at a time, and once it loses a dispute it is flagged
    /// and can not take again.
    function test_F5_oneOpenTrade_andFlaggedBuyerCannotTake() public {
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honestF5", vm.toString(i)), 0.1 ether);
        }
        _age();
        address fake = makeAddr("fake2");
        (uint256 oid, uint256 t2) = _sell10(fake);
        vm.prank(maker);
        uint256 other = esc.postSell{value: 10 ether}("maker_x", PRICE, 1 ether, 10 ether);
        vm.prank(fake);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeSell(other, 1 ether, "fake2");

        vm.prank(fake);
        esc.markPaid(t2, "fake");
        _dispute10(t2);
        for (uint256 i; i < 3; ++i) {
            _commit(t2, honest[i], DNP);
        }
        _toReveal(t2);
        for (uint256 i; i < 3; ++i) {
            _reveal(t2, honest[i], DNP);
        }
        _toResolve(t2);
        arb.resolve(t2);
        assertTrue(esc.flagged(fake));
        assertEq(esc.getOrder(oid).remainingEth, 10 ether); // the order is intact and live again
        vm.prank(fake);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.takeSell(other, 1 ether, "fake2");
    }

    /// Residual by design (no buyer bond in this design): a seller who is offline for the whole 12 hour
    /// release window after a fake markPaid loses the ETH to an optimistic claim. Sellers must watch every
    /// Paid trade and dispute within RELEASE_WINDOW.
    function test_F5a_residual_offlineSellerLosesToFakeMarkPaid() public {
        address fake1 = makeAddr("fake1");
        (, uint256 t1) = _sell10(fake1);
        vm.prank(fake1);
        esc.markPaid(t1, "fake");
        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(fake1);
        esc.claim(t1);
        assertEq(fake1.balance, 10 ether - 0.01 ether);
    }

    /// Residual by design: flagging is per address and a take needs no deposit, so a flagged fake buyer can
    /// come back from a fresh address (one Open trade at a time).
    function test_F5b_residual_freshAddressCanTakeAgain() public {
        address fake3 = makeAddr("fake3");
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 10 ether}("maker_x", PRICE, 1 ether, 10 ether);
        vm.prank(fake3);
        esc.takeSell(oid, 10 ether, "fake3");
        assertEq(fake3.balance, 0);
    }

    // ================================================================== F6
    /// Was: a seller contract that can not receive ETH had its returned bond locked in arbitration forever.
    /// Now: claimArbiterRewardTo pays it to another address, like the escrow's withdrawEthTo.
    function test_F6_bondRecoverableForSellerThatCannotReceiveEth() public {
        address[3] memory honest;
        for (uint256 i; i < 3; ++i) {
            honest[i] = _judge(string.concat("honestN", vm.toString(i)), 0.1 ether);
        }
        _age();
        NoReceiveSeller s = new NoReceiveSeller{value: 20 ether}(esc, arb);
        uint256 oid = s.post(10 ether, PRICE, 10 ether, 10 ether);
        address fake = makeAddr("fakeN");
        vm.prank(fake);
        uint256 tid = esc.takeSell(oid, 10 ether, "fakeN");
        vm.prank(fake);
        esc.markPaid(tid, "fake");
        s.doDispute(tid, 0.5 ether);
        for (uint256 i; i < 3; ++i) {
            _commit(tid, honest[i], DNP);
        }
        _toReveal(tid);
        for (uint256 i; i < 3; ++i) {
            _reveal(tid, honest[i], DNP);
        }
        _toResolve(tid);
        arb.resolve(tid);

        // escrow side: the 10 ETH is back on the order; cancelling credits it and withdrawEthTo recovers it
        assertEq(esc.getOrder(oid).remainingEth, 10 ether);
        s.cancel(oid);
        assertEq(esc.ethOwed(address(s)), 10 ether);
        address payable sink = payable(makeAddr("sink"));
        s.withdrawEscrowTo(sink);
        assertEq(sink.balance, 10 ether);

        // arbitration side: half the bond was credited; claiming to itself fails, claiming to another works
        (,, uint256 c,) = arb.arbiterOf(address(s));
        assertEq(c, 0.25 ether);
        vm.expectRevert(bytes("send failed"));
        s.claimArb();
        s.claimArbTo(sink);
        assertEq(sink.balance, 10.25 ether);
        (,, c,) = arb.arbiterOf(address(s));
        assertEq(c, 0);
    }
}
