// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRobinhoodEthOtc, Outcome} from "./interfaces/IRobinhoodEthOtc.sol";

/**
 * @title OtcArbitration (Robinhood Chain #4663)
 * @notice Staked, commit-reveal arbitration for RobinhoodEthOtc disputes (X Money dollars <-> native ETH).
 *
 *  - No admin. The deployer calls bind(escrow) exactly once; after that nothing can be changed.
 *  - Arbiters stake native ETH (MIN_STAKE total). Every stake increase sets eligibleAt = now + STAKE_AGE
 *    (3 days). An arbiter may commit on a dispute only if eligibleAt <= the dispute's openedAt and no unstake
 *    is pending, so stake added after a dispute opened can not vote on it. requestUnstake starts
 *    UNSTAKE_DELAY and stops new commits.
 *  - A dispute opens when the seller calls escrow.dispute with a bond of exactly bondFor(ethAmount); the
 *    escrow forwards the bond here. The trade's buyer and seller can not vote on it.
 *  - COMMIT (24h) then REVEAL (24h). commitment = keccak256(abi.encode(tradeId, uint8 vote, salt, arbiter)).
 *    vote 1 = BuyerPaid, 2 = BuyerDidNotPay. Weight = the arbiter's whole stake at commit (no cap, so
 *    splitting a stake across addresses gains nothing), locked until the dispute is resolved.
 *  - Each commit reserves SLASH_BPS (10%) of the arbiter's stake at commit time. The reserve is what a
 *    minority revealer or a committer who never reveals loses. Because reserves cannot exceed the stake,
 *    an arbiter with an unchanged stake can hold at most 10 unsettled votes at once.
 *  - resolve (anyone, after REVEAL): quorum = MIN_REVEALERS (3) distinct revealers and a strict weight majority.
 *      BuyerPaid:      the whole bond + slashed reserves go to the majority revealers.
 *      BuyerDidNotPay: half the bond + slashed reserves go to the majority revealers (arbitration cost),
 *                      the other half of the bond goes back to the seller. The escrow flags the buyer.
 *      tie / no quorum: another COMMIT + REVEAL round starts, again and again, until quorum or until
 *                      LONG_STOP (14 days) after the dispute opened. The first resolve after that without
 *                      a quorum ends the dispute as LongStop: the escrow returns the ETH to the seller and
 *                      the whole bond goes back to the seller together with the reserves of committers who
 *                      never revealed (there are no majority revealers to pay). Revealers are not slashed.
 *    There is no reward pool: arbiters are paid only from the seller's bond and from slashes.
 *    Majority revealers share the reward pro rata to weight; the last one to settle also takes the dust.
 *  - Per-arbiter settlement is lazy (no unbounded loops in resolve): settle(tradeId, arbiter) is callable by
 *    anyone, and claimArbiterReward / withdrawStake / commitVote settle the caller's resolved votes first.
 *    arbiterOf() already reports stake and claimable as they will be after settlement.
 *  - ETH to a seller (bond return) is pushed with a gas limit; if the push fails it is credited to that
 *    address's claimable balance. Every balance (claimable, stake) can also be paid out to another address
 *    with claimArbiterRewardTo / withdrawStakeTo, so an account that can not receive ETH never locks funds.
 */
