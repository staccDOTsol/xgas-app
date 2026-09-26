// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

// Source of the XSwap redeploy (script/DeployXSwap.s.sol). Copied from nft-range src/xswap at 94e29dd, the commit the
// v1 contracts on Robinhood 4663 were built from, with two changes:
//   - open() and bid() book the xMoney that actually arrived (_pull), because xMoney burns 1 bp of every transfer and
//     v1 booked the amount sent, owing more than it held;
//   - ownership is two-step (Ownable2Step: a new owner only takes over once it calls acceptOwnership(), which proves
//     someone can sign for it) and renounceOwnership() always reverts. v1's failure was an owner nobody can sign for;
//     a mistyped transferOwnership() or a renounce would repeat it after deployment, and now neither can.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice X Money in, anything on any EVM chain out. A user locks X Money here and says what they want and where;
///         a solver delivers it on that chain and claims the X Money after a challenge window. The chain this
///         contract lives on cannot see the other chain, so the guarantees are these, and only these:
///         - solvers bid: the lowest ask wins, and whatever the bidding saves goes back to the payer;
///         - the payer's money never leaves without a solver having delivered, and a delivery is a bond at risk;
///         - a claim the user disputes inside the window pays the user back their escrow AND the solver's bond;
///         - an intent nobody fills is refunded in full after its deadline;
///         - the arbiter can settle a dispute either way, and can only ever move the money of that one intent.
///         Anyone can solve: there is no list. Posting the bond is the permission, and losing a dispute is the cost.
///         Nothing here is a bridge: the solver is the bridge, its bond is the collateral, and the window is the
///         time a user has to say "it never arrived".
contract XSwapIntents is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum State { Open, Bid, Claimed, Settled, Disputed, Refunded }

    /// What an address has actually done here. Nobody grants this; it is only ever the sum of finished intents.
    struct Rep {
        uint64 filled; // intents delivered and settled
        uint64 failed; // claims the arbiter ruled against
        uint64 opened; // intents paid for
        uint64 disputed; // disputes raised
        uint64 disputesLost; // disputes the arbiter ruled against
        uint128 volume; // X Money settled, as a solver
        uint64 since; // first action, so "new" is visible
    }

    /// Who a user is willing to be served by. Checked when a solver claims, never after.
    struct Policy {
        uint32 minFilled; // jobs finished
        uint16 maxFailBps; // failures allowed, in bps of jobs taken (10_000 = anyone)
        uint16 minBondBps; // extra collateral on top of the contract's floor
        bool trustedOnly; // only addresses this user has explicitly trusted
    }

    struct Intent {
        address user; // who paid, and who gets the refund
        uint256 amount; // X Money escrowed
        uint256 fee; // protocol fee, taken from `amount` on settlement
        uint64 deadline; // nobody delivered by then: the user can refund
        uint64 bidEnds; // bidding is open until here; the user can end it early by accepting
        uint64 claimedAt;
        address solver; // the best bidder, and then the one who delivered
        uint256 ask; // what that solver wants out of the escrow; the rest goes back to the user
        uint256 bond; // the solver's collateral, slashed to the user on a lost dispute
        State state;
        bytes32 want; // hash of the order the user signed: chain, asset, amount, recipient, min out
        Policy policy; // the user's terms, frozen at open time
    }

    IERC20 public immutable xmoney;
    /// Challenge window after a delivery is claimed; the user disputes inside it, the solver withdraws after it.
    uint64 public window = 30 minutes;
    /// How long bidding stays open on a fresh intent. Short: this is a race to the lowest ask, not an auction house.
    uint64 public bidding = 2 minutes;
    /// Bond any solver must post, in bps of the escrow (10_000 = 100%). The bond is the only permission there is.
    uint16 public bondBps = 10_000;
    /// Protocol fee in bps of the escrow, taken on settlement.
    uint16 public feeBps = 50;
    address public treasury;
    mapping(bytes32 => Intent) public intents;
    mapping(address => Rep) public rep;
    /// A user's standing terms, used by `open` when none are passed. Zeroes mean "anyone".
    mapping(address => Policy) public policyOf;
    /// user → solver → "I trust this one" (what `trustedOnly` reads).
    mapping(address => mapping(address => bool)) public trusts;
    mapping(address => uint256) public credit; // solver payouts and dispute wins, pulled with `withdraw`

    event Opened(bytes32 indexed id, address indexed user, uint256 amount, uint64 deadline, bytes32 want, string memo);
    event Bid(bytes32 indexed id, address indexed solver, uint256 ask, uint256 bond);
    event Accepted(bytes32 indexed id, address indexed solver, uint256 ask);
    event Claimed(bytes32 indexed id, address indexed solver, uint256 bond, bytes32 proof);
    event Settled(bytes32 indexed id, address indexed solver, uint256 paid, uint256 fee, uint256 backToUser);
    event Disputed(bytes32 indexed id, address indexed user, string reason);
    event Resolved(bytes32 indexed id, bool forUser, uint256 toUser, uint256 toSolver);
    event Refunded(bytes32 indexed id, address indexed user, uint256 amount);
    event Params(uint64 window, uint16 bondBps, uint16 feeBps, address treasury);
    event PolicySet(address indexed user, uint32 minFilled, uint16 maxFailBps, uint16 minBondBps, bool trustedOnly);
    event Trusts(address indexed user, address indexed solver, bool trusted);

    error BadState();
    /// renounceOwnership() is disabled: an owner of address(0) could never rule on a dispute again.
    error RenounceDisabled();
    error NotYet();
    error TooLate();
    error NotUser();
    error Exists();
    error Zero();
    error NotTrusted();
    error TooGreen();
    error NotBest();
    error Outbid();

    constructor(IERC20 xmoney_, address owner_, address treasury_) Ownable(owner_) {
        xmoney = xmoney_;
        treasury = treasury_;
    }

    /// @notice Always reverts. Without an owner nobody can resolve a dispute, and a disputed swap would be frozen
    ///         forever, escrow and bond both. Hand over with transferOwnership() + acceptOwnership() instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ───────────────────────────── the user ─────────────────────────────

    /// @notice Lock X Money for an intent. `id` is the user's own handle (a uuid, a hash: anything unused).
    ///         `want` is the hash of what was asked for; the memo is the human version the UI shows back.
    function open(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string calldata memo) external {
        _open(id, amount, deadline, want, memo, policyOf[msg.sender]);
    }

    /// @notice Same, with terms for this one intent (stricter or looser than your standing ones).
    function openWith(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string calldata memo, Policy calldata policy) external {
        _open(id, amount, deadline, want, memo, policy);
    }

    function _open(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string calldata memo, Policy memory policy) private nonReentrant {
        if (amount == 0) revert Zero();
        if (deadline <= block.timestamp) revert TooLate();
        if (intents[id].user != address(0)) revert Exists();
        uint256 got = _pull(msg.sender, amount); // what arrived, after xMoney's transfer burn
        uint64 ends = uint64(block.timestamp) + bidding;
        intents[id] = Intent({user: msg.sender, amount: got, fee: got * feeBps / 10_000, deadline: deadline, bidEnds: ends > deadline ? deadline : ends, claimedAt: 0, solver: address(0), ask: got, bond: 0, state: State.Open, want: want, policy: policy});
        Rep storage r = rep[msg.sender];
        if (r.since == 0) r.since = uint64(block.timestamp);
        r.opened++;
        emit Opened(id, msg.sender, got, deadline, want, memo);
    }

    /// @notice Your standing terms: who may take your intents. Zeroes mean anyone with a bond.
    function setPolicy(Policy calldata p) external {
        require(p.maxFailBps <= 10_000 && p.minBondBps <= 50_000, "policy");
        policyOf[msg.sender] = p;
        emit PolicySet(msg.sender, p.minFilled, p.maxFailBps, p.minBondBps, p.trustedOnly);
    }

    /// @notice Name a solver you trust (or stop trusting one). Only matters when your policy says `trustedOnly`.
    function setTrusted(address solver, bool trusted) external {
        trusts[msg.sender][solver] = trusted;
        emit Trusts(msg.sender, solver, trusted);
    }

    /// @notice Would this address be allowed to take this intent right now, and with how much bond?
    function canClaim(bytes32 id, address who) external view returns (bool ok, string memory why, uint256 bond) {
        Intent storage i = intents[id];
        if (i.state != State.Open) return (false, "not open", 0);
        if (block.timestamp > i.deadline) return (false, "past its deadline", 0);
        Rep storage r = rep[who];
        if (i.policy.trustedOnly && !trusts[i.user][who]) return (false, "the payer only accepts solvers they trust", 0);
        if (r.filled < i.policy.minFilled) return (false, "not enough jobs finished", 0);
        uint64 taken = r.filled + r.failed;
        if (i.policy.maxFailBps > 0 && taken > 0 && uint256(r.failed) * 10_000 / taken > i.policy.maxFailBps) return (false, "too many failed jobs", 0);
        return (true, "", _bondFor(i));
    }

    /// @dev xMoney burns 1 bp of every transfer (XMoney._update), so less arrives than was sent. Booking the amount
    ///      sent would leave the escrow owing more than it holds, and the last withdrawal would revert. Book what
    ///      actually arrived. Outflows need no care: the escrow's balance drops by exactly what it sends.
    function _pull(address from, uint256 amount) private returns (uint256 got) {
        uint256 before = xmoney.balanceOf(address(this));
        xmoney.safeTransferFrom(from, address(this), amount);
        got = xmoney.balanceOf(address(this)) - before;
        if (got == 0) revert Zero();
    }

    function _bondFor(Intent storage i) private view returns (uint256) {
        uint16 bps = bondBps > i.policy.minBondBps ? bondBps : i.policy.minBondBps;
        return i.amount * bps / 10_000;
    }

    /// @notice Nobody claimed it before the deadline: take the money back. Always available in that case.
    function refund(bytes32 id) external nonReentrant {
        Intent storage i = intents[id];
        if (i.user == address(0)) revert BadState();
        if (i.state != State.Open && i.state != State.Bid) revert BadState();
        if (block.timestamp <= i.deadline) revert NotYet();
        // a bidder who never delivered forfeits nothing but their time: the bond goes back, the payer gets their money
        if (i.state == State.Bid && i.bond > 0) credit[i.solver] += i.bond;
        i.state = State.Refunded;
        xmoney.safeTransfer(i.user, i.amount);
        emit Refunded(id, i.user, i.amount);
    }

    /// @notice "It never arrived." Only the user, only inside the window. Freezes the money until the owner rules.
    function dispute(bytes32 id, string calldata reason) external {
        Intent storage i = intents[id];
        if (msg.sender != i.user) revert NotUser();
        if (i.state != State.Claimed) revert BadState();
        if (block.timestamp > uint256(i.claimedAt) + window) revert TooLate();
        i.state = State.Disputed;
        rep[msg.sender].disputed++;
        emit Disputed(id, msg.sender, reason);
    }

    /// @notice The user got what they asked for and says so: the solver is paid immediately, no waiting.
    function confirm(bytes32 id) external nonReentrant {
        Intent storage i = intents[id];
        if (msg.sender != i.user) revert NotUser();
        if (i.state != State.Claimed) revert BadState();
        _pay(id, i);
    }

    // ───────────────────────────── the solver ─────────────────────────────

    /// @notice Bid to fill this intent for `ask` X Money (less than the escrow: the rest goes back to the payer).
    ///         Anyone may bid; the bond is the permission. A lower bid replaces yours and your bond comes back.
    function bid(bytes32 id, uint256 ask) external nonReentrant {
        Intent storage i = intents[id];
        if (i.state != State.Open && i.state != State.Bid) revert BadState();
        if (block.timestamp > i.bidEnds) revert TooLate();
        if (ask == 0 || ask > i.amount) revert Zero();
        if (i.state == State.Bid && ask >= i.ask) revert Outbid();
        Rep storage r = rep[msg.sender];
        if (i.policy.trustedOnly && !trusts[i.user][msg.sender]) revert NotTrusted();
        if (r.filled < i.policy.minFilled) revert TooGreen();
        uint64 taken = r.filled + r.failed;
        if (i.policy.maxFailBps > 0 && taken > 0 && uint256(r.failed) * 10_000 / taken > i.policy.maxFailBps) revert TooGreen();
        if (r.since == 0) r.since = uint64(block.timestamp);
        uint256 bond = _bondFor(i);
        if (bond > 0) bond = _pull(msg.sender, bond); // book the bond that arrived, not the one sent
        if (i.state == State.Bid && i.bond > 0) credit[i.solver] += i.bond; // the one you outbid gets their bond back
        i.solver = msg.sender;
        i.ask = ask;
        i.bond = bond;
        i.state = State.Bid;
        emit Bid(id, msg.sender, ask, bond);
    }

    /// @notice Take the best bid now instead of waiting out the bidding window. The payer's call, nobody else's.
    function accept(bytes32 id) external {
        Intent storage i = intents[id];
        if (msg.sender != i.user) revert NotUser();
        if (i.state != State.Bid) revert BadState();
        i.bidEnds = uint64(block.timestamp);
        emit Accepted(id, i.solver, i.ask);
    }

    /// @notice "Delivered." Only the winning bidder, only once bidding is over. `proof` identifies the fill on the
    ///         other chain (a transaction hash): this contract cannot verify it, the payer and the arbiter can.
    function claim(bytes32 id, bytes32 proof) external nonReentrant {
        Intent storage i = intents[id];
        if (i.state != State.Bid) revert BadState();
        if (msg.sender != i.solver) revert NotBest();
        if (block.timestamp < i.bidEnds) revert NotYet();
        if (block.timestamp > i.deadline) revert TooLate();
        i.claimedAt = uint64(block.timestamp);
        i.state = State.Claimed;
        emit Claimed(id, msg.sender, i.bond, proof);
    }

    /// @notice After the window, an unchallenged claim pays out. Anyone may poke it.
    function settle(bytes32 id) external nonReentrant {
        Intent storage i = intents[id];
        if (i.state != State.Claimed) revert BadState();
        if (block.timestamp <= uint256(i.claimedAt) + window) revert NotYet();
        _pay(id, i);
    }

    function _pay(bytes32 id, Intent storage i) private {
        i.state = State.Settled;
        Rep storage r = rep[i.solver];
        r.filled++;
        r.volume += uint128(i.ask);
        uint256 fee = i.ask * feeBps / 10_000; // the fee is a cut of what the solver actually charged
        uint256 paid = i.ask - fee + i.bond; // the bond comes back with the payout
        uint256 back = i.amount - i.ask; // what the bidding saved the payer
        credit[i.solver] += paid;
        if (fee > 0) credit[treasury] += fee;
        if (back > 0) credit[i.user] += back;
        emit Settled(id, i.solver, paid, fee, back);
    }

    /// @notice Pull whatever is owed (solver payouts, dispute wins, protocol fees).
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = credit[msg.sender];
        if (amount == 0) revert Zero();
        credit[msg.sender] = 0;
        xmoney.safeTransfer(msg.sender, amount);
    }

    // ───────────────────────────── the arbiter ─────────────────────────────

    /// @notice Rule on a dispute. For the user: escrow AND bond go to them. For the solver: it settles as normal.
    ///         The owner can touch nothing else: no other intent, no other balance.
    function resolve(bytes32 id, bool forUser) external onlyOwner nonReentrant {
        Intent storage i = intents[id];
        if (i.state != State.Disputed) revert BadState();
        if (forUser) {
            i.state = State.Refunded;
            rep[i.solver].failed++;
            uint256 toUser = i.amount + i.bond;
            credit[i.user] += toUser;
            emit Resolved(id, true, toUser, 0);
        } else {
            rep[i.user].disputesLost++;
            _pay(id, i);
            emit Resolved(id, false, 0, i.ask + i.bond);
        }
    }

    /// @dev Bounded on purpose: a window a user cannot react inside, or a bond of nothing, would make the promise empty.
    function setParams(uint64 window_, uint16 bondBps_, uint16 feeBps_, address treasury_) external onlyOwner {
        require(window_ >= 10 minutes && window_ <= 7 days, "window");
        require(bondBps_ >= 2_500 && bondBps_ <= 20_000, "bond");
        require(feeBps_ <= 200, "fee");
        require(treasury_ != address(0), "treasury");
        window = window_;
        bondBps = bondBps_;
        feeBps = feeBps_;
        treasury = treasury_;
        emit Params(window_, bondBps_, feeBps_, treasury_);
    }

    /// @notice What a UI needs to show a row without decoding events.
    function get(bytes32 id) external view returns (Intent memory) {
        return intents[id];
    }
}
