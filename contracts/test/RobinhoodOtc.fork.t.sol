// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RobinhoodEthOtc} from "../src/RobinhoodEthOtc.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {Outcome} from "../src/interfaces/IOtcArbitration.sol";
import {DeployRobinhoodOtc} from "../script/DeployRobinhoodOtc.s.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

/// Robinhood Chain (4663) fork: real WETH, real Fee Fanout, both real contracts deployed and bound in the same
/// order as script/DeployRobinhoodOtc.s.sol. FORK_URL defaults to the public RPC and FORK_BLOCK to the L2 head
/// minus 50. Set SKIP_FORK=true to skip offline.
contract RobinhoodOtcForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FEE_FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
    uint256 constant PRICE = 300_000; // $3,000.00 per ETH

    RobinhoodEthOtc esc;
    OtcArbitration arb;
    address maker = makeAddr("forkMaker");
    address taker = makeAddr("forkTaker");
    address[3] judges;
    bool offline;
    uint256 forkBlock;

    function setUp() public {
        offline = vm.envOr("SKIP_FORK", false);
        if (offline) return;
        string memory url = vm.envOr("FORK_URL", DEFAULT_RPC);
        forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            // block.number on an Orbit chain is the L1 number, so ask the RPC for the L2 head
            bytes memory head = vm.rpc(url, "eth_blockNumber", "[]");
            for (uint256 i; i < head.length; ++i) {
                forkBlock = (forkBlock << 8) | uint8(head[i]);
            }
            forkBlock -= 50;
        }
        vm.createSelectFork(url, forkBlock);
        assertEq(block.chainid, 4663);
        assertGt(WETH.code.length, 0, "WETH has no code");
        assertGt(FEE_FANOUT.code.length, 0, "Fee Fanout has no code");

        arb = new OtcArbitration();
        esc = new RobinhoodEthOtc(WETH, FEE_FANOUT, address(arb));
        arb.bind(address(esc));
        assertEq(arb.escrow(), address(esc));
        assertEq(esc.arbitration(), address(arb));

        vm.deal(maker, 50 ether);
        vm.deal(taker, 50 ether);
        for (uint256 i; i < 3; ++i) {
            judges[i] = makeAddr(string.concat("forkJudge", vm.toString(i)));
            vm.deal(judges[i], 1 ether);
            vm.prank(judges[i]);
            arb.stake{value: 0.1 ether}();
        }
        vm.warp(block.timestamp + arb.STAKE_AGE()); // the judges may vote on disputes opened from now on
    }

    function _fanoutWeth() internal view returns (uint256) {
        return IERC20Min(WETH).balanceOf(FEE_FANOUT);
    }

    function _vote(uint256 tid, uint8 vote) internal {
        for (uint256 i; i < 3; ++i) {
            vm.prank(judges[i]);
            arb.commitVote(tid, keccak256(abi.encode(tid, vote, bytes32(i + 1), judges[i])));
        }
        (,,,, uint64 commitEnd, uint64 revealEnd,,,,,,) = arb.disputeOf(tid);
        vm.warp(uint256(commitEnd) + 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(judges[i]);
            arb.revealVote(tid, vote, bytes32(i + 1));
        }
        vm.warp(uint256(revealEnd) + 1);
    }

    function test_fork_deployScript_wiresBothContracts() public {
        if (offline) return;
        uint256 pk = uint256(keccak256("robinhood otc fork deployer"));
        vm.deal(vm.addr(pk), 1 ether);
        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
        DeployRobinhoodOtc script = new DeployRobinhoodOtc();
        (address a, address e) = script.run();
        assertEq(OtcArbitration(a).escrow(), e);
        assertEq(OtcArbitration(a).deployer(), vm.addr(pk));
        assertEq(RobinhoodEthOtc(e).arbitration(), a);
        assertEq(RobinhoodEthOtc(e).weth(), WETH);
        assertEq(RobinhoodEthOtc(e).feeFanout(), FEE_FANOUT);
        vm.prank(vm.addr(pk));
        vm.expectRevert(bytes("bound"));
        OtcArbitration(a).bind(address(0xBEEF)); // nobody can rewire it afterwards
    }

    function test_fork_sellRelease_wholeFeeToRealFanout() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 2 ether}("maker_x", PRICE, 0.1 ether, 2 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 2 ether, "taker_x");
        assertEq(esc.getTrade(tid).expectedCents, 600_000);
        vm.prank(taker);
        esc.markPaid(tid, "X Money ref");

        uint256 w0 = _fanoutWeth();
        uint256 b0 = taker.balance;
        vm.prank(maker);
        esc.release(tid);
        assertEq(taker.balance - b0, 1.998 ether);
        assertEq(_fanoutWeth() - w0, 0.002 ether); // the whole 0.1% fee, as WETH
        assertEq(address(arb).balance, 0.3 ether); // only the judges' stakes
        assertEq(address(esc).balance, 0);
        assertEq(esc.pendingFanout(), 0);
    }

    function test_fork_buyClaim_afterReleaseWindow() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postBuy("maker_x", 1 ether, PRICE, 0.1 ether, 1 ether);
        vm.prank(taker);
        uint256 tid = esc.takeBuy{value: 1 ether}(oid, "taker_x");
        vm.prank(maker);
        esc.markPaid(tid, "sent");
        vm.warp(block.timestamp + esc.RELEASE_WINDOW() + 1);
        uint256 w0 = _fanoutWeth();
        uint256 b0 = maker.balance;
        vm.prank(maker);
        esc.claim(tid);
        assertEq(maker.balance - b0, 0.999 ether);
        assertEq(_fanoutWeth() - w0, 0.001 ether);
        assertEq(address(esc).balance, 0);
    }

    function test_fork_cancelUnpaid_orderSurvives() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 1 ether}("maker_x", PRICE, 0.5 ether, 1 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 1 ether, "taker_x");
        vm.warp(block.timestamp + esc.PAY_WINDOW() + 1);
        esc.cancelUnpaid(tid);
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 1 ether);
        assertEq(address(esc).balance, 1 ether);
    }

    function test_fork_disputeBuyerPaid_endToEnd() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 1 ether}("maker_x", PRICE, 0.1 ether, 1 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 1 ether, "taker_x");
        vm.prank(taker);
        esc.markPaid(tid, "ref");
        uint256 bond = esc.bondFor(1 ether);
        vm.prank(maker);
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: bond + 1}(tid, "not received");
        vm.prank(maker);
        esc.dispute{value: bond}(tid, "not received");
        vm.prank(taker);
        arb.submitEvidence(tid, "/api/robinhood/evidence/0123456789abcdef0123456789abcdef.png");

        _vote(tid, 1);
        uint256 w0 = _fanoutWeth();
        uint256 b0 = taker.balance;
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(taker.balance - b0, 0.999 ether);
        assertEq(_fanoutWeth() - w0, 0.001 ether);
        uint256 paid;
        for (uint256 i; i < 3; ++i) {
            uint256 j0 = judges[i].balance;
            vm.prank(judges[i]);
            arb.claimArbiterReward();
            paid += judges[i].balance - j0;
        }
        assertEq(paid, bond); // the whole bond, dust included
        assertEq(address(esc).balance, 0);
        // everything left in arbitration: the stakes
        assertEq(address(arb).balance, arb.totalStaked());
    }

    function test_fork_disputeBuyerDidNotPay_refillsAndFlags_halfBondBack() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 1 ether}("maker_x", PRICE, 0.1 ether, 0.5 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 0.5 ether, "taker_x");
        vm.prank(taker);
        esc.markPaid(tid, "ref");
        uint256 bond = esc.bondFor(0.5 ether);
        vm.prank(maker);
        esc.dispute{value: bond}(tid, "not received");
        _vote(tid, 2);
        uint256 m0 = maker.balance;
        uint256 w0 = _fanoutWeth();
        arb.resolve(tid);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));
        assertEq(maker.balance - m0, bond - bond / 2);
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        assertTrue(esc.flagged(taker));
        assertEq(_fanoutWeth(), w0); // no fee on ETH returned to a seller
        vm.prank(maker);
        esc.cancelOrder(oid);
        assertEq(address(esc).balance, 0);
    }

    function test_fork_disputeNoQuorum_longStop() public {
        if (offline) return;
        vm.prank(maker);
        uint256 oid = esc.postSell{value: 1 ether}("maker_x", PRICE, 0.1 ether, 1 ether);
        vm.prank(taker);
        uint256 tid = esc.takeSell(oid, 1 ether, "taker_x");
        vm.prank(taker);
        esc.markPaid(tid, "ref");
        uint256 bond = esc.bondFor(1 ether);
        vm.prank(maker);
        esc.dispute{value: bond}(tid, "not received");
        uint256 m0 = maker.balance;
        bool resolved;
        while (!resolved) {
            (,,,,, uint64 revealEnd,,,,,,) = arb.disputeOf(tid);
            vm.warp(uint256(revealEnd) + 1);
            arb.resolve(tid);
            (,,,,,,, resolved,,,,) = arb.disputeOf(tid);
        }
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(maker.balance - m0, bond);
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        assertFalse(esc.flagged(taker));
        assertEq(taker.balance, 50 ether);
    }
}