contract OtcArbitration is ReentrancyGuard {
    // ------------------------------------------------------------------ constants
    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant STAKE_AGE = 3 days;
    uint256 public constant COMMIT = 24 hours;
    uint256 public constant REVEAL = 24 hours;
    uint256 public constant LONG_STOP = 14 days;
    uint256 public constant SLASH_BPS = 1000; // 10%
    uint256 public constant UNSTAKE_DELAY = 7 days;
    uint256 public constant MIN_REVEALERS = 3;
    uint256 public constant MAX_EVIDENCE_PER_PARTY = 16;
    uint256 public constant MAX_URI_BYTES = 512;
    uint256 public constant PUSH_GAS = 50_000;
    uint256 private constant BPS = 10_000;

    uint8 public constant VOTE_BUYER_PAID = 1;
    uint8 public constant VOTE_BUYER_DID_NOT_PAY = 2;

    // ------------------------------------------------------------------ types
    struct Dispute {
        address buyer;
        address seller;
        uint256 bond;
        uint64 openedAt;
        uint64 commitEnd;
        uint64 revealEnd;
        uint16 extensions; // extra COMMIT + REVEAL rounds started so far
        bool resolved;
        uint8 outcome;
        uint256 weightBuyerPaid;
        uint256 weightDidNotPay;
        uint256 revealers;
        uint256 revealersBuyerPaid;
        uint256 revealersDidNotPay;
        uint256 reserveTotal; // sum of SLASH reserves of every committer
        uint256 reserveBuyerPaid; // reserves of BuyerPaid revealers
        uint256 reserveDidNotPay; // reserves of BuyerDidNotPay revealers
        uint256 reward; // total reward to majority revealers (set at resolve)
        uint256 rewardLeft; // reward not yet settled to winners
        uint256 slashLeft; // slashes not yet deducted from losers' stakes
        uint256 winnersLeft; // majority revealers not yet settled
    }

    struct Commit {
        bytes32 commitment;
        uint128 weight; // stake at commit
        uint128 reserve; // stake * SLASH_BPS at commit time
        uint8 vote;
        bool revealed;
        bool settled;
    }

    struct Arbiter {
        uint256 stake; // total stake, including reserved amounts
        uint256 atRisk; // sum of reserves of unsettled commits (always <= stake)
        uint256 claimable; // ETH owed (rewards, failed bond pushes)
        uint64 unstakeAt;
        uint64 eligibleAt; // last stake increase + STAKE_AGE; may commit on disputes opened at or after this
        uint32 lockedCommits; // unsettled commits
    }

    struct Evidence {
        string uri;
        address by;
    }

    // ------------------------------------------------------------------ storage
    address public immutable deployer;
    address public escrow;

    uint256 public totalStaked;
    uint256 public totalClaimable;
    uint256 public bondsHeld; // bonds of unresolved disputes
    uint256 public rewardsUnsettled; // sum of rewardLeft over resolved disputes
    uint256 public slashesUnsettled; // sum of slashLeft over resolved disputes

    mapping(uint256 => Dispute) internal disputes;
    mapping(uint256 => mapping(address => Commit)) internal commits;
    mapping(address => Arbiter) internal arbiters;
    mapping(uint256 => Evidence[]) internal evidence;
    mapping(uint256 => mapping(address => uint256)) public evidenceCount;

    uint256[] internal openIds;
    mapping(uint256 => uint256) internal openIndex; // index + 1

    mapping(address => uint256[]) internal pendingTrades; // trade ids with an unsettled commit
    mapping(uint256 => mapping(address => uint256)) internal pendingIndex; // index + 1

    // ------------------------------------------------------------------ events
    event Bound(address indexed escrow);
    event DisputeOpened(
        uint256 indexed tradeId,
        address indexed buyer,
        address indexed seller,
        uint256 bond,
        uint64 commitEnd,
        uint64 revealEnd
    );
    event Staked(address indexed arbiter, uint256 amount, uint256 stake, uint64 eligibleAt);
    event UnstakeRequested(address indexed arbiter, uint64 unstakeAt);
    event StakeWithdrawn(address indexed arbiter, address indexed to, uint256 amount);
    event EvidenceSubmitted(uint256 indexed tradeId, address indexed by, string uri);
    event VoteCommitted(
        uint256 indexed tradeId, address indexed arbiter, bytes32 commitment, uint256 weight, uint256 reserve
    );
    event VoteRevealed(uint256 indexed tradeId, address indexed arbiter, uint8 vote, uint256 weight);
    event DisputeExtended(uint256 indexed tradeId, uint64 commitEnd, uint64 revealEnd, uint256 extensions);
    event DisputeResolved(uint256 indexed tradeId, uint8 outcome, uint256 reward, uint256 slashed, uint256 toSeller);
    event ArbiterSettled(uint256 indexed tradeId, address indexed arbiter, uint256 reward, uint256 slashed);
    event RewardClaimed(address indexed arbiter, address indexed to, uint256 amount);
    event EthCredited(address indexed to, uint256 amount);

    constructor() {
        deployer = msg.sender;
    }

    // ------------------------------------------------------------------ setup
    function bind(address escrow_) external {
        require(msg.sender == deployer, "not deployer");
        require(escrow == address(0), "bound");
        require(escrow_ != address(0), "zero escrow");
        escrow = escrow_;
        emit Bound(escrow_);
    }

    modifier onlyEscrow() {
        require(msg.sender == escrow && msg.sender != address(0), "only escrow");
        _;
    }

    // ------------------------------------------------------------------ escrow hook
    function openDispute(uint256 tradeId, address buyer, address seller) external payable nonReentrant onlyEscrow {
        require(buyer != address(0) && seller != address(0), "zero party");
        require(msg.value > 0, "no bond");
        Dispute storage d = disputes[tradeId];
        require(d.openedAt == 0, "exists");
        d.buyer = buyer;
        d.seller = seller;
        d.bond = msg.value;
        d.openedAt = uint64(block.timestamp);
        d.commitEnd = uint64(block.timestamp + COMMIT);
        d.revealEnd = uint64(block.timestamp + COMMIT + REVEAL);
        bondsHeld += msg.value;
        openIds.push(tradeId);
        openIndex[tradeId] = openIds.length;
        emit DisputeOpened(tradeId, buyer, seller, msg.value, d.commitEnd, d.revealEnd);
    }

    // ------------------------------------------------------------------ staking
    /// @notice Add stake. Every increase restarts the STAKE_AGE wait: the whole stake may vote only on
    ///         disputes opened at or after eligibleAt = now + STAKE_AGE.
    function stake() external payable nonReentrant {
        require(msg.value > 0, "zero");
        Arbiter storage a = arbiters[msg.sender];
        require(a.unstakeAt == 0, "unstaking");
        _settleAll(msg.sender);
        uint256 s = a.stake + msg.value;
        require(s >= MIN_STAKE, "below min stake");
        a.stake = s;
        uint64 el = uint64(block.timestamp + STAKE_AGE);
        a.eligibleAt = el;
        totalStaked += msg.value;
        emit Staked(msg.sender, msg.value, s, el);
    }

    function requestUnstake() external nonReentrant {
        Arbiter storage a = arbiters[msg.sender];
        require(a.stake > 0, "no stake");
        require(a.unstakeAt == 0, "requested");
        uint64 at = uint64(block.timestamp + UNSTAKE_DELAY);
        a.unstakeAt = at;
        emit UnstakeRequested(msg.sender, at);
    }

    function withdrawStake() external nonReentrant {
        _withdrawStake(msg.sender);
    }

    /// @notice withdrawStake, paid to `to` (for an arbiter account that can not receive ETH).
    function withdrawStakeTo(address to) external nonReentrant {
        require(to != address(0), "zero to");
        _withdrawStake(to);
    }

    // ------------------------------------------------------------------ disputes
    function submitEvidence(uint256 tradeId, string calldata uri) external {
        Dispute storage d = disputes[tradeId];
        require(d.openedAt != 0 && !d.resolved, "not open");
        require(msg.sender == d.buyer || msg.sender == d.seller, "not a party");
        uint256 len = bytes(uri).length;
        require(len > 0 && len <= MAX_URI_BYTES, "uri length");
        require(evidenceCount[tradeId][msg.sender] < MAX_EVIDENCE_PER_PARTY, "evidence limit");
        evidenceCount[tradeId][msg.sender] += 1;
        evidence[tradeId].push(Evidence({uri: uri, by: msg.sender}));
        emit EvidenceSubmitted(tradeId, msg.sender, uri);
    }

    function commitVote(uint256 tradeId, bytes32 commitment) external nonReentrant {
        Dispute storage d = disputes[tradeId];
        require(d.openedAt != 0 && !d.resolved, "not open");
        require(block.timestamp <= d.commitEnd, "commit closed");
        require(msg.sender != d.buyer && msg.sender != d.seller, "party");
        require(commitment != bytes32(0), "empty");
        Arbiter storage a = arbiters[msg.sender];
        require(a.unstakeAt == 0, "unstaking");
        _settleAll(msg.sender); // weight must not count slashes that are already decided
        uint256 s = a.stake;
        require(s >= MIN_STAKE, "not staked");
        require(a.eligibleAt <= d.openedAt, "stake too new");
        Commit storage c = commits[tradeId][msg.sender];
        require(c.commitment == bytes32(0), "committed");
        uint256 reserve = (s * SLASH_BPS) / BPS;
        require(s - a.atRisk >= reserve, "stake reserved");

        c.commitment = commitment;
        c.weight = uint128(s);
        c.reserve = uint128(reserve);
        a.atRisk += reserve;
        a.lockedCommits += 1;
        d.reserveTotal += reserve;
        pendingTrades[msg.sender].push(tradeId);
        pendingIndex[tradeId][msg.sender] = pendingTrades[msg.sender].length;
        emit VoteCommitted(tradeId, msg.sender, commitment, s, reserve);
    }

    function revealVote(uint256 tradeId, uint8 vote, bytes32 salt) external nonReentrant {
        Dispute storage d = disputes[tradeId];
        require(d.openedAt != 0 && !d.resolved, "not open");
        require(block.timestamp > d.commitEnd && block.timestamp <= d.revealEnd, "not reveal phase");
        require(vote == VOTE_BUYER_PAID || vote == VOTE_BUYER_DID_NOT_PAY, "bad vote");
        Commit storage c = commits[tradeId][msg.sender];
        require(c.commitment != bytes32(0), "no commit");
        require(!c.revealed, "revealed");
        require(keccak256(abi.encode(tradeId, vote, salt, msg.sender)) == c.commitment, "mismatch");
        c.revealed = true;
        c.vote = vote;
        d.revealers += 1;
        if (vote == VOTE_BUYER_PAID) {
            d.weightBuyerPaid += c.weight;
            d.revealersBuyerPaid += 1;
            d.reserveBuyerPaid += c.reserve;
        } else {
            d.weightDidNotPay += c.weight;
            d.revealersDidNotPay += 1;
            d.reserveDidNotPay += c.reserve;
        }
        emit VoteRevealed(tradeId, msg.sender, vote, c.weight);
    }

    function resolve(uint256 tradeId) external nonReentrant {
        Dispute storage d = disputes[tradeId];
        require(d.openedAt != 0, "no dispute");
        require(!d.resolved, "resolved");
        require(block.timestamp > d.revealEnd, "reveal open");

        bool decided = d.revealers >= MIN_REVEALERS && d.weightBuyerPaid != d.weightDidNotPay;
        if (!decided && block.timestamp < uint256(d.openedAt) + LONG_STOP) {
            d.extensions += 1;
            d.commitEnd = uint64(block.timestamp + COMMIT);
            d.revealEnd = uint64(block.timestamp + COMMIT + REVEAL);
            emit DisputeExtended(tradeId, d.commitEnd, d.revealEnd, d.extensions);
            return;
        }

        d.resolved = true;
        _removeOpen(tradeId);
        uint256 bond = d.bond;
        bondsHeld -= bond;

        uint8 o;
        uint256 slashed;
        uint256 reward;
        uint256 toSeller;
        if (!decided) {
            // long-stop: no majority revealers, so the bond and the non-revealers' reserves go to the seller
            o = uint8(Outcome.LongStop);
            slashed = d.reserveTotal - d.reserveBuyerPaid - d.reserveDidNotPay;
            toSeller = bond + slashed;
        } else if (d.weightBuyerPaid > d.weightDidNotPay) {
            o = uint8(Outcome.BuyerPaid);
            slashed = d.reserveTotal - d.reserveBuyerPaid;
            reward = bond + slashed;
            d.winnersLeft = d.revealersBuyerPaid;
        } else {
            o = uint8(Outcome.BuyerDidNotPay);
            slashed = d.reserveTotal - d.reserveDidNotPay;
            uint256 arbitrationCost = bond / 2;
            reward = arbitrationCost + slashed;
            toSeller = bond - arbitrationCost;
            d.winnersLeft = d.revealersDidNotPay;
        }
        d.outcome = o;
        d.reward = reward;
        d.rewardLeft = reward;
        d.slashLeft = slashed;
        rewardsUnsettled += reward;
        slashesUnsettled += slashed;
        emit DisputeResolved(tradeId, o, reward, slashed, toSeller);

        if (toSeller > 0) _pushOrCredit(d.seller, toSeller);
        IRobinhoodEthOtc(escrow).onDisputeResolved(tradeId, Outcome(o));
    }

    /// @notice Apply one arbiter's result for a resolved dispute (reward credit or slash). Anyone may call.
    function settle(uint256 tradeId, address arbiter) external nonReentrant {
        _settle(tradeId, arbiter);
    }

    /// @notice Pay out everything the caller is owed (rewards and credited bond returns).
    function claimArbiterReward() external nonReentrant {
        _claim(msg.sender);
    }

    /// @notice claimArbiterReward, paid to `to` (for an account that can not receive ETH).
    function claimArbiterRewardTo(address to) external nonReentrant {
        require(to != address(0), "zero to");
        _claim(to);
    }

    // ------------------------------------------------------------------ views
    function disputeOf(uint256 tradeId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint256 bond,
            uint64 openedAt,
            uint64 commitEnd,
            uint64 revealEnd,
            uint16 extensions,
            bool resolved,
            uint8 outcome,
            uint256 weightBuyerPaid,
            uint256 weightDidNotPay,
            uint256 revealers
        )
    {
        Dispute storage d = disputes[tradeId];
        buyer = d.buyer;
        seller = d.seller;
        bond = d.bond;
        openedAt = d.openedAt;
        commitEnd = d.commitEnd;
        revealEnd = d.revealEnd;
        extensions = d.extensions;
        resolved = d.resolved;
        outcome = d.outcome;
        weightBuyerPaid = d.weightBuyerPaid;
        weightDidNotPay = d.weightDidNotPay;
        revealers = d.revealers;
    }

    /// @notice Stake and claimable as they will be once every resolved vote is settled (settlement is
    ///         automatic on claimArbiterReward / withdrawStake / commitVote / stake). lockedCommits counts votes
    ///         in disputes that are not resolved yet; while it is non-zero withdrawStake reverts.
    function arbiterOf(address arbiter)
        external
        view
        returns (uint256 stake_, uint64 unstakeAt, uint256 claimable, uint256 lockedCommits)
    {
        Arbiter storage a = arbiters[arbiter];
        stake_ = a.stake;
        claimable = a.claimable;
        unstakeAt = a.unstakeAt;
        uint256[] storage list = pendingTrades[arbiter];
        for (uint256 i = 0; i < list.length; i++) {
            Dispute storage d = disputes[list[i]];
            if (!d.resolved) {
                lockedCommits++;
                continue;
            }
            (uint256 r, uint256 s,) = _settlement(d, commits[list[i]][arbiter]);
            claimable += r;
            stake_ -= s;
        }
    }

    /// @notice Raw stored arbiter state (before lazy settlement), the trade ids with unsettled votes, and
    ///         eligibleAt: the arbiter may commit only on disputes whose openedAt is >= eligibleAt.
    function accountOf(address arbiter)
        external
        view
        returns (
            uint256 stake_,
            uint256 atRisk,
            uint256 claimable,
            uint64 unstakeAt,
            uint256 lockedCommits,
            uint256[] memory pendingTradeIds,
            uint64 eligibleAt
        )
    {
        Arbiter storage a = arbiters[arbiter];
        return (a.stake, a.atRisk, a.claimable, a.unstakeAt, a.lockedCommits, pendingTrades[arbiter], a.eligibleAt);
    }

    /// @notice Whether commitVote(tradeId, ...) from `arbiter` would pass right now, and if not, why.
    function canCommit(uint256 tradeId, address arbiter) external view returns (bool ok, string memory reason) {
        Dispute storage d = disputes[tradeId];
        if (d.openedAt == 0 || d.resolved) return (false, "not open");
        if (block.timestamp > d.commitEnd) return (false, "commit closed");
        if (arbiter == d.buyer || arbiter == d.seller) return (false, "party");
        Arbiter storage a = arbiters[arbiter];
        if (a.unstakeAt != 0) return (false, "unstaking");
        (uint256 s, uint256 risk) = _effective(arbiter);
        if (s < MIN_STAKE) return (false, "not staked");
        if (a.eligibleAt > d.openedAt) return (false, "stake too new");
        if (commits[tradeId][arbiter].commitment != bytes32(0)) return (false, "committed");
        if (s - risk < (s * SLASH_BPS) / BPS) return (false, "stake reserved");
        return (true, "");
    }

    function openDisputeIds() external view returns (uint256[] memory) {
        return openIds;
    }

    function evidenceOf(uint256 tradeId) external view returns (string[] memory uris, address[] memory by) {
        Evidence[] storage list = evidence[tradeId];
        uris = new string[](list.length);
        by = new address[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            uris[i] = list[i].uri;
            by[i] = list[i].by;
        }
    }

    function commitOf(uint256 tradeId, address arbiter)
        external
        view
        returns (bytes32 commitment, uint256 weight, bool revealed)
    {
        Commit storage c = commits[tradeId][arbiter];
        return (c.commitment, c.weight, c.revealed);
    }

    /// @notice Revealed vote (0 until revealed), SLASH reserve and whether the vote has been settled.
    function voteOf(uint256 tradeId, address arbiter)
        external
        view
        returns (uint8 vote, uint256 reserve, bool settled)
    {
        Commit storage c = commits[tradeId][arbiter];
        return (c.vote, c.reserve, c.settled);
    }

    function settlementOf(uint256 tradeId)
        external
        view
        returns (uint256 reward, uint256 rewardLeft, uint256 slashLeft, uint256 winnersLeft)
    {
        Dispute storage d = disputes[tradeId];
        return (d.reward, d.rewardLeft, d.slashLeft, d.winnersLeft);
    }

    // ------------------------------------------------------------------ internals
    /// @dev (reward, slash, isWinner) for one unsettled commit of a resolved dispute.
    function _settlement(Dispute storage d, Commit storage c)
        internal
        view
        returns (uint256 reward, uint256 slash, bool winner)
    {
        uint8 o = d.outcome;
        if (o == uint8(Outcome.LongStop)) {
            return (0, c.revealed ? 0 : c.reserve, false);
        }
        if (c.revealed && c.vote == o) {
            if (d.winnersLeft == 1) return (d.rewardLeft, 0, true); // the last winner also takes the rounding dust
            uint256 majorityWeight = o == uint8(Outcome.BuyerPaid) ? d.weightBuyerPaid : d.weightDidNotPay;
            return ((d.reward * c.weight) / majorityWeight, 0, true);
        }
        return (0, c.reserve, false);
    }

    /// @dev Stake and atRisk as they will be after settling every resolved vote.
    function _effective(address arbiter) internal view returns (uint256 s, uint256 risk) {
        Arbiter storage a = arbiters[arbiter];
        s = a.stake;
        risk = a.atRisk;
        uint256[] storage list = pendingTrades[arbiter];
        for (uint256 i = 0; i < list.length; i++) {
            Dispute storage d = disputes[list[i]];
            if (!d.resolved) continue;
            Commit storage c = commits[list[i]][arbiter];
            (, uint256 sl,) = _settlement(d, c);
            s -= sl;
            risk -= c.reserve;
        }
    }

    function _settle(uint256 tradeId, address arbiter) internal {
        Dispute storage d = disputes[tradeId];
        Commit storage c = commits[tradeId][arbiter];
        require(d.resolved, "not resolved");
        require(c.commitment != bytes32(0), "no commit");
        require(!c.settled, "settled");

        (uint256 reward, uint256 slash, bool winner) = _settlement(d, c);
        c.settled = true;

        Arbiter storage a = arbiters[arbiter];
        a.atRisk -= c.reserve;
        a.lockedCommits -= 1;
        _removePending(arbiter, tradeId);

        if (slash > 0) {
            a.stake -= slash;
            totalStaked -= slash;
            d.slashLeft -= slash;
            slashesUnsettled -= slash;
        }
        if (winner) {
            d.winnersLeft -= 1;
            d.rewardLeft -= reward;
            rewardsUnsettled -= reward;
            a.claimable += reward;
            totalClaimable += reward;
        }
        emit ArbiterSettled(tradeId, arbiter, reward, slash);
    }

    function _settleAll(address arbiter) internal {
        uint256[] storage list = pendingTrades[arbiter];
        // Walk backwards: _settle swap-pops the current slot with the (already visited) last slot.
        for (uint256 i = list.length; i > 0; i--) {
            uint256 id = list[i - 1];
            if (disputes[id].resolved) _settle(id, arbiter);
        }
    }

    function _withdrawStake(address to) internal {
        Arbiter storage a = arbiters[msg.sender];
        require(a.unstakeAt != 0, "not requested");
        require(block.timestamp >= a.unstakeAt, "delay");
        _settleAll(msg.sender);
        require(a.lockedCommits == 0, "votes locked");
        uint256 amount = a.stake;
        a.stake = 0;
        a.unstakeAt = 0;
        a.eligibleAt = 0;
        totalStaked -= amount;
        emit StakeWithdrawn(msg.sender, to, amount);
        _send(to, amount);
    }

    function _claim(address to) internal {
        _settleAll(msg.sender);
        Arbiter storage a = arbiters[msg.sender];
        uint256 amount = a.claimable;
        require(amount > 0, "nothing to claim");
        a.claimable = 0;
        totalClaimable -= amount;
        emit RewardClaimed(msg.sender, to, amount);
        _send(to, amount);
    }

    function _removePending(address arbiter, uint256 tradeId) internal {
        uint256[] storage list = pendingTrades[arbiter];
        uint256 idx = pendingIndex[tradeId][arbiter] - 1;
        uint256 last = list.length - 1;
        if (idx != last) {
            uint256 moved = list[last];
            list[idx] = moved;
            pendingIndex[moved][arbiter] = idx + 1;
        }
        list.pop();
        delete pendingIndex[tradeId][arbiter];
    }

    function _removeOpen(uint256 tradeId) internal {
        uint256 idx = openIndex[tradeId] - 1;
        uint256 last = openIds.length - 1;
        if (idx != last) {
            uint256 moved = openIds[last];
            openIds[idx] = moved;
            openIndex[moved] = idx + 1;
        }
        openIds.pop();
        delete openIndex[tradeId];
    }

    /// @dev Gas-limited push that ignores return data; on failure the amount becomes claimable.
    function _pushOrCredit(address to, uint256 amount) internal {
        bool ok;
        uint256 g = PUSH_GAS;
        assembly {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            arbiters[to].claimable += amount;
            totalClaimable += amount;
            emit EthCredited(to, amount);
        }
    }

    /// @dev Full-gas send for a withdrawal; reverts on failure (the balance stays owed, and the ...To variants
    ///      let the owner pick a receiving address).
    function _send(address to, uint256 amount) internal {
        bool ok;
        assembly {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        require(ok, "send failed");
    }
}
