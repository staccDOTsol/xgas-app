// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {IRobinhoodEthOtc, Outcome} from "../src/interfaces/IRobinhoodEthOtc.sol";

// ============================================================================ mocks

/// Minimal stand-in for RobinhoodEthOtc: forwards bonds, records outcomes.
contract MockEscrow is IRobinhoodEthOtc {
    OtcArbitration public arb;
    mapping(uint256 => uint8) public outcomeOf;
    uint256 public resolvedCalls;
    bool public tryReenter;
    bool public reenterSucceeded;
    bool public revertOnResolve;

    constructor(OtcArbitration a) {
        arb = a;
    }

    receive() external payable {}

    function open(uint256 tradeId, address buyer, address seller) external payable {
        arb.openDispute{value: msg.value}(tradeId, buyer, seller);
    }

    function setReenter(bool b) external {
        tryReenter = b;
    }

    function setRevert(bool b) external {
        revertOnResolve = b;
    }

    function onDisputeResolved(uint256 tradeId, Outcome outcome) external {
        require(msg.sender == address(arb), "not arb");
        require(!revertOnResolve, "escrow revert");
        outcomeOf[tradeId] = uint8(outcome);
        resolvedCalls++;
        if (tryReenter) {
            try arb.resolve(tradeId) {
                reenterSucceeded = true;
            } catch {}
            try arb.claimArbiterReward() {
                reenterSucceeded = true;
            } catch {}
            try arb.settle(tradeId, address(this)) {
                reenterSucceeded = true;
            } catch {}
        }
    }
}

/// Seller with no receive / fallback: every ETH push to it fails.
contract RejectingSeller {
    function submit(OtcArbitration arb, uint256 id, string calldata uri) external {
        arb.submitEvidence(id, uri);
    }

    function claim(OtcArbitration arb) external {
        arb.claimArbiterReward();
    }

    function claimTo(OtcArbitration arb, address to) external {
        arb.claimArbiterRewardTo(to);
    }
}

/// Seller whose receive burns all gas.
contract GasBombSeller {
    receive() external payable {
        while (true) {}
    }
}

/// Seller whose receive tries to re-enter the arbitration.
contract ReentrantSeller {
    OtcArbitration public arb;
    uint256 public tradeId;
    bool public attempted;
    bool public reentered;

    constructor(OtcArbitration a, uint256 id) {
        arb = a;
        tradeId = id;
    }

    receive() external payable {
        attempted = true;
        try arb.resolve(tradeId) {
            reentered = true;
        } catch {}
        try arb.claimArbiterReward() {
            reentered = true;
        } catch {}
    }
}

/// Contract arbiter that can reject ETH or re-enter on receive.
contract ContractArbiter {
    OtcArbitration public arb;
    bool public reject;
    bool public reenter;
    uint256 public receivedCount;
    uint256 public received;

    constructor(OtcArbitration a) {
        arb = a;
    }

    function setReject(bool b) external {
        reject = b;
    }

    function setReenter(bool b) external {
        reenter = b;
    }

    function doStake() external payable {
        arb.stake{value: msg.value}();
    }

    function doCommit(uint256 id, bytes32 c) external {
        arb.commitVote(id, c);
    }

    function doReveal(uint256 id, uint8 v, bytes32 salt) external {
        arb.revealVote(id, v, salt);
    }

    function doClaim() external {
        arb.claimArbiterReward();
    }

    function doClaimTo(address to) external {
        arb.claimArbiterRewardTo(to);
    }

    function doRequestUnstake() external {
        arb.requestUnstake();
    }

    function doWithdraw() external {
        arb.withdrawStake();
    }

    function doWithdrawTo(address to) external {
        arb.withdrawStakeTo(to);
    }

    receive() external payable {
        require(!reject, "no eth");
        receivedCount++;
        received += msg.value;
        if (reenter) {
            try arb.claimArbiterReward() {} catch {}
            try arb.withdrawStake() {} catch {}
        }
    }
}

// ============================================================================ unit tests

