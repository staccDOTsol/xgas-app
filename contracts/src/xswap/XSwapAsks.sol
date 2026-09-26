// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

// Source of the XSwap redeploy (script/DeployXSwap.s.sol). Copied from nft-range src/xswap at 94e29dd, the commit the
// v1 contracts on Robinhood 4663 were built from, with two changes:
//   - bid() books the xMoney that actually arrived (_pull), because xMoney burns 1 bp of every transfer and v1 booked
//     the amount sent, owing more than it held;
//   - ownership is two-step (Ownable2Step: a new owner only takes over once it calls acceptOwnership(), which proves
//     someone can sign for it) and renounceOwnership() always reverts. v1's failure was an owner nobody can sign for;
//     a mistyped transferOwnership() or a renounce would repeat it after deployment, and now neither can.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice The other direction: anything on any EVM chain in, X Money out. You post what you are giving up and the
///         least X Money you will take; solvers bid by escrowing X Money here, the HIGHEST bid wins, you send the
///         asset on its own chain, and the escrow is yours once the buyer's check window passes.
///         What this contract guarantees, and only this:
///         - the buyer's X Money is here before you part with anything, and they cannot take it back at will;
///         - you are paid unless the buyer disputes inside the window, and a dispute they lose costs them their bond;
///         - a bid nobody accepts, or an accepted deal nobody delivers, unwinds at the deadline: everyone whole.
///         Anyone can buy: no list. The bond is the permission.
contract XSwapAsks is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum State { Open, Bid, Delivered, Settled, Disputed, Cancelled }

    struct Ask {
        address seller;
        uint256 floorPay; // the least X Money the seller will take
        uint64 deadline; // nothing agreed or delivered by then: everything unwinds
        uint64 bidEnds;
        uint64 deliveredAt;
        address buyer; // best bidder
        uint256 pay; // their bid, held here
        uint256 bond; // their collateral, forfeited if they dispute and lose
        State state;
        bytes32 give; // hash of what the seller is handing over: chain, asset, amount/id, buyer's address
    }

    IERC20 public immutable xmoney;
    uint64 public window = 30 minutes;
    uint64 public bidding = 2 minutes;
    uint16 public bondBps = 2_500;
    uint16 public feeBps = 50;
    address public treasury;
    mapping(bytes32 => Ask) public asks;
    mapping(address => uint256) public credit;

    event Asked(bytes32 indexed id, address indexed seller, uint256 floorPay, uint64 deadline, bytes32 give, string memo);
    event Bid(bytes32 indexed id, address indexed buyer, uint256 pay, uint256 bond);
    event Accepted(bytes32 indexed id, address indexed buyer, uint256 pay);
    event Delivered(bytes32 indexed id, address indexed seller, bytes32 proof);
    event Settled(bytes32 indexed id, address indexed seller, uint256 paid, uint256 fee);
    event Disputed(bytes32 indexed id, address indexed buyer, string reason);
    event Resolved(bytes32 indexed id, bool forBuyer);
    event Cancelled(bytes32 indexed id);

    error BadState();
    /// renounceOwnership() is disabled: an owner of address(0) could never rule on a dispute again.
    error RenounceDisabled();
    error NotYet();
    error TooLate();
    error NotSeller();
    error NotBuyer();
    error Exists();
    error Zero();
    error Low();

    constructor(IERC20 xmoney_, address owner_, address treasury_) Ownable(owner_) {
        xmoney = xmoney_;
        treasury = treasury_;
    }

    /// @notice Always reverts. Without an owner nobody can resolve a dispute, and a disputed swap would be frozen
    ///         forever, escrow and bond both. Hand over with transferOwnership() + acceptOwnership() instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Offer something. Nothing moves yet: this is a price, not an escrow.
    function ask(bytes32 id, uint256 floorPay, uint64 deadline, bytes32 give, string calldata memo) external {
        if (floorPay == 0) revert Zero();
        if (deadline <= block.timestamp) revert TooLate();
        if (asks[id].seller != address(0)) revert Exists();
        uint64 ends = uint64(block.timestamp) + bidding;
        asks[id] = Ask({seller: msg.sender, floorPay: floorPay, deadline: deadline, bidEnds: ends > deadline ? deadline : ends, deliveredAt: 0, buyer: address(0), pay: 0, bond: 0, state: State.Open, give: give});
        emit Asked(id, msg.sender, floorPay, deadline, give, memo);
    }

    /// @notice Bid X Money for it. The money is escrowed here and the highest bid wins.
    function bid(bytes32 id, uint256 pay) external nonReentrant {
        Ask storage a = asks[id];
        if (a.state != State.Open && a.state != State.Bid) revert BadState();
        if (block.timestamp > a.bidEnds) revert TooLate();
        if (pay < a.floorPay) revert Low();
        if (a.state == State.Bid && pay <= a.pay) revert Low();
        uint256 bond = pay * bondBps / 10_000;
        // xMoney burns 1 bp of every transfer, so less than pay + bond arrives. The bid price stays exact (it is what
        // the seller is owed) and the shortfall comes out of the bond, so the escrow never owes more than it holds.
        uint256 got = _pull(msg.sender, pay + bond);
        if (got < pay) revert Low();
        bond = got - pay;
        if (a.state == State.Bid) credit[a.buyer] += a.pay + a.bond; // the one you outbid gets everything back
        a.buyer = msg.sender;
        a.pay = pay;
        a.bond = bond;
        a.state = State.Bid;
        emit Bid(id, msg.sender, pay, bond);
    }

    /// @notice Take the best bid now instead of waiting out the bidding window.
    function accept(bytes32 id) external {
        Ask storage a = asks[id];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.state != State.Bid) revert BadState();
        a.bidEnds = uint64(block.timestamp);
        emit Accepted(id, a.buyer, a.pay);
    }

    /// @notice "Sent." Only the seller, once bidding is over. The buyer then has the window to say otherwise.
    function delivered(bytes32 id, bytes32 proof) external {
        Ask storage a = asks[id];
        if (msg.sender != a.seller) revert NotSeller();
        if (a.state != State.Bid) revert BadState();
        if (block.timestamp < a.bidEnds) revert NotYet();
        if (block.timestamp > a.deadline) revert TooLate();
        a.deliveredAt = uint64(block.timestamp);
        a.state = State.Delivered;
        emit Delivered(id, msg.sender, proof);
    }

    /// @notice The buyer got it and says so: the seller is paid at once.
    function confirm(bytes32 id) external nonReentrant {
        Ask storage a = asks[id];
        if (msg.sender != a.buyer) revert NotBuyer();
        if (a.state != State.Delivered) revert BadState();
        _pay(id, a);
    }

    /// @notice Nobody challenged the delivery: pay the seller. Anyone may poke it.
    function settle(bytes32 id) external nonReentrant {
        Ask storage a = asks[id];
        if (a.state != State.Delivered) revert BadState();
        if (block.timestamp <= uint256(a.deliveredAt) + window) revert NotYet();
        _pay(id, a);
    }

    /// @notice "It never arrived." Only the buyer, only inside the window.
    function dispute(bytes32 id, string calldata reason) external {
        Ask storage a = asks[id];
        if (msg.sender != a.buyer) revert NotBuyer();
        if (a.state != State.Delivered) revert BadState();
        if (block.timestamp > uint256(a.deliveredAt) + window) revert TooLate();
        a.state = State.Disputed;
        emit Disputed(id, msg.sender, reason);
    }

    /// @notice Nothing agreed, or agreed and never delivered, and the deadline passed: unwind it.
    function cancel(bytes32 id) external nonReentrant {
        Ask storage a = asks[id];
        if (a.seller == address(0)) revert BadState();
        if (a.state != State.Open && a.state != State.Bid) revert BadState();
        if (block.timestamp <= a.deadline && msg.sender != a.seller) revert NotYet();
        if (a.state == State.Bid) {
            // before the deadline only the seller may walk, and then the buyer gets everything back
            if (block.timestamp <= a.deadline && block.timestamp > a.bidEnds) revert NotYet();
            credit[a.buyer] += a.pay + a.bond;
        }
        a.state = State.Cancelled;
        emit Cancelled(id);
    }

    /// @dev Book what arrived, not what was sent: see the note in bid().
    function _pull(address from, uint256 amount) private returns (uint256 got) {
        uint256 before = xmoney.balanceOf(address(this));
        xmoney.safeTransferFrom(from, address(this), amount);
        got = xmoney.balanceOf(address(this)) - before;
    }

    function _pay(bytes32 id, Ask storage a) private {
        a.state = State.Settled;
        uint256 fee = a.pay * feeBps / 10_000;
        credit[a.seller] += a.pay - fee;
        credit[a.buyer] += a.bond; // the bond was collateral, not payment
        if (fee > 0) credit[treasury] += fee;
        emit Settled(id, a.seller, a.pay - fee, fee);
    }

    /// @notice Rule on a dispute. For the buyer: their money and bond go back. For the seller: it settles as normal.
    function resolve(bytes32 id, bool forBuyer) external onlyOwner nonReentrant {
        Ask storage a = asks[id];
        if (a.state != State.Disputed) revert BadState();
        if (forBuyer) {
            a.state = State.Cancelled;
            credit[a.buyer] += a.pay + a.bond;
        } else {
            _pay(id, a);
            credit[a.seller] += a.bond; // a dispute the buyer loses costs them the bond
            credit[a.buyer] -= a.bond;
        }
        emit Resolved(id, forBuyer);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = credit[msg.sender];
        if (amount == 0) revert Zero();
        credit[msg.sender] = 0;
        xmoney.safeTransfer(msg.sender, amount);
    }

    function setParams(uint64 window_, uint64 bidding_, uint16 bondBps_, uint16 feeBps_, address treasury_) external onlyOwner {
        require(window_ >= 10 minutes && window_ <= 7 days, "window");
        require(bidding_ >= 30 seconds && bidding_ <= 1 days, "bidding");
        require(bondBps_ >= 1_000 && bondBps_ <= 20_000, "bond");
        require(feeBps_ <= 200, "fee");
        require(treasury_ != address(0), "treasury");
        window = window_;
        bidding = bidding_;
        bondBps = bondBps_;
        feeBps = feeBps_;
        treasury = treasury_;
    }

    function get(bytes32 id) external view returns (Ask memory) {
        return asks[id];
    }
}
