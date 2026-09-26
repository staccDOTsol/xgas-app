// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOtcArbitration, IOtcEscrowCallback, Outcome} from "./interfaces/IOtcArbitration.sol";

interface IWETHLike {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title RobinhoodEthOtc (Robinhood Chain #4663)
 * @notice Peer-to-peer OTC desk: dollars on X Money (off-chain, X account to X account)
 *         against native ETH on Robinhood Chain, both directions. Only the ETH leg is on-chain.
 *
 *         Sell order: the maker escrows ETH and wants dollars. A taker opens a trade as the buyer.
 *         Buy order:  the maker wants ETH and pays dollars. A taker escrows ETH as the seller.
 *
 *         Trade lifecycle:
 *         1. Open: the buyer has PAY_WINDOW (30 minutes) from openedAt to send the dollars on X Money
 *            and call markPaid. If they do not, anyone may cancelUnpaid. Sell trade: the ETH goes back onto
 *            the Sell order, which is reactivated if it can be filled again (unless the maker cancelled it,
 *            then the ETH goes to the maker). Buy trade: the ETH goes back to the taker and the Buy order
 *            gets the capacity back (unless the maker cancelled it).
 *            A buyer address can have at most one trade in Open status at a time, and a flagged address can
 *            not be the buyer of a new trade.
 *         2. Paid: the seller may release at any time. If the seller does nothing for RELEASE_WINDOW
 *            (12 hours) after paidAt, the buyer may claim (optimistic release).
 *         3. Within RELEASE_WINDOW the seller may dispute, posting a bond of exactly
 *            bondFor(ethAmount) = max(0.002 ETH, 5% of the trade) that goes to OtcArbitration. Staked arbiters
 *            decide BuyerPaid (ETH to the buyer) or BuyerDidNotPay (ETH back to the seller, buyer flagged).
 *            Without a quorum by the arbitration's long-stop the result is LongStop: ETH back to the seller,
 *            buyer not flagged.
 *
 *         Fee: FEE_BPS (10 bps = 0.1%) of every ETH amount paid to a buyer, all of it wrapped to WETH and sent
 *         to the Fee Fanout. Sellers pay no fee on ETH returned to them. No admin, no upgrade, no pause.
 *
 *         Every ETH push uses a gas-limited call; a push that fails is credited to ethOwed and can be
 *         pulled with withdrawEth / withdrawEthTo. A fee transfer that fails is held in pendingFanout and
 *         retried by flushFees (anyone may call it).
 */
contract RobinhoodEthOtc is ReentrancyGuard, IOtcEscrowCallback {
    // ------------------------------------------------------------------ constants

    uint256 public constant PAY_WINDOW = 30 minutes;
    uint256 public constant RELEASE_WINDOW = 12 hours;
    uint256 public constant FEE_BPS = 10; // 0.1%
    uint256 public constant BOND_BPS = 500; // 5%
    uint256 public constant MIN_BOND = 0.002 ether;
    uint256 public constant BPS = 10_000;
    uint256 public constant PUSH_GAS = 50_000;
    uint256 public constant MAX_HANDLE_BYTES = 64;
    uint256 public constant MAX_NOTE_BYTES = 280;
    uint256 public constant MAX_REASON_BYTES = 1000;

    address public immutable weth;
    address public immutable feeFanout;
    address public immutable arbitration;

    // ------------------------------------------------------------------ types

    enum Side {
        Sell, // maker has ETH, wants dollars
        Buy // maker has dollars, wants ETH
    }

    enum TradeStatus {
        Open,
        Paid,
        Released,
        Claimed,
        CancelledUnpaid,
        Disputed,
        Resolved
    }

    struct Order {
        address maker;
        Side side;
        string makerXHandle;
        uint256 priceCentsPerEth;
        uint256 remainingEth; // Sell: ETH still escrowed on the order. Buy: ETH still wanted.
        uint256 minEth;
        uint256 maxEth;
        bool active; // can be taken now (remainingEth >= minEth and not cancelled)
        bool cancelled; // the maker closed it; ETH coming back from its trades goes to the maker
    }

    struct Trade {
        uint256 orderId;
        address seller; // ETH source
        address buyer; // ETH recipient, pays dollars on X Money
        string sellerXHandle;
        string buyerXHandle;
        uint256 ethAmount;
        uint256 expectedCents;
        uint64 openedAt;
        uint64 paidAt;
        TradeStatus status;
        string paymentNote;
    }

    // ------------------------------------------------------------------ state

    Order[] internal _orders;
    Trade[] internal _trades;

    mapping(address => uint256) public ethOwed;
    mapping(address => bool) public flagged;
    mapping(uint256 => Outcome) public tradeOutcome;
    /// @notice 1 + id of the buyer's trade in Open status, 0 when the buyer has none.
    mapping(address => uint256) public openTradeOf;

    uint256 public totalEthOwed; // sum of ethOwed
    uint256 public pendingFanout; // fee ETH waiting to be wrapped and sent to the Fee Fanout

    // ------------------------------------------------------------------ events

    event OrderPosted(
        uint256 indexed orderId,
        address indexed maker,
        Side side,
        string makerXHandle,
        uint256 priceCentsPerEth,
        uint256 ethAmount,
        uint256 minEth,
        uint256 maxEth
    );
    event OrderCancelled(uint256 indexed orderId, address indexed maker, uint256 refundedEth);
    event OrderRefilled(uint256 indexed orderId, uint256 ethReturned, uint256 remainingEth, bool active);
    event TradeOpened(
        uint256 indexed tradeId,
        uint256 indexed orderId,
        address indexed seller,
        address buyer,
        string sellerXHandle,
        string buyerXHandle,
        uint256 ethAmount,
        uint256 expectedCents,
        uint64 payBy
    );
    event TradePaid(uint256 indexed tradeId, address indexed buyer, string paymentNote, uint64 claimableAt);
    event TradeReleased(uint256 indexed tradeId, address indexed buyer, uint256 netEth, uint256 fee);
    event TradeClaimed(uint256 indexed tradeId, address indexed buyer, uint256 netEth, uint256 fee);
    event TradeCancelled(uint256 indexed tradeId, uint256 ethReturned, bool returnedToOrder);
    event TradeDisputed(uint256 indexed tradeId, address indexed seller, uint256 bond, string reason);
    event TradeResolved(uint256 indexed tradeId, Outcome outcome, uint256 toBuyer, uint256 toSeller, uint256 fee);
    event BuyerFlagged(address indexed buyer, uint256 indexed tradeId);
    event EthCredited(address indexed account, uint256 amount);
    event EthWithdrawn(address indexed account, address indexed to, uint256 amount);
    event FeeRouted(uint256 toFanoutWeth);
    event FeeDeferred(uint256 pendingFanout);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidHandle();
    error TextTooLong();
    error OrderNotFound();
    error OrderNotActive();
    error WrongSide();
    error OutOfRange();
    error SelfTrade();
    error FlaggedAddress();
    error BuyerBusy();
    error TradeNotFound();
    error BadStatus();
    error Unauthorized();
    error PayWindowOpen();
    error PayWindowClosed();
    error ReleaseWindowOpen();
    error ReleaseWindowClosed();
    error WrongBond();
    error BadOutcome();
    error NothingOwed();
    error TransferFailed();

    // ------------------------------------------------------------------ constructor

    constructor(address weth_, address feeFanout_, address arbitration_) {
        if (weth_ == address(0) || feeFanout_ == address(0) || arbitration_ == address(0)) revert ZeroAddress();
        weth = weth_;
        feeFanout = feeFanout_;
        arbitration = arbitration_;
    }

    // ------------------------------------------------------------------ orders

    /// @notice Post a Sell order: escrow msg.value ETH, asking priceCentsPerEth US cents per 1 ETH.
    function postSell(string calldata makerXHandle, uint256 priceCentsPerEth, uint256 minEth, uint256 maxEth)
        external
        payable
        nonReentrant
        returns (uint256 orderId)
    {
        orderId = _post(Side.Sell, makerXHandle, msg.value, priceCentsPerEth, minEth, maxEth);
    }

    /// @notice Post a Buy order for up to ethWanted ETH at priceCentsPerEth. Nothing is escrowed;
    ///         the maker pays dollars on X Money for each trade a seller opens against it.
    function postBuy(
        string calldata makerXHandle,
        uint256 ethWanted,
        uint256 priceCentsPerEth,
        uint256 minEth,
        uint256 maxEth
    ) external nonReentrant returns (uint256 orderId) {
        if (flagged[msg.sender]) revert FlaggedAddress();
        orderId = _post(Side.Buy, makerXHandle, ethWanted, priceCentsPerEth, minEth, maxEth);
    }

    function _post(
        Side side,
        string calldata handle,
        uint256 amount,
        uint256 priceCentsPerEth,
        uint256 minEth,
        uint256 maxEth
    ) internal returns (uint256 orderId) {
        _checkHandle(handle);
        if (amount == 0 || minEth == 0 || maxEth < minEth || amount < minEth) revert InvalidAmount();
        if (priceCentsPerEth == 0 || _cents(minEth, priceCentsPerEth) == 0) revert InvalidPrice();

        orderId = _orders.length;
        _orders.push(
            Order({
                maker: msg.sender,
                side: side,
                makerXHandle: handle,
                priceCentsPerEth: priceCentsPerEth,
                remainingEth: amount,
                minEth: minEth,
                maxEth: maxEth,
                active: true,
                cancelled: false
            })
        );
        emit OrderPosted(orderId, msg.sender, side, handle, priceCentsPerEth, amount, minEth, maxEth);
    }

    /// @notice Maker closes an order (also one that is inactive because fills left less than minEth).
    ///         A Sell order's unlocked ETH is sent back to the maker. ETH locked in open trades is
    ///         unaffected; if such a trade is cancelled unpaid or its dispute ends with the ETH back to the
    ///         seller, that ETH goes straight to the maker instead of back onto the order.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = _order(orderId);
        if (msg.sender != o.maker) revert Unauthorized();
        if (o.cancelled) revert OrderNotActive();

        uint256 refund = o.side == Side.Sell ? o.remainingEth : 0;
        o.active = false;
        o.cancelled = true;
        o.remainingEth = 0;
        emit OrderCancelled(orderId, msg.sender, refund);
        _pay(msg.sender, refund);
    }

    // ------------------------------------------------------------------ taking

    /// @notice Take a Sell order as the buyer: lock ethAmount of the maker's ETH, then pay
    ///         expectedCents on X Money within PAY_WINDOW and call markPaid.
    function takeSell(uint256 orderId, uint256 ethAmount, string calldata buyerXHandle)
        external
        nonReentrant
        returns (uint256 tradeId)
    {
        Order storage o = _order(orderId);
        if (o.side != Side.Sell) revert WrongSide();
        if (flagged[msg.sender]) revert FlaggedAddress();
        tradeId = _open(orderId, o, ethAmount, o.maker, msg.sender, o.makerXHandle, buyerXHandle);
    }

    /// @notice Take a Buy order as the seller: escrow msg.value ETH; the maker pays you
    ///         expectedCents on X Money.
    function takeBuy(uint256 orderId, string calldata sellerXHandle)
        external
        payable
        nonReentrant
        returns (uint256 tradeId)
    {
        Order storage o = _order(orderId);
        if (o.side != Side.Buy) revert WrongSide();
        if (flagged[o.maker]) revert FlaggedAddress();
        tradeId = _open(orderId, o, msg.value, msg.sender, o.maker, sellerXHandle, o.makerXHandle);
    }

    function _open(
        uint256 orderId,
        Order storage o,
        uint256 ethAmount,
        address seller,
        address buyer,
        string memory sellerHandle,
        string memory buyerHandle
    ) internal returns (uint256 tradeId) {
        if (!o.active) revert OrderNotActive();
        if (msg.sender == o.maker) revert SelfTrade();
        if (openTradeOf[buyer] != 0) revert BuyerBusy();
        _checkHandle(msg.sender == buyer ? buyerHandle : sellerHandle);
        if (ethAmount < o.minEth || ethAmount > o.maxEth || ethAmount > o.remainingEth) revert OutOfRange();
        uint256 cents = _cents(ethAmount, o.priceCentsPerEth);
        if (cents == 0) revert InvalidPrice();

        o.remainingEth -= ethAmount;
        if (o.remainingEth < o.minEth) o.active = false; // nothing fillable remains for now

        tradeId = _trades.length;
        _trades.push(
            Trade({
                orderId: orderId,
                seller: seller,
                buyer: buyer,
                sellerXHandle: sellerHandle,
                buyerXHandle: buyerHandle,
                ethAmount: ethAmount,
                expectedCents: cents,
                openedAt: uint64(block.timestamp),
                paidAt: 0,
                status: TradeStatus.Open,
                paymentNote: ""
            })
        );
        openTradeOf[buyer] = tradeId + 1;
        emit TradeOpened(
            tradeId,
            orderId,
            seller,
            buyer,
            sellerHandle,
            buyerHandle,
            ethAmount,
            cents,
            uint64(block.timestamp + PAY_WINDOW)
        );
    }

    // ------------------------------------------------------------------ trade lifecycle

    /// @notice Buyer declares the X Money payment was sent. Allowed while
    ///         block.timestamp <= openedAt + PAY_WINDOW.
    function markPaid(uint256 tradeId, string calldata paymentNote) external nonReentrant {
        Trade storage t = _trade(tradeId);
        if (msg.sender != t.buyer) revert Unauthorized();
        if (t.status != TradeStatus.Open) revert BadStatus();
        if (block.timestamp > uint256(t.openedAt) + PAY_WINDOW) revert PayWindowClosed();
        if (bytes(paymentNote).length > MAX_NOTE_BYTES) revert TextTooLong();

        t.status = TradeStatus.Paid;
        t.paidAt = uint64(block.timestamp);
        t.paymentNote = paymentNote;
        delete openTradeOf[t.buyer];
        emit TradePaid(tradeId, msg.sender, paymentNote, uint64(block.timestamp + RELEASE_WINDOW));
    }

    /// @notice Anyone, once block.timestamp > openedAt + PAY_WINDOW and the buyer never marked paid.
    ///         Sell trade: ETH back onto the Sell order (reactivated when fillable again) unless the maker
    ///         cancelled it, then to the maker. Buy trade: ETH back to the taker who escrowed it, and the
    ///         capacity back onto the Buy order unless the maker cancelled it.
    function cancelUnpaid(uint256 tradeId) external nonReentrant {
        Trade storage t = _trade(tradeId);
        if (t.status != TradeStatus.Open) revert BadStatus();
        if (block.timestamp <= uint256(t.openedAt) + PAY_WINDOW) revert PayWindowOpen();

        t.status = TradeStatus.CancelledUnpaid;
        delete openTradeOf[t.buyer];
        bool toOrder = _returnToSeller(t, true);
        emit TradeCancelled(tradeId, t.ethAmount, toOrder);
    }

    /// @notice Seller confirms the dollars arrived: ETH minus the 0.1% fee goes to the buyer.
    function release(uint256 tradeId) external nonReentrant {
        Trade storage t = _trade(tradeId);
        if (msg.sender != t.seller) revert Unauthorized();
        if (t.status == TradeStatus.Open) delete openTradeOf[t.buyer];
        else if (t.status != TradeStatus.Paid) revert BadStatus();

        t.status = TradeStatus.Released;
        (uint256 net, uint256 fee) = _payBuyer(t.buyer, t.ethAmount);
        emit TradeReleased(tradeId, t.buyer, net, fee);
    }

    /// @notice Buyer claims after RELEASE_WINDOW passed since markPaid with no release and no dispute
    ///         (block.timestamp > paidAt + RELEASE_WINDOW).
    function claim(uint256 tradeId) external nonReentrant {
        Trade storage t = _trade(tradeId);
        if (msg.sender != t.buyer) revert Unauthorized();
        if (t.status != TradeStatus.Paid) revert BadStatus();
        if (block.timestamp <= uint256(t.paidAt) + RELEASE_WINDOW) revert ReleaseWindowOpen();

        t.status = TradeStatus.Claimed;
        (uint256 net, uint256 fee) = _payBuyer(t.buyer, t.ethAmount);
        emit TradeClaimed(tradeId, t.buyer, net, fee);
    }

    /// @notice Seller disputes a Paid trade within RELEASE_WINDOW (block.timestamp <= paidAt + RELEASE_WINDOW).
    ///         msg.value must equal bondFor(ethAmount) exactly; it is forwarded to arbitration.
    function dispute(uint256 tradeId, string calldata reason) external payable nonReentrant {
        Trade storage t = _trade(tradeId);
        if (msg.sender != t.seller) revert Unauthorized();
        if (t.status != TradeStatus.Paid) revert BadStatus();
        if (block.timestamp > uint256(t.paidAt) + RELEASE_WINDOW) revert ReleaseWindowClosed();
        if (msg.value != bondFor(t.ethAmount)) revert WrongBond();
        if (bytes(reason).length > MAX_REASON_BYTES) revert TextTooLong();

        t.status = TradeStatus.Disputed;
        emit TradeDisputed(tradeId, msg.sender, msg.value, reason);
        IOtcArbitration(arbitration).openDispute{value: msg.value}(tradeId, t.buyer, t.seller);
    }

    /// @notice Arbitration applies its ruling. Never reverts for a Disputed trade and a valid outcome,
    ///         so a resolution can not get stuck on a hostile buyer or seller.
    ///         BuyerPaid: ETH minus the fee to the buyer. BuyerDidNotPay: ETH back to the seller, buyer flagged.
    ///         LongStop: ETH back to the seller, buyer not flagged.
    function onDisputeResolved(uint256 tradeId, Outcome outcome) external override nonReentrant {
        if (msg.sender != arbitration) revert Unauthorized();
        Trade storage t = _trade(tradeId);
        if (t.status != TradeStatus.Disputed) revert BadStatus();
        if (outcome == Outcome.None || uint8(outcome) > uint8(Outcome.LongStop)) revert BadOutcome();

        t.status = TradeStatus.Resolved;
        tradeOutcome[tradeId] = outcome;

        uint256 toBuyer;
        uint256 toSeller;
        uint256 fee;
        if (outcome == Outcome.BuyerPaid) {
            (toBuyer, fee) = _payBuyer(t.buyer, t.ethAmount);
        } else {
            toSeller = t.ethAmount;
            _returnToSeller(t, false);
            if (outcome == Outcome.BuyerDidNotPay) {
                flagged[t.buyer] = true;
                emit BuyerFlagged(t.buyer, tradeId);
            }
        }
        emit TradeResolved(tradeId, outcome, toBuyer, toSeller, fee);
    }

    // ------------------------------------------------------------------ pulls

    /// @notice Pull ETH credited after a failed push.
    function withdrawEth() external nonReentrant {
        _withdraw(payable(msg.sender));
    }

    /// @notice Pull credited ETH to another address (for accounts that can not receive ETH).
    function withdrawEthTo(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _withdraw(to);
    }

    /// @notice Retry a fee transfer that failed earlier. Anyone may call.
    function flushFees() external nonReentrant {
        _flushFees();
    }

    /// @dev Self-call target so the wrap and the transfer succeed or fail together.
    function wrapAndSendFee(uint256 amount) external {
        if (msg.sender != address(this)) revert Unauthorized();
        IWETHLike(weth).deposit{value: amount}();
        if (!IWETHLike(weth).transfer(feeFanout, amount)) revert TransferFailed();
    }

    // ------------------------------------------------------------------ views

    function bondFor(uint256 ethAmount) public pure returns (uint256) {
        uint256 pct = (ethAmount * BOND_BPS) / BPS;
        return pct > MIN_BOND ? pct : MIN_BOND;
    }

    function feeFor(uint256 ethAmount) public pure returns (uint256) {
        return (ethAmount * FEE_BPS) / BPS;
    }

    function ordersLength() external view returns (uint256) {
        return _orders.length;
    }

    function tradesLength() external view returns (uint256) {
        return _trades.length;
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _order(orderId);
    }

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return _trade(tradeId);
    }