contract OtcArbitrationTest is Test {
    OtcArbitration arb;
    MockEscrow esc;

    address buyer = makeAddr("buyer");
    address seller = makeAddr("seller");
    address a1 = makeAddr("a1");
    address a2 = makeAddr("a2");
    address a3 = makeAddr("a3");
    address a4 = makeAddr("a4");
    address a5 = makeAddr("a5");
    address a6 = makeAddr("a6");

    uint256 constant BOND = 0.05 ether;
    uint256 constant AGE = 3 days;

    address[] tracked;
    uint256[] trackedTrades;

    function setUp() public {
        vm.warp(1_800_000_000);
        arb = new OtcArbitration();
        esc = new MockEscrow(arb);
        arb.bind(address(esc));
        address[8] memory all = [buyer, seller, a1, a2, a3, a4, a5, a6];
        for (uint256 i = 0; i < all.length; i++) {
            vm.deal(all[i], 100 ether);
            tracked.push(all[i]);
        }
        vm.deal(address(this), 100 ether);
        vm.deal(address(esc), 10 ether);
    }

    // ------------------------------------------------------------------ helpers
    function _salt(address who, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who, id));
    }

    function _commitment(uint256 id, uint8 v, bytes32 salt, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, v, salt, who));
    }

    function _open(uint256 id, uint256 bond) internal {
        _openFor(id, bond, buyer, seller);
    }

    function _openFor(uint256 id, uint256 bond, address b, address s) internal {
        esc.open{value: bond}(id, b, s);
        trackedTrades.push(id);
    }

    function _stake(address who, uint256 amt) internal {
        vm.prank(who);
        arb.stake{value: amt}();
    }

    /// let every stake made so far become eligible for disputes opened from now on
    function _age() internal {
        vm.warp(block.timestamp + AGE);
    }

    function _commit(address who, uint256 id, uint8 v) internal {
        vm.prank(who);
        arb.commitVote(id, _commitment(id, v, _salt(who, id), who));
    }

    function _reveal(address who, uint256 id, uint8 v) internal {
        vm.prank(who);
        arb.revealVote(id, v, _salt(who, id));
    }

    function _ends(uint256 id) internal view returns (uint64 commitEnd, uint64 revealEnd) {
        (,,,, commitEnd, revealEnd,,,,,,) = arb.disputeOf(id);
    }

    function _toReveal(uint256 id) internal {
        (uint64 c,) = _ends(id);
        vm.warp(uint256(c) + 1);
    }

    function _toResolve(uint256 id) internal {
        (, uint64 r) = _ends(id);
        vm.warp(uint256(r) + 1);
    }

    function _outcome(uint256 id) internal view returns (uint8 o) {
        (,,,,,,,, o,,,) = arb.disputeOf(id);
    }

    function _resolved(uint256 id) internal view returns (bool r) {
        (,,,,,,, r,,,,) = arb.disputeOf(id);
    }

    function _extensions(uint256 id) internal view returns (uint16 e) {
        (,,,,,, e,,,,,) = arb.disputeOf(id);
    }

    /// resolve until the dispute is final (extensions, then the long-stop)
    function _resolveToEnd(uint256 id) internal returns (uint256 calls) {
        while (!_resolved(id)) {
            _toResolve(id);
            arb.resolve(id);
            calls++;
        }
    }

    function _eff(address who) internal view returns (uint256 stake_, uint256 claimable, uint256 locked) {
        (stake_,, claimable, locked) = arb.arbiterOf(who);
    }

    function _raw(address who) internal view returns (uint256 stake_, uint256 atRisk, uint256 claimable) {
        (stake_, atRisk, claimable,,,,) = arb.accountOf(who);
    }

    function _eligibleAt(address who) internal view returns (uint64 e) {
        (,,,,,, e) = arb.accountOf(who);
    }

    function _settleAllTracked() internal {
        for (uint256 t = 0; t < trackedTrades.length; t++) {
            uint256 id = trackedTrades[t];
            if (!_resolved(id)) continue;
            for (uint256 i = 0; i < tracked.length; i++) {
                (bytes32 c,,) = arb.commitOf(id, tracked[i]);
                (,, bool settled) = arb.voteOf(id, tracked[i]);
                if (c != bytes32(0) && !settled) arb.settle(id, tracked[i]);
            }
        }
    }

    /// Accounting invariant: contract balance == everything it owes.
    function _checkAccounting() internal view {
        uint256 bal = address(arb).balance;
        // 1. ledger identity (there is no reward pool)
        assertEq(
            bal + arb.slashesUnsettled(),
            arb.totalStaked() + arb.totalClaimable() + arb.bondsHeld() + arb.rewardsUnsettled(),
            "ledger != balance"
        );
        // 2. ledger totals == independent sums over every account and dispute
        uint256 sStake;
        uint256 sClaim;
        uint256 sEffStake;
        uint256 sEffClaim;
        for (uint256 i = 0; i < tracked.length; i++) {
            (uint256 st, uint256 risk, uint256 cl) = _raw(tracked[i]);
            assertLe(risk, st, "atRisk > stake");
            sStake += st;
            sClaim += cl;
            (uint256 es, uint256 ec,) = _eff(tracked[i]);
            sEffStake += es;
            sEffClaim += ec;
        }
        assertEq(sStake, arb.totalStaked(), "sum stake");
        assertEq(sClaim, arb.totalClaimable(), "sum claimable");
        uint256 sBond;
        uint256 sRewardLeft;
        uint256 sSlashLeft;
        for (uint256 t = 0; t < trackedTrades.length; t++) {
            uint256 id = trackedTrades[t];
            (,, uint256 bond,,,,, bool resolved,,,,) = arb.disputeOf(id);
            (, uint256 rl, uint256 sl,) = arb.settlementOf(id);
            if (!resolved) sBond += bond;
            sRewardLeft += rl;
            sSlashLeft += sl;
        }
        assertEq(sBond, arb.bondsHeld(), "sum bonds");
        assertEq(sRewardLeft, arb.rewardsUnsettled(), "sum rewardLeft");
        assertEq(sSlashLeft, arb.slashesUnsettled(), "sum slashLeft");
        // 3. the effective (post-settlement) views agree with the ledger; only rounding dust is unassigned
        assertEq(sEffStake, arb.totalStaked() - arb.slashesUnsettled(), "effective stake");
        uint256 pendingShares = sEffClaim - sClaim;
        assertLe(pendingShares, arb.rewardsUnsettled(), "shares > rewardLeft");
        assertLe(arb.rewardsUnsettled() - pendingShares, tracked.length * trackedTrades.length, "dust bound");
        assertGe(bal, arb.bondsHeld() + sEffStake + sEffClaim, "effective insolvency");
    }

    /// Standard 5-arbiter set, 1 ether each (weight 1 ether, reserve 0.1 ether), aged.
    function _stakeFive() internal {
        _stake(a1, 1 ether);
        _stake(a2, 1 ether);
        _stake(a3, 1 ether);
        _stake(a4, 1 ether);
        _stake(a5, 1 ether);
        _age();
    }

    // ------------------------------------------------------------------ bind
    function test_bind_onlyOnceByDeployer() public {
        OtcArbitration fresh = new OtcArbitration();
        assertEq(fresh.deployer(), address(this));
        vm.prank(a1);
        vm.expectRevert("not deployer");
        fresh.bind(address(esc));
        vm.expectRevert("zero escrow");
        fresh.bind(address(0));
        fresh.bind(address(esc));
        assertEq(fresh.escrow(), address(esc));
        vm.expectRevert("bound");
        fresh.bind(address(0xBEEF));
        assertEq(arb.escrow(), address(esc));
        vm.expectRevert("bound");
        arb.bind(address(0xBEEF));
    }

    function test_unbound_noOneIsEscrow() public {
        OtcArbitration fresh = new OtcArbitration();
        vm.deal(address(0), 1 ether);
        vm.prank(address(0));
        vm.expectRevert("only escrow");
        fresh.openDispute{value: 0.01 ether}(1, buyer, seller);
        // staking works before bind
        vm.prank(a1);
        fresh.stake{value: 0.01 ether}();
    }

    function test_escrowHook_onlyEscrow() public {
        vm.prank(a1);
        vm.expectRevert("only escrow");
        arb.openDispute{value: 0.01 ether}(1, buyer, seller);
    }

    function test_noRewardPoolEntryPoints() public {
        // the reward pool and fundRewards are gone: an unknown selector with value reverts
        (bool ok,) = address(arb).call{value: 1 ether}(abi.encodeWithSignature("fundRewards()"));
        assertFalse(ok);
        (ok,) = address(arb).call(abi.encodeWithSignature("rewardPool()"));
        assertFalse(ok);
    }

    function test_openDispute_validation() public {
        vm.expectRevert("no bond");
        esc.open{value: 0}(1, buyer, seller);
        vm.expectRevert("zero party");
        esc.open{value: BOND}(1, address(0), seller);
        vm.expectRevert("zero party");
        esc.open{value: BOND}(1, buyer, address(0));
        _open(1, BOND);
        vm.expectRevert("exists");
        esc.open{value: BOND}(1, buyer, seller);
        (address b, address s, uint256 bond, uint64 openedAt, uint64 ce, uint64 re, uint16 ext, bool res, uint8 o,,,) =
            arb.disputeOf(1);
        assertEq(b, buyer);
        assertEq(s, seller);
        assertEq(bond, BOND);
        assertEq(openedAt, block.timestamp);
        assertEq(ce, block.timestamp + 24 hours);
        assertEq(re, block.timestamp + 48 hours);
        assertEq(ext, 0);
        assertFalse(res);
        assertEq(o, 0);
        assertEq(arb.bondsHeld(), BOND);
        uint256[] memory ids = arb.openDisputeIds();
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
        _checkAccounting();
    }

    function test_constants() public view {
        assertEq(arb.MIN_STAKE(), 0.01 ether);
        assertEq(arb.STAKE_AGE(), 3 days);
        assertEq(arb.COMMIT(), 24 hours);
        assertEq(arb.REVEAL(), 24 hours);
        assertEq(arb.LONG_STOP(), 14 days);
        assertEq(arb.SLASH_BPS(), 1000);
        assertEq(arb.UNSTAKE_DELAY(), 7 days);
        assertEq(arb.MIN_REVEALERS(), 3);
    }

    // ------------------------------------------------------------------ staking
    function test_stake_minimumAccumulateAndEligibleAt() public {
        vm.prank(a1);
        vm.expectRevert(bytes("zero"));
        arb.stake{value: 0}();
        vm.prank(a1);
        vm.expectRevert("below min stake");
        arb.stake{value: 0.01 ether - 1}();
        _stake(a1, 0.01 ether);
        assertEq(_eligibleAt(a1), block.timestamp + AGE);
        vm.warp(block.timestamp + 1 days);
        _stake(a1, 1); // top-up of any size once the total is above the minimum
        assertEq(_eligibleAt(a1), block.timestamp + AGE, "every increase restarts the wait");
        (uint256 s,,,) = arb.arbiterOf(a1);
        assertEq(s, 0.01 ether + 1);
        assertEq(arb.totalStaked(), 0.01 ether + 1);
        _checkAccounting();
    }

    function test_unstake_delayBoundaryAndPayout() public {
        _stake(a1, 1 ether);
        vm.prank(a1);
        vm.expectRevert("not requested");
        arb.withdrawStake();
        vm.prank(a1);
        arb.requestUnstake();
        vm.prank(a1);
        vm.expectRevert("requested");
        arb.requestUnstake();
        (, uint64 at,,) = arb.arbiterOf(a1);
        assertEq(at, block.timestamp + 7 days);
        vm.warp(uint256(at) - 1);
        vm.prank(a1);
        vm.expectRevert("delay");
        arb.withdrawStake();
        vm.warp(at);
        uint256 before = a1.balance;
        vm.prank(a1);
        arb.withdrawStake();
        assertEq(a1.balance - before, 1 ether);
        (uint256 s, uint64 at2,,) = arb.arbiterOf(a1);
        assertEq(s, 0);
        assertEq(at2, 0);
        assertEq(_eligibleAt(a1), 0);
        _checkAccounting();
    }

    function test_unstake_requiresStake_andBlocksStakeAndCommits() public {
        vm.prank(a1);
        vm.expectRevert("no stake");
        arb.requestUnstake();
        _stake(a1, 1 ether);
        _age();
        _open(1, BOND);
        vm.prank(a1);
        arb.requestUnstake();
        vm.prank(a1);
        vm.expectRevert("unstaking");
        arb.stake{value: 1 ether}();
        bytes32 c = _commitment(1, 1, _salt(a1, 1), a1);
        vm.prank(a1);
        vm.expectRevert("unstaking");
        arb.commitVote(1, c);
    }

    function test_unstake_lockedByUnrevealedCommitUntilResolved_thenSlashed() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _commit(a4, 1, 2); // never reveals
        vm.prank(a4);
        arb.requestUnstake();
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        vm.warp(block.timestamp + 8 days);
        (,,, uint256 locked) = arb.arbiterOf(a4);
        assertEq(locked, 1);
        vm.prank(a4);
        vm.expectRevert("votes locked");
        arb.withdrawStake();
        arb.resolve(1);
        (uint256 effStake,, uint256 locked2) = _eff(a4);
        assertEq(effStake, 0.9 ether);
        assertEq(locked2, 0);
        uint256 before = a4.balance;
        vm.prank(a4);
        arb.withdrawStake(); // settles automatically, then pays the slashed stake
        assertEq(a4.balance - before, 0.9 ether);
        _checkAccounting();
    }

    function test_unstake_lockedByRevealedVoteInUnresolvedDispute() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        vm.prank(a1);
        arb.requestUnstake();
        vm.warp(block.timestamp + 7 days);
        vm.prank(a1);
        vm.expectRevert("votes locked");
        arb.withdrawStake();
        arb.resolve(1);
        uint256 before = a1.balance;
        vm.prank(a1);
        arb.withdrawStake();
        assertEq(a1.balance - before, 1 ether); // winner keeps full stake; reward stays claimable
        (,, uint256 cl) = _raw(a1);
        assertEq(cl, BOND / 3);
        _checkAccounting();
    }

    // ------------------------------------------------------------------ stake age (Sybil resistance)
    function test_stakeAge_freshStakeCannotVote_evenInExtension() public {
        _stakeFive();
        _open(1, BOND);
        _stake(a6, 5 ether); // staked after the dispute opened
        bytes32 c = _commitment(1, 2, _salt(a6, 1), a6);
        vm.prank(a6);
        vm.expectRevert("stake too new");
        arb.commitVote(1, c);
        (bool ok, string memory why) = arb.canCommit(1, a6);
        assertFalse(ok);
        assertEq(why, "stake too new");
        // still barred after the stake ages, because the dispute opened before it did
        _toResolve(1);
        arb.resolve(1); // no quorum: extension
        assertEq(_extensions(1), 1);
        vm.prank(a6);
        vm.expectRevert("stake too new");
        arb.commitVote(1, c);
        // but it can vote on a dispute opened after eligibleAt
        _age();
        _open(2, BOND);
        _commit(a6, 2, 2);
    }

    function test_stakeAge_boundary() public {
        _stake(a1, 1 ether);
        uint64 el = _eligibleAt(a1);
        vm.warp(uint256(el) - 1);
        _open(1, BOND); // opened one second before the stake is eligible
        vm.warp(el);
        _open(2, BOND); // opened exactly at eligibleAt
        bytes32 c1 = _commitment(1, 1, _salt(a1, 1), a1);
        vm.prank(a1);
        vm.expectRevert("stake too new");
        arb.commitVote(1, c1);
        _commit(a1, 2, 1);
    }

    function test_stakeAge_topUpResetsEligibility() public {
        _stake(a1, 1 ether);
        _age();
        _open(1, BOND);
        _stake(a1, 0.1 ether); // any increase restarts the wait for the whole stake
        bytes32 c = _commitment(1, 1, _salt(a1, 1), a1);
        vm.prank(a1);
        vm.expectRevert("stake too new");
        arb.commitVote(1, c);
    }

    function test_weight_isWholeStake_splittingGainsNothing() public {
        _stake(a1, 3 ether); // one address
        _stake(a2, 1 ether); // the same 3 ETH split over three addresses
        _stake(a3, 1 ether);
        _stake(a4, 1 ether);
        _age();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 2);
        _commit(a3, 1, 2);
        _commit(a4, 1, 2);
        (, uint256 w1,) = arb.commitOf(1, a1);
        assertEq(w1, 3 ether); // no cap
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 2);
        _reveal(a3, 1, 2);
        _reveal(a4, 1, 2);
        (,,,,,,,,, uint256 wbp, uint256 wdnp,) = arb.disputeOf(1);
        assertEq(wbp, wdnp); // 3 vs 3: equal total stake, equal weight
        _toResolve(1);
        arb.resolve(1);
        assertEq(_extensions(1), 1); // a tie is not a decision
    }

    // ------------------------------------------------------------------ commit / reveal rules
    function test_commit_partiesCannotVoteOnOwnTrade() public {
        _stake(buyer, 1 ether);
        _stake(seller, 1 ether);
        _age();
        _open(1, BOND);
        bytes32 c = _commitment(1, 1, _salt(buyer, 1), buyer);
        vm.prank(buyer);
        vm.expectRevert("party");
        arb.commitVote(1, c);
        vm.prank(seller);
        vm.expectRevert("party");
        arb.commitVote(1, c);
        (bool ok, string memory why) = arb.canCommit(1, seller);
        assertFalse(ok);
        assertEq(why, "party");
    }

    function test_commit_requiresStakeOpenDisputeAndOnce() public {
        _open(1, BOND);
        bytes32 c = _commitment(1, 1, _salt(a1, 1), a1);
        vm.prank(a1);
        vm.expectRevert("not staked");
        arb.commitVote(1, c);
        _stake(a1, 1 ether);
        vm.prank(a1);
        vm.expectRevert("stake too new");
        arb.commitVote(1, c);
        _age();
        _open(2, BOND);
        bytes32 c2 = _commitment(2, 1, _salt(a1, 2), a1);
        vm.prank(a1);
        vm.expectRevert("empty");
        arb.commitVote(2, bytes32(0));
        vm.prank(a1);
        vm.expectRevert("not open");
        arb.commitVote(99, c2);
        (bool ok,) = arb.canCommit(2, a1);
        assertTrue(ok);
        vm.prank(a1);
        arb.commitVote(2, c2);
        vm.prank(a1);
        vm.expectRevert("committed");
        arb.commitVote(2, c2);
        (bytes32 got, uint256 w, bool rev) = arb.commitOf(2, a1);
        assertEq(got, c2);
        assertEq(w, 1 ether);
        assertFalse(rev);
        string memory why;
        (ok, why) = arb.canCommit(2, a1);
        assertFalse(ok);
        assertEq(why, "committed");
    }

    function test_commit_copiedCommitmentCannotBeRevealedByCopier() public {
        _stake(a1, 1 ether);
        _stake(a2, 1 ether);
        _age();
        _open(1, BOND);
        bytes32 salt = _salt(a1, 1);
        bytes32 c = _commitment(1, 1, salt, a1);
        vm.prank(a1);
        arb.commitVote(1, c);
        vm.prank(a2);
        arb.commitVote(1, c); // copies a1's hash from the mempool
        _toReveal(1);
        vm.prank(a1);
        arb.revealVote(1, 1, salt);
        vm.prank(a2);
        vm.expectRevert("mismatch");
        arb.revealVote(1, 1, salt); // a1's vote and salt are public now, but the hash binds a1's address
        vm.prank(a2);
        vm.expectRevert("mismatch");
        arb.revealVote(1, 2, salt);
    }

    function test_commit_replayAcrossTradesFails() public {
        _stake(a1, 1 ether);
        _age();
        _open(1, BOND);
        _open(2, BOND);
        bytes32 salt = _salt(a1, 1);
        bytes32 c1 = _commitment(1, 1, salt, a1);
        vm.startPrank(a1);
        arb.commitVote(1, c1);
        arb.commitVote(2, c1); // same hash replayed on trade 2
        vm.stopPrank();
        _toReveal(2);
        vm.startPrank(a1);
        arb.revealVote(1, 1, salt);
        vm.expectRevert("mismatch");
        arb.revealVote(2, 1, salt);
        vm.stopPrank();
    }

    function test_reveal_wrongSaltWrongVoteBadVoteNoCommitDouble() public {
        _stake(a1, 1 ether);
        _stake(a2, 1 ether);
        _age();
        _open(1, BOND);
        bytes32 salt = _salt(a1, 1);
        vm.prank(a1);
        arb.commitVote(1, _commitment(1, 2, salt, a1));
        // a2 commits to an out-of-range vote with a matching hash
        vm.prank(a2);
        arb.commitVote(1, _commitment(1, 3, salt, a2));
        _toReveal(1);
        vm.startPrank(a1);
        vm.expectRevert("mismatch");
        arb.revealVote(1, 2, bytes32(uint256(salt) ^ 1));
        vm.expectRevert("mismatch");
        arb.revealVote(1, 1, salt);
        vm.expectRevert("bad vote");
        arb.revealVote(1, 0, salt);
        arb.revealVote(1, 2, salt);
        vm.expectRevert("revealed");
        arb.revealVote(1, 2, salt);
        vm.stopPrank();
        vm.prank(a2);
        vm.expectRevert("bad vote");
        arb.revealVote(1, 3, salt);
        vm.prank(a3);
        vm.expectRevert("no commit");
        arb.revealVote(1, 1, salt);
    }

    function test_timing_commitRevealResolveBoundaries() public {
        _stakeFive();
        _open(1, BOND);
        (uint64 ce, uint64 re) = _ends(1);
        vm.warp(ce);
        _commit(a1, 1, 1); // last second of COMMIT
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        vm.prank(a1);
        vm.expectRevert("not reveal phase");
        arb.revealVote(1, 1, _salt(a1, 1)); // still commit phase
        vm.warp(uint256(ce) + 1);
        bytes32 late = _commitment(1, 1, _salt(a4, 1), a4);
        vm.prank(a4);
        vm.expectRevert("commit closed");
        arb.commitVote(1, late);
        _reveal(a1, 1, 1); // first second of REVEAL
        _reveal(a2, 1, 1);
        vm.warp(re);
        _reveal(a3, 1, 1); // last second of REVEAL
        vm.expectRevert("reveal open");
        arb.resolve(1);
        vm.warp(uint256(re) + 1);
        vm.prank(a4);
        vm.expectRevert("not reveal phase");
        arb.revealVote(1, 1, _salt(a4, 1));
        arb.resolve(1);
        assertEq(_outcome(1), 1);
        vm.expectRevert("resolved");
        arb.resolve(1);
        vm.expectRevert("no dispute");
        arb.resolve(77);
    }

    function test_weight_snapshottedAtCommit_reserveIsTenPercentOfStake() public {
        _stake(a1, 5 ether);
        _stake(a2, 0.5 ether);
        _age();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        (, uint256 w1,) = arb.commitOf(1, a1);
        (, uint256 w2,) = arb.commitOf(1, a2);
        assertEq(w1, 5 ether);
        assertEq(w2, 0.5 ether);
        (, uint256 r1,) = arb.voteOf(1, a1);
        (, uint256 r2,) = arb.voteOf(1, a2);
        assertEq(r1, 0.5 ether);
        assertEq(r2, 0.05 ether);
        _stake(a2, 0.3 ether); // top-up after commit does not change the snapshotted weight
        _toReveal(1);
        _reveal(a2, 1, 1);
        (,,,,,,,,, uint256 wbp,,) = arb.disputeOf(1);
        assertEq(wbp, 0.5 ether);
    }

    function test_reserve_capsConcurrentVotes() public {
        _stake(a1, 1 ether);
        _age();
        for (uint256 i = 1; i <= 11; i++) {
            _open(i, BOND);
        }
        for (uint256 i = 1; i <= 10; i++) {
            _commit(a1, i, 1);
        }
        (, uint256 risk,) = _raw(a1);
        assertEq(risk, 1 ether); // 10 x 10%
        bytes32 c = _commitment(11, 1, _salt(a1, 11), a1);
        vm.prank(a1);
        vm.expectRevert("stake reserved");
        arb.commitVote(11, c);
        (bool ok, string memory why) = arb.canCommit(11, a1);
        assertFalse(ok);
        assertEq(why, "stake reserved");
        _stake(a1, 0.2 ether); // topping up frees room, but only for disputes opened after it ages
        vm.prank(a1);
        vm.expectRevert("stake too new");
        arb.commitVote(11, c);
        _age();
        _open(12, BOND);
        _commit(a1, 12, 1);
        (,,, uint256 locked) = arb.arbiterOf(a1);
        assertEq(locked, 11);
        _checkAccounting();
    }

    // ------------------------------------------------------------------ outcomes
    function test_buyerPaid_bondAndSlashesRewardMajorityProRata() public {
        _stake(a1, 1 ether);
        _stake(a2, 1 ether);
        _stake(a3, 1 ether);
        _stake(a4, 1 ether);
        _stake(a5, 1 ether);
        _stake(a6, 0.5 ether);
        _age();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a6, 1, 1); // weight 0.5
        _commit(a3, 1, 2); // minority
        _commit(a4, 1, 2); // minority
        _commit(a5, 1, 1); // never reveals
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a6, 1, 1);
        _reveal(a3, 1, 2);
        _reveal(a4, 1, 2);
        uint256 sellerBefore = seller.balance;
        _toResolve(1);
        arb.resolve(1);
        assertEq(_outcome(1), uint8(Outcome.BuyerPaid));
        assertEq(esc.outcomeOf(1), uint8(Outcome.BuyerPaid));
        assertEq(esc.resolvedCalls(), 1);
        assertEq(seller.balance, sellerBefore, "whole bond kept as reward");
        uint256 slashed = 0.1 ether * 3; // a3, a4 minority + a5 no-reveal
        uint256 reward = BOND + slashed;
        {
            (uint256 r,, uint256 sl, uint256 wl) = arb.settlementOf(1);
            assertEq(r, reward);
            assertEq(sl, slashed);
            assertEq(wl, 3);
        }
        // effective views before any settlement
        (, uint256 c1,) = _eff(a1);
        (, uint256 c6,) = _eff(a6);
        assertEq(c1, (reward * 1 ether) / 2.5 ether);
        assertEq(c6, (reward * 0.5 ether) / 2.5 ether);
        {
            (uint256 s3,,) = _eff(a3);
            (uint256 s5,,) = _eff(a5);
            assertEq(s3, 0.9 ether);
            assertEq(s5, 0.9 ether);
        }
        assertEq(arb.openDisputeIds().length, 0);
        _checkAccounting();
        // a1 claims (auto-settle)
        uint256 before = a1.balance;
        vm.prank(a1);
        arb.claimArbiterReward();
        assertEq(a1.balance - before, c1);
        _checkAccounting();
        _settleAllTracked();
        {
            (, uint256 rl, uint256 sl2, uint256 wl2) = arb.settlementOf(1);
            assertEq(rl, 0);
            assertEq(sl2, 0);
            assertEq(wl2, 0);
            (uint256 rs3,,) = _raw(a3);
            assertEq(rs3, 0.9 ether);
        }
        // the last winner to settle (a6) takes the rounding dust: every wei of the reward is paid out
        (,, uint256 cl2) = _raw(a2);
        (,, uint256 cl6) = _raw(a6);
        assertEq(c1 + cl2 + cl6, reward);
        assertGe(cl6, c6);
        assertEq(arb.rewardsUnsettled(), 0);
        _checkAccounting();
    }

    function test_buyerDidNotPay_halfBondToMajority_halfBackToSeller() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 2);
        _commit(a2, 1, 2);
        _commit(a3, 1, 2);
        _commit(a4, 1, 1);
        _toReveal(1);
        _reveal(a1, 1, 2);
        _reveal(a2, 1, 2);
        _reveal(a3, 1, 2);
        _reveal(a4, 1, 1);
        uint256 sellerBefore = seller.balance;
        _toResolve(1);
        arb.resolve(1);
        assertEq(_outcome(1), uint8(Outcome.BuyerDidNotPay));
        assertEq(esc.outcomeOf(1), 2);
        assertEq(seller.balance - sellerBefore, BOND - BOND / 2, "half the bond back");
        (uint256 r,,,) = arb.settlementOf(1);
        assertEq(r, BOND / 2 + 0.1 ether, "half the bond + the minority slash");
        _checkAccounting();
        _settleAllTracked();
        (,, uint256 cl1) = _raw(a1);
        (,, uint256 cl2) = _raw(a2);
        (,, uint256 cl3) = _raw(a3);
        assertEq(cl1 + cl2 + cl3, r);
        (uint256 s4,,) = _raw(a4);
        assertEq(s4, 0.9 ether);
        _checkAccounting();
    }

    function test_buyerDidNotPay_oddBond_roundsTowardSeller() public {
        _stakeFive();
        uint256 bond = 0.01 ether + 1;
        _open(1, bond);
        _commit(a1, 1, 2);
        _commit(a2, 1, 2);
        _commit(a3, 1, 2);
        _toReveal(1);
        _reveal(a1, 1, 2);
        _reveal(a2, 1, 2);
        _reveal(a3, 1, 2);
        _toResolve(1);
        uint256 s0 = seller.balance;
        arb.resolve(1);
        assertEq(seller.balance - s0, bond - bond / 2);
        (uint256 r,,,) = arb.settlementOf(1);
        assertEq(r, bond / 2);
        _settleAllTracked();
        assertEq(arb.rewardsUnsettled(), 0);
        _checkAccounting();
    }

    function test_tie_extendsThenDecides() public {
        _stake(a1, 1 ether);
        _stake(a2, 0.5 ether);
        _stake(a3, 0.5 ether);
        _stake(a4, 1 ether);
        _age();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 2);
        _commit(a3, 1, 2);
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 2);
        _reveal(a3, 1, 2);
        _toResolve(1);
        uint256 t0 = block.timestamp;
        arb.resolve(1); // 3 revealers but 1 ether vs 1 ether: extension
        (,,,, uint64 ce, uint64 re, uint16 ext, bool res,,,,) = arb.disputeOf(1);
        assertEq(ext, 1);
        assertFalse(res);
        assertEq(ce, t0 + 24 hours);
        assertEq(re, t0 + 48 hours);
        assertEq(esc.resolvedCalls(), 0);
        vm.expectRevert("reveal open");
        arb.resolve(1);
        _commit(a4, 1, 2); // an arbiter whose stake predates the dispute joins in the extension
        vm.warp(uint256(ce) + 1);
        _reveal(a4, 1, 2);
        vm.warp(uint256(re) + 1);
        arb.resolve(1);
        assertEq(_outcome(1), uint8(Outcome.BuyerDidNotPay));
        (uint256 s1,,) = _eff(a1);
        assertEq(s1, 0.9 ether);
        _settleAllTracked();
        _checkAccounting();
    }

    function test_noQuorum_extendsRepeatedly_quorumInLaterRound() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _toReveal(1);
        _reveal(a1, 1, 1);
        // rounds 2, 3, 4: nobody else shows up
        for (uint256 i = 1; i <= 3; i++) {
            _toResolve(1);
            arb.resolve(1);
            assertEq(_extensions(1), i);
            assertFalse(_resolved(1));
        }
        // round 4: three more arbiters (staked before the dispute opened) reach quorum
        _commit(a2, 1, 1);
        _commit(a3, 1, 2);
        _commit(a4, 1, 1);
        _toReveal(1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 2);
        _reveal(a4, 1, 1);
        _toResolve(1);
        arb.resolve(1);
        assertTrue(_resolved(1));
        assertEq(_outcome(1), uint8(Outcome.BuyerPaid));
        assertEq(_extensions(1), 3);
        _settleAllTracked();
        _checkAccounting();
    }

    function test_noQuorum_longStop_bondAndNonRevealerSlashToSeller_revealersSafe() public {
        _stakeFive();
        _open(1, BOND);
        (,,, uint64 openedAt,,,,,,,,) = arb.disputeOf(1);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 2); // never reveals
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        uint256 sellerBefore = seller.balance;
        uint256 calls = _resolveToEnd(1); // only 2 revealers, round after round
        assertEq(calls, 7); // round 1 + 6 extensions reach 14 days
        assertEq(_extensions(1), 6);
        assertGe(block.timestamp, uint256(openedAt) + 14 days);
        assertEq(_outcome(1), uint8(Outcome.LongStop));
        assertEq(esc.outcomeOf(1), 3);
        assertEq(seller.balance - sellerBefore, BOND + 0.1 ether, "bond + non-revealer reserve to the seller");
        (uint256 r,,,) = arb.settlementOf(1);
        assertEq(r, 0, "no reward at the long-stop");
        (uint256 s1, uint256 c1,) = _eff(a1);
        (uint256 s3,,) = _eff(a3);
        assertEq(s1, 1 ether);
        assertEq(c1, 0);
        assertEq(s3, 0.9 ether);
        _checkAccounting();
        _settleAllTracked();
        _checkAccounting();
    }

    function test_longStop_timing_extendsBefore14Days_endsAtFirstResolveAfter() public {
        _open(1, BOND);
        (,,, uint64 openedAt,,,,,,,,) = arb.disputeOf(1);
        // nobody calls resolve for 13 days: the first call still extends
        vm.warp(uint256(openedAt) + 13 days);
        arb.resolve(1);
        assertEq(_extensions(1), 1);
        assertFalse(_resolved(1));
        (, uint64 re) = _ends(1);
        assertGt(re, uint256(openedAt) + 14 days); // one round may run past day 14
        vm.warp(uint256(re) + 1);
        uint256 s0 = seller.balance;
        arb.resolve(1);
        assertTrue(_resolved(1));
        assertEq(_outcome(1), uint8(Outcome.LongStop));
        assertEq(seller.balance - s0, BOND);
        _checkAccounting();
    }

    function test_noCommitsAtAll_longStopReturnsBond() public {
        _open(1, BOND);
        uint256 sellerBefore = seller.balance;
        _resolveToEnd(1);
        assertEq(_outcome(1), uint8(Outcome.LongStop));
        assertEq(seller.balance - sellerBefore, BOND);
        _checkAccounting();
    }

    function test_roundOneCommitterMayRevealInExtension() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 2);
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _toResolve(1);
        arb.resolve(1); // 2 revealers: extension
        (uint64 ce,) = _ends(1);
        vm.prank(a3);
        vm.expectRevert("not reveal phase");
        arb.revealVote(1, 2, _salt(a3, 1));
        vm.warp(uint256(ce) + 1);
        _reveal(a3, 1, 2);
        _toResolve(1);
        arb.resolve(1);
        assertEq(_outcome(1), uint8(Outcome.BuyerPaid));
        (uint256 s3,,) = _eff(a3);
        assertEq(s3, 0.9 ether); // minority revealer slashed
        _settleAllTracked();
        _checkAccounting();
    }

    function test_strictMajorityByWeightNotHeadcount() public {
        _stake(a1, 1 ether);
        _stake(a2, 0.2 ether);
        _stake(a3, 0.2 ether);
        _stake(a4, 0.2 ether);
        _age();
        _open(1, BOND);
        _commit(a1, 1, 2);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _commit(a4, 1, 1);
        _toReveal(1);
        _reveal(a1, 1, 2);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        _reveal(a4, 1, 1);
        _toResolve(1);
        arb.resolve(1);
        assertEq(_outcome(1), uint8(Outcome.BuyerDidNotPay)); // 1.0 vs 0.6
        _settleAllTracked();
        _checkAccounting();
    }

    // ------------------------------------------------------------------ settlement and claims
    function test_settle_rules() public {
        _stakeFive();
        _open(1, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        vm.expectRevert("not resolved");
        arb.settle(1, a1);
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        _toResolve(1);
        arb.resolve(1);
        vm.expectRevert("no commit");
        arb.settle(1, a4);
        vm.prank(a5); // anyone can settle anyone
        arb.settle(1, a1);
        vm.expectRevert("settled");
        arb.settle(1, a1);
        (,, uint256 cl) = _raw(a1);
        assertEq(cl, BOND / 3);
        (,,,, uint256 locked, uint256[] memory pend,) = arb.accountOf(a1);
        assertEq(locked, 0);
        assertEq(pend.length, 0);
        vm.prank(a4);
        vm.expectRevert("nothing to claim");
        arb.claimArbiterReward();
        _checkAccounting();
    }

    function test_roundingDust_goesToLastWinner() public {
        _stake(a1, 1 ether);
        _stake(a2, 1 ether);
        _stake(a3, 1 ether);
        _age();
        uint256 bond = 0.01 ether + 2; // not divisible by 3
        _open(1, bond);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        _toResolve(1);
        arb.resolve(1);
        uint256 share = bond / 3;
        arb.settle(1, a1);
        arb.settle(1, a2);
        (, uint256 last,) = _eff(a3);
        assertEq(last, bond - share * 2); // the view already includes the dust for the last winner
        arb.settle(1, a3);
        (,, uint256 cl3) = _raw(a3);
        assertEq(cl3, bond - share * 2);
        assertEq(arb.rewardsUnsettled(), 0);
        _checkAccounting();
    }

    function test_multipleDisputes_autoSettleOnClaim() public {
        _stakeFive();
        for (uint256 i = 1; i <= 3; i++) {
            _open(i, BOND);
            _commit(a1, i, 1);
            _commit(a2, i, 1);
            _commit(a3, i, 1);
        }
        _toReveal(3);
        for (uint256 i = 1; i <= 3; i++) {
            _reveal(a1, i, 1);
            _reveal(a2, i, 1);
            _reveal(a3, i, 1);
        }
        _toResolve(3);
        arb.resolve(2);
        uint256[] memory open = arb.openDisputeIds();
        assertEq(open.length, 2);
        assertTrue((open[0] == 1 && open[1] == 3) || (open[0] == 3 && open[1] == 1));
        arb.resolve(1);
        arb.resolve(3);
        (, uint256 c1, uint256 locked) = _eff(a1);
        assertEq(c1, (BOND / 3) * 3);
        assertEq(locked, 0);
        uint256 before = a1.balance;
        vm.prank(a1);
        arb.claimArbiterReward();
        assertEq(a1.balance - before, (BOND / 3) * 3);
        (,,,, uint256 l2, uint256[] memory pend,) = arb.accountOf(a1);
        assertEq(l2, 0);
        assertEq(pend.length, 0);
        _checkAccounting();
    }

    function test_commitSettlesResolvedVotesFirst_weightExcludesDecidedSlash() public {
        _stakeFive();
        _open(1, BOND);
        _open(2, BOND);
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _commit(a4, 1, 2); // will be slashed 0.1
        _toReveal(1);
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        _reveal(a4, 1, 2);
        _toResolve(1);
        arb.resolve(1);
        (uint256 rawBefore,,) = _raw(a4);
        assertEq(rawBefore, 1 ether); // slash not applied yet
        _open(3, BOND);
        _commit(a4, 3, 1); // settles the resolved vote first
        (, uint256 w,) = arb.commitOf(3, a4);
        assertEq(w, 0.9 ether);
        _checkAccounting();
    }

    // ------------------------------------------------------------------ evidence
    function test_evidence_partiesOnlyLimitsAndClosed() public {
        _stakeFive();
        _open(1, BOND);
        vm.prank(a1);
        vm.expectRevert("not a party");
        arb.submitEvidence(1, "ipfs://x");
        vm.prank(buyer);
        vm.expectRevert("uri length");
        arb.submitEvidence(1, "");
        bytes memory big = new bytes(513);
        vm.prank(buyer);
        vm.expectRevert("uri length");
        arb.submitEvidence(1, string(big));
        for (uint256 i = 0; i < 16; i++) {
            vm.prank(buyer);
            arb.submitEvidence(1, "ipfs://buyer");
        }
        vm.prank(buyer);
        vm.expectRevert("evidence limit");
        arb.submitEvidence(1, "ipfs://buyer");
        vm.prank(seller); // buyer filling their quota does not block the seller
        arb.submitEvidence(1, "https://x.com/seller/status/1");
        (string[] memory uris, address[] memory by) = arb.evidenceOf(1);
        assertEq(uris.length, 17);
        assertEq(by[16], seller);
        assertEq(uris[16], "https://x.com/seller/status/1");
        _commit(a1, 1, 1);
        _commit(a2, 1, 1);
        _commit(a3, 1, 1);
        _toReveal(1);
        vm.prank(seller); // still allowed during reveal
        arb.submitEvidence(1, "ipfs://late");
        _reveal(a1, 1, 1);
        _reveal(a2, 1, 1);
        _reveal(a3, 1, 1);
        _toResolve(1);
        arb.resolve(1);
        vm.prank(seller);
        vm.expectRevert("not open");
        arb.submitEvidence(1, "ipfs://after");
    }

    // ------------------------------------------------------------------ malicious receivers
    function _quorumBuyerDidNotPay(uint256 id) internal {
        _commit(a1, id, 2);
        _commit(a2, id, 2);
        _commit(a3, id, 2);
        _toReveal(id);
        _reveal(a1, id, 2);
        _reveal(a2, id, 2);
        _reveal(a3, id, 2);
        _toResolve(id);
    }

    function test_rejectingSeller_bondCreditedToClaimable_thenClaimTo() public {
        _stakeFive();
        RejectingSeller rs = new RejectingSeller();
        tracked.push(address(rs));
        _openFor(1, BOND, buyer, address(rs));
        rs.submit(arb, 1, "ipfs://proof");
        _quorumBuyerDidNotPay(1);
        arb.resolve(1); // must not revert although the seller rejects ETH
        assertEq(address(rs).balance, 0);
        (, uint256 cl,) = _eff(address(rs));
        assertEq(cl, BOND - BOND / 2);
        _checkAccounting();
        vm.expectRevert("send failed");
        rs.claim(arb); // it still cannot receive; the balance stays owed
        (, uint256 cl2,) = _eff(address(rs));
        assertEq(cl2, BOND - BOND / 2);
        vm.expectRevert("zero to");
        rs.claimTo(arb, address(0));
        address sink = makeAddr("sink");
        rs.claimTo(arb, sink); // nothing locks: paid to an address it picks
        assertEq(sink.balance, BOND - BOND / 2);
        (, uint256 cl3,) = _eff(address(rs));
        assertEq(cl3, 0);
        _settleAllTracked();
        _checkAccounting();
    }

    function test_gasBombSeller_pushGasLimited_credited() public {
        _stakeFive();
        GasBombSeller gs = new GasBombSeller();
        tracked.push(address(gs));
        _openFor(1, BOND, buyer, address(gs));
        _quorumBuyerDidNotPay(1);
        arb.resolve{gas: 1_000_000}(1);
        assertTrue(_resolved(1));
        (, uint256 cl,) = _eff(address(gs));
        assertEq(cl, BOND - BOND / 2);
        _checkAccounting();
    }

    function test_gasBombSeller_longStopCredited() public {
        GasBombSeller gs = new GasBombSeller();
        tracked.push(address(gs));
        _openFor(1, BOND, buyer, address(gs));
        _resolveToEnd(1);
        (, uint256 cl,) = _eff(address(gs));
        assertEq(cl, BOND);
        _checkAccounting();
    }

    function test_reentrantSeller_cannotReenter() public {
        _stakeFive();
        ReentrantSeller rs = new ReentrantSeller(arb, 1);
        tracked.push(address(rs));
        _openFor(1, BOND, buyer, address(rs));
        _quorumBuyerDidNotPay(1);
        arb.resolve(1);
        assertTrue(rs.attempted());
        assertFalse(rs.reentered());
        assertEq(address(rs).balance, BOND - BOND / 2); // push succeeded (re-entry attempts failed inside receive)
        assertEq(esc.resolvedCalls(), 1);
        _checkAccounting();
    }

    function _contractArbiterWins(ContractArbiter ca, uint256 id) internal {
        bytes32 salt = keccak256("ca");
        ca.doCommit(id, _commitment(id, 2, salt, address(ca)));
        _commit(a1, id, 2);
        _commit(a2, id, 2);
        _toReveal(id);
        ca.doReveal(id, 2, salt);
        _reveal(a1, id, 2);
        _reveal(a2, id, 2);
        _toResolve(id);
        arb.resolve(id);
    }

    function test_reentrantArbiter_claimPaidOnce() public {
        ContractArbiter ca = new ContractArbiter(arb);
        tracked.push(address(ca));
        ca.doStake{value: 1 ether}();
        _stakeFive();
        _open(1, BOND);
        _contractArbiterWins(ca, 1);
        (, uint256 expected,) = _eff(address(ca));
        assertEq(expected, (BOND / 2) / 3);
        ca.setReenter(true);
        ca.doClaim();
        assertEq(ca.receivedCount(), 1);
        assertEq(ca.received(), expected);
        (, uint256 left,) = _eff(address(ca));
        assertEq(left, 0);
        _checkAccounting();
    }

    function test_reentrantArbiter_withdrawPaidOnce() public {
        ContractArbiter ca = new ContractArbiter(arb);
        tracked.push(address(ca));
        ca.doStake{value: 2 ether}();
        ca.doRequestUnstake();
        vm.warp(block.timestamp + 7 days);
        ca.setReenter(true);
        ca.doWithdraw();
        assertEq(ca.receivedCount(), 1);
        assertEq(ca.received(), 2 ether);
        assertEq(address(arb).balance, 0);
        _checkAccounting();
    }

    function test_rejectingArbiter_claimAndWithdrawTo() public {
        ContractArbiter ca = new ContractArbiter(arb);
        tracked.push(address(ca));
        ca.doStake{value: 1 ether}();
        _stakeFive();
        _open(1, BOND);
        _contractArbiterWins(ca, 1);
        ca.setReject(true);
        vm.expectRevert("send failed");
        ca.doClaim();
        (, uint256 cl,) = _eff(address(ca));
        assertEq(cl, (BOND / 2) / 3);
        _checkAccounting();
        address sink = makeAddr("caSink");
        ca.doClaimTo(sink);
        assertEq(sink.balance, (BOND / 2) / 3);
        ca.doRequestUnstake();
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert("send failed");
        ca.doWithdraw();
        vm.expectRevert("zero to");
        ca.doWithdrawTo(address(0));
        ca.doWithdrawTo(sink);
        assertEq(sink.balance, (BOND / 2) / 3 + 1 ether);
        assertEq(ca.received(), 0);
        _checkAccounting();
    }

    function test_escrowReentryDuringResolveBlocked() public {
        _stakeFive();
        _open(1, BOND);
        esc.setReenter(true);
        _quorumBuyerDidNotPay(1);
        arb.resolve(1);
        assertFalse(esc.reenterSucceeded());
        _settleAllTracked();
        _checkAccounting();
    }

    function test_escrowRevert_resolveRevertsAndDisputeStaysOpen() public {
        _stakeFive();
        _open(1, BOND);
        _quorumBuyerDidNotPay(1);
        esc.setRevert(true);
        vm.expectRevert("escrow revert");
        arb.resolve(1);
        assertFalse(_resolved(1));
        esc.setRevert(false);
        arb.resolve(1);
        assertTrue(_resolved(1));
        _checkAccounting();
    }

    function test_noDirectEthTransfers() public {
        (bool ok,) = address(arb).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_canCommit_reasons() public {
        _stake(a1, 1 ether);
        _age();
        (bool ok, string memory why) = arb.canCommit(1, a1);
        assertFalse(ok);
        assertEq(why, "not open");
        _open(1, BOND);
        (ok, why) = arb.canCommit(1, a2);
        assertEq(why, "not staked");
        (ok, why) = arb.canCommit(1, a1);
        assertTrue(ok);
        vm.prank(a1);
        arb.requestUnstake();
        (ok, why) = arb.canCommit(1, a1);
        assertEq(why, "unstaking");
        _toReveal(1);
        (ok, why) = arb.canCommit(1, a1);
        assertEq(why, "commit closed");
    }

    // ------------------------------------------------------------------ fuzz
    uint256[5] internal fzSt;

    function _fzArb(uint256 i) internal view returns (address) {
        address[5] memory arbs = [a1, a2, a3, a4, a5];
        return arbs[i];
    }

    function _fzStakeAll(uint96[5] memory stakes) internal {
        for (uint256 i = 0; i < 5; i++) {
            fzSt[i] = bound(stakes[i], 0.01 ether, 3 ether);
            _stake(_fzArb(i), fzSt[i]);
        }
        _age();
    }

    function _fzCommitAll(uint8 voteMask) internal {
        for (uint256 i = 0; i < 5; i++) {
            _commit(_fzArb(i), 1, uint8((voteMask >> i) & 1) + 1);
        }
    }

    function _fzRevealAll(uint8 voteMask, uint8 revealMask) internal returns (uint8 expected, uint256 lostReserves) {
        uint256 wBP;
        uint256 wDNP;
        uint256 revealers;
        for (uint256 i = 0; i < 5; i++) {
            if ((revealMask >> i) & 1 == 1) {
                uint8 v = uint8((voteMask >> i) & 1) + 1;
                _reveal(_fzArb(i), 1, v);
                if (v == 1) wBP += fzSt[i];
                else wDNP += fzSt[i];
                revealers++;
            } else {
                lostReserves += fzSt[i] / 10;
            }
        }
        bool decided = revealers >= 3 && wBP != wDNP;
        expected = !decided ? 3 : (wBP > wDNP ? 1 : 2);
    }

    function _fzCheckStakes(uint8 voteMask, uint8 revealMask, uint8 expected) internal view {
        uint256 claimSum;
        for (uint256 i = 0; i < 5; i++) {
            (uint256 s,, uint256 cl) = _raw(_fzArb(i));
            bool rev = (revealMask >> i) & 1 == 1;
            uint8 v = uint8((voteMask >> i) & 1) + 1;
            bool safe = expected == 3 ? rev : (rev && v == expected);
            assertEq(s, safe ? fzSt[i] : fzSt[i] - fzSt[i] / 10, "stake after settle");
            claimSum += cl;
        }
        assertEq(arb.rewardsUnsettled(), 0);
        assertEq(arb.slashesUnsettled(), 0);
        assertEq(address(arb).balance, arb.totalStaked() + claimSum);
    }

    /// Random stakes, votes and reveals on one dispute: outcome matches an independent tally,
    /// winners keep their stake, losers lose exactly 10%, the seller gets exactly its share, every wei is
    /// accounted for, and nothing is ever split.
    function testFuzz_singleDisputeConservation(
        uint96[5] memory stakes,
        uint8 voteMask,
        uint8 revealMask,
        uint96 bondIn
    ) public {
        uint256 bond = bound(bondIn, 0.002 ether, 1 ether);
        _fzStakeAll(stakes);
        _open(1, bond);
        _fzCommitAll(voteMask);
        _toReveal(1);
        (uint8 expected, uint256 lost) = _fzRevealAll(voteMask, revealMask);
        uint256 sellerBefore = seller.balance;
        uint256 balBefore = address(arb).balance;
        _resolveToEnd(1);
        assertEq(_outcome(1), expected);
        assertEq(esc.outcomeOf(1), expected);
        uint256 toSeller = expected == 1 ? 0 : expected == 2 ? bond - bond / 2 : bond + lost;
        assertEq(seller.balance - sellerBefore, toSeller);
        assertEq(balBefore - address(arb).balance, toSeller);
        _checkAccounting();
        _settleAllTracked();
        _checkAccounting();
        _fzCheckStakes(voteMask, revealMask, expected);
    }
}

// ============================================================================ stateful invariant

contract ArbHandler is CommonBase, StdUtils {
    OtcArbitration public arb;
    MockEscrow public esc;
    address public buyer = address(0xB0B);
    address public seller = address(0x5E11);
    address[] public actors;
    uint256[] public ids;
    uint256 public nextId = 1;
    mapping(uint256 => mapping(address => uint8)) public voted;
    uint256 public nCommits;
    uint256 public nReveals;
    uint256 public nResolveCalls;
    uint256 public nSettles;
    uint256 public nClaims;
    uint256 public nWithdraws;

    constructor(OtcArbitration a, MockEscrow e) {
        arb = a;
        esc = e;
        for (uint256 i = 0; i < 6; i++) {
            address x = address(uint160(0xA000 + i));
            actors.push(x);
            vm.deal(x, 1_000 ether);
        }
        vm.deal(address(this), 1_000 ether);
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _id(uint256 s) internal view returns (uint256) {
        return ids[s % ids.length];
    }

    /// initial stakes 0.05, 0.30, 0.55, ... ETH (called once from setUp, before the stakes age)
    function seedStakes() external {
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            arb.stake{value: 0.05 ether + i * 0.25 ether}();
        }
    }

    function stake(uint256 who, uint256 amt) external {
        amt = bound(amt, 0.01 ether, 2 ether);
        vm.prank(_actor(who));
        try arb.stake{value: amt}() {} catch {}
    }

    function open(uint256 bond) external {
        if (ids.length >= 8) return;
        bond = bound(bond, 0.002 ether, 0.5 ether);
        esc.open{value: bond}(nextId, buyer, seller);
        ids.push(nextId);
        nextId++;
    }

    function commit(uint256 who, uint256 t, uint256 v) external {
        if (ids.length == 0) return;
        address a = _actor(who);
        (uint256 st,,, uint64 unstakeAt,,,) = arb.accountOf(a);
        if (st < 0.01 ether && unstakeAt == 0) {
            vm.prank(a);
            arb.stake{value: 0.05 ether + (v % 3) * 0.5 ether}(); // too new for current disputes
        }
        uint256 id = _id(t);
        uint256 start = t % ids.length;
        for (uint256 k = 0; k < ids.length; k++) {
            uint256 cand = ids[(start + k) % ids.length];
            (,,,, uint64 ce,,, bool res,,,,) = arb.disputeOf(cand);
            if (!res && block.timestamp <= ce && voted[cand][a] == 0) {
                id = cand;
                break;
            }
        }
        uint8 vote = uint8(v % 2) + 1;
        bytes32 salt = keccak256(abi.encode(a, id));
        vm.prank(a);
        try arb.commitVote(id, keccak256(abi.encode(id, vote, salt, a))) {
            voted[id][a] = vote;
            nCommits++;
        } catch {}
    }

    /// Reveals every pending vote of one actor that is in its reveal window.
    function reveal(uint256 who) external {
        address a = _actor(who);
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint8 vote = voted[id][a];
            if (vote == 0) continue;
            vm.prank(a);
            try arb.revealVote(id, vote, keccak256(abi.encode(a, id))) {
                nReveals++;
            } catch {}
        }
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1 minutes, 20 hours));
    }

    /// Tries resolve on every dispute, starting at a random one.
    function resolve(uint256 t) external {
        if (ids.length == 0) return;
        uint256 start = t % ids.length;
        for (uint256 k = 0; k < ids.length; k++) {
            try arb.resolve(ids[(start + k) % ids.length]) {
                nResolveCalls++;
            } catch {}
        }
    }

    function settle(uint256 who) external {
        address a = _actor(who);
        for (uint256 i = 0; i < ids.length; i++) {
            try arb.settle(ids[i], a) {
                nSettles++;
            } catch {}
        }
    }

    function claim(uint256 who) external {
        vm.prank(_actor(who));
        try arb.claimArbiterReward() {
            nClaims++;
        } catch {}
    }

    function requestUnstake(uint256 who) external {
        vm.prank(_actor(who));
        try arb.requestUnstake() {} catch {}
    }

    function withdraw(uint256 who) external {
        vm.prank(_actor(who));
        try arb.withdrawStake() {
            nWithdraws++;
        } catch {}
    }
}

contract OtcArbitrationInvariantTest is Test {
    OtcArbitration arb;
    MockEscrow esc;
    ArbHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        arb = new OtcArbitration();
        esc = new MockEscrow(arb);
        arb.bind(address(esc));
        handler = new ArbHandler(arb, esc);
        handler.seedStakes();
        vm.warp(block.timestamp + arb.STAKE_AGE());
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = ArbHandler.stake.selector;
        sel[1] = ArbHandler.open.selector;
        sel[2] = ArbHandler.commit.selector;
        sel[3] = ArbHandler.reveal.selector;
        sel[4] = ArbHandler.warp.selector;
        sel[5] = ArbHandler.resolve.selector;
        sel[6] = ArbHandler.settle.selector;
        sel[7] = ArbHandler.claim.selector;
        sel[8] = ArbHandler.requestUnstake.selector;
        sel[9] = ArbHandler.withdraw.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 150
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_balanceEqualsLedger() public view {
        assertEq(
            address(arb).balance + arb.slashesUnsettled(),
            arb.totalStaked() + arb.totalClaimable() + arb.bondsHeld() + arb.rewardsUnsettled()
        );
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 150
    function invariant_ledgerEqualsAccountsAndSolvent() public view {
        uint256 n = handler.actorsLength();
        uint256 sStake;
        uint256 sClaim;
        uint256 sEffStake;
        uint256 sEffClaim;
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            (uint256 st, uint256 risk, uint256 cl,,,,) = arb.accountOf(a);
            assertLe(risk, st);
            sStake += st;
            sClaim += cl;
            (uint256 es,, uint256 ec,) = arb.arbiterOf(a);
            sEffStake += es;
            sEffClaim += ec;
        }
        // the seller can be owed a failed bond push; here it is an EOA so it never is
        assertEq(sStake, arb.totalStaked());
        assertEq(sClaim, arb.totalClaimable());
        uint256 m = handler.idsLength();
        uint256 sBond;
        uint256 sRl;
        uint256 sSl;
        for (uint256 t = 0; t < m; t++) {
            uint256 id = handler.ids(t);
            (,, uint256 bond,,,,, bool resolved,,,,) = arb.disputeOf(id);
            (, uint256 rl, uint256 sl,) = arb.settlementOf(id);
            if (!resolved) sBond += bond;
            sRl += rl;
            sSl += sl;
        }
        assertEq(sBond, arb.bondsHeld());
        assertEq(sRl, arb.rewardsUnsettled());
        assertEq(sSl, arb.slashesUnsettled());
        assertEq(sEffStake, arb.totalStaked() - arb.slashesUnsettled());
        uint256 shares = sEffClaim - sClaim;
        assertLe(shares, arb.rewardsUnsettled());
        assertLe(arb.rewardsUnsettled() - shares, n * m);
        assertGe(address(arb).balance, arb.bondsHeld() + sEffStake + sEffClaim);
        assertEq(_openCount(m), arb.openDisputeIds().length);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 150
    function invariant_disputesEndByLongStop() public view {
        uint256 m = handler.idsLength();
        for (uint256 t = 0; t < m; t++) {
            (,,, uint64 openedAt,, uint64 revealEnd, uint16 ext, bool resolved, uint8 o,,,) =
                arb.disputeOf(handler.ids(t));
            // a new round never starts at or after the long-stop, so no round ends later than 14 days + one round
            assertLe(uint256(revealEnd), uint256(openedAt) + arb.LONG_STOP() + arb.COMMIT() + arb.REVEAL());
            assertLe(ext, 7);
            if (resolved) assertTrue(o >= 1 && o <= 3);
        }
    }

    function test_handlerSmoke() public {
        handler.open(1);
        handler.commit(0, 0, 0);
        handler.commit(1, 0, 0);
        handler.commit(2, 0, 1);
        assertEq(handler.nCommits(), 3);
        handler.warp(20 hours);
        handler.warp(5 hours);
        handler.reveal(0);
        handler.reveal(1);
        handler.reveal(2);
        assertEq(handler.nReveals(), 3);
        handler.warp(20 hours);
        handler.warp(5 hours);
        handler.resolve(0);
        assertEq(handler.nResolveCalls(), 1);
        handler.settle(0);
        handler.settle(1);
        handler.settle(2);
        assertEq(handler.nSettles(), 3);
        handler.claim(0); // voted with the minority (0.05 + 0.30 vs 0.55): nothing to claim
        handler.claim(2);
        assertEq(handler.nClaims(), 1);
    }

    function _openCount(uint256 m) internal view returns (uint256 c) {
        for (uint256 t = 0; t < m; t++) {
            (,,,,,,, bool resolved,,,,) = arb.disputeOf(handler.ids(t));
            if (!resolved) c++;
        }
    }
}