    function getOrders(uint256 offset, uint256 limit) external view returns (Order[] memory out) {
        uint256 n = _orders.length;
        if (offset >= n) return new Order[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        out = new Order[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = _orders[i];
        }
    }

    function getTrades(uint256 offset, uint256 limit) external view returns (Trade[] memory out) {
        uint256 n = _trades.length;
        if (offset >= n) return new Trade[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        out = new Trade[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = _trades[i];
        }
    }

    // ------------------------------------------------------------------ internals

    function _order(uint256 orderId) internal view returns (Order storage) {
        if (orderId >= _orders.length) revert OrderNotFound();
        return _orders[orderId];
    }

    function _trade(uint256 tradeId) internal view returns (Trade storage) {
        if (tradeId >= _trades.length) revert TradeNotFound();
        return _trades[tradeId];
    }

    function _checkHandle(string memory handle) internal pure {
        uint256 len = bytes(handle).length;
        if (len == 0 || len > MAX_HANDLE_BYTES) revert InvalidHandle();
    }

    function _cents(uint256 ethAmount, uint256 priceCentsPerEth) internal pure returns (uint256) {
        return (ethAmount * priceCentsPerEth) / 1e18;
    }

    /// @dev Sell trade on an order the maker has not cancelled: the ETH goes back onto the order, which is
    ///      reactivated once it is fillable again. Otherwise the ETH is pushed to the seller. On an unpaid
    ///      cancel of a Buy trade the Buy order also gets the capacity back (unless the maker cancelled it).
    function _returnToSeller(Trade storage t, bool unpaidCancel) internal returns (bool toOrder) {
        Order storage o = _orders[t.orderId];
        if (!o.cancelled) {
            if (o.side == Side.Sell) {
                _refill(t.orderId, o, t.ethAmount);
                return true;
            }
            if (unpaidCancel) _refill(t.orderId, o, t.ethAmount);
        }
        _pay(t.seller, t.ethAmount);
        return false;
    }

    function _refill(uint256 orderId, Order storage o, uint256 amount) internal {
        uint256 rem = o.remainingEth + amount;
        o.remainingEth = rem;
        if (!o.active && rem >= o.minEth) o.active = true;
        emit OrderRefilled(orderId, amount, rem, o.active);
    }

    function _payBuyer(address buyer, uint256 amount) internal returns (uint256 net, uint256 fee) {
        fee = feeFor(amount);
        net = amount - fee;
        if (fee > 0) {
            pendingFanout += fee;
            _flushFees();
        }
        _pay(buyer, net);
    }

    function _flushFees() internal {
        uint256 f = pendingFanout;
        if (f == 0) return;
        pendingFanout = 0;
        try this.wrapAndSendFee(f) {
            emit FeeRouted(f);
        } catch {
            pendingFanout = f;
            emit FeeDeferred(f);
        }
    }

    /// @dev Gas-limited push that ignores return data; a failed push becomes an ethOwed credit.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        uint256 g = PUSH_GAS;
        assembly {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            ethOwed[to] += amount;
            totalEthOwed += amount;
            emit EthCredited(to, amount);
        }
    }

    function _withdraw(address payable to) internal {
        uint256 amount = ethOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        ethOwed[msg.sender] = 0;
        totalEthOwed -= amount;
        emit EthWithdrawn(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
