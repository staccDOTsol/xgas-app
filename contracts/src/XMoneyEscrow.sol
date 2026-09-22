// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title XMoneyEscrow (xgas Orbit L4)
 * @notice Two-Sided P2P OTC Orderbook trading native $xMoney (the Orbit L4 gas token)
 *         against X Money USD fiat. ALL TRADES SETTLE IN NATIVE $xMoney (18 decimals).
 *
 *         1. SELL ASKS: Maker deposits $xMoney into escrow, buyer sends USD on X Money.
 *         2. BUY BIDS: Maker posts fiat bid, taker deposits $xMoney into escrow, maker sends USD on X Money.
 *
 *         On trade release:
 *         - 0.01% (1 bp) $xMoney burned permanently to 0x000...dEaD
 *         - 0.01% (1 bp) $xMoney sent to the FanoutSink, which bridges it to the Stacc Wizards Fee Fanout on Robinhood
 *         - 99.98% $xMoney delivered net to the buyer.
 */
contract XMoneyEscrow {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable FANOUT;

    constructor(address fanout_) {
        require(fanout_ != address(0), "fanout");
        FANOUT = fanout_;
    }

    uint256 public constant BURN_BPS = 1;        // 0.01%
    uint256 public constant FANOUT_RAKE_BPS = 1; // 0.01%
    uint256 public constant TRADE_TIMEOUT = 15 minutes;

    enum OrderSide { ASK, BID } // ASK = Selling xMoney for fiat, BID = Buying xMoney with fiat

    struct Order {
        address maker;
        string makerXHandle;
        OrderSide side;
        uint256 availableXMoney; // $xMoney held in escrow (ASK) or still wanted (BID), 18 decimals
        uint256 fiatRateBps;     // Price rate in bps (10000 = $1.00 USD per 1 xMoney)
        uint256 minAmount;       // Min xMoney per trade
        uint256 maxAmount;       // Max xMoney per trade
        bool active;
    }

    struct Trade {
        uint256 orderId;
        OrderSide side;
        address seller; // xMoney source
        string sellerXHandle;
        address buyer;  // xMoney recipient
        string buyerXHandle;
        uint256 xMoneyAmount;  // xMoney amount (18 decimals)
        uint256 expectedCents; // Expected payment on X Money in USD cents
        uint256 deadline;
        bool completed;
        bool cancelled;
    }

    uint256 public nextOrderId;
    uint256 public nextTradeId;
    uint256 public totalXMoneyBurned;
    uint256 public totalXMoneyRakedToFanout;
    uint256 public totalSettledVolumeXMoney;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => Trade) public trades;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        string makerXHandle,
        OrderSide side,
        uint256 xMoneyAmount,
        uint256 fiatRateBps,
        uint256 minAmount,
        uint256 maxAmount
    );

    event OrderCancelled(uint256 indexed orderId, uint256 refundedXMoney);

    event TradeInitiated(
        uint256 indexed tradeId,
        uint256 indexed orderId,
        OrderSide side,
        address seller,
        string sellerXHandle,
        address buyer,
        string buyerXHandle,
        uint256 xMoneyAmount,
        uint256 expectedCents,
        uint256 deadline
    );

    event TradeCompleted(
        uint256 indexed tradeId,
        uint256 indexed orderId,
        address indexed buyer,
        uint256 netXMoneyDelivered,
        uint256 xMoneyBurned,
        uint256 xMoneyRake
    );

    event TradeCancelled(
        uint256 indexed tradeId,
        uint256 indexed orderId,
        string reason
    );

    error InvalidAmount();
    error ValueMismatch();
    error OrderNotActive();
    error InsufficientOrderLiquidity();
    error Unauthorized();
    error TradeAlreadySettled();
    error TradeDeadlineNotPassed();
    error TransferFailed();

    /**
     * @notice 1. POST SELL ASK: Maker deposits native $xMoney to sell for X Money USD fiat.
     *         msg.value must equal xMoneyAmount.
     */
    function createSellAsk(
        string calldata makerXHandle,
        uint256 xMoneyAmount,
        uint256 fiatRateBps,
        uint256 minAmount,
        uint256 maxAmount
    ) external payable returns (uint256 orderId) {
        if (xMoneyAmount == 0 || minAmount == 0 || maxAmount < minAmount || xMoneyAmount < minAmount) {
            revert InvalidAmount();
        }
        if (msg.value != xMoneyAmount) revert ValueMismatch();

        orderId = nextOrderId++;
        orders[orderId] = Order({
            maker: msg.sender,
            makerXHandle: makerXHandle,
            side: OrderSide.ASK,
            availableXMoney: xMoneyAmount,
            fiatRateBps: fiatRateBps,
            minAmount: minAmount,
            maxAmount: maxAmount,
            active: true
        });

        emit OrderCreated(orderId, msg.sender, makerXHandle, OrderSide.ASK, xMoneyAmount, fiatRateBps, minAmount, maxAmount);
    }

    /**
     * @notice 2. POST BUY BID: Maker commits to buy native $xMoney with X Money USD fiat.
     */
    function createBuyBid(
        string calldata makerXHandle,
        uint256 maxXMoneyWanted,
        uint256 fiatRateBps,
        uint256 minAmount,
        uint256 maxAmount
    ) external returns (uint256 orderId) {
        if (maxXMoneyWanted == 0 || minAmount == 0 || maxAmount < minAmount || maxXMoneyWanted < minAmount) {
            revert InvalidAmount();
        }

        orderId = nextOrderId++;
        orders[orderId] = Order({
            maker: msg.sender,
            makerXHandle: makerXHandle,
            side: OrderSide.BID,
            availableXMoney: maxXMoneyWanted,
            fiatRateBps: fiatRateBps,
            minAmount: minAmount,
            maxAmount: maxAmount,
            active: true
        });

        emit OrderCreated(orderId, msg.sender, makerXHandle, OrderSide.BID, maxXMoneyWanted, fiatRateBps, minAmount, maxAmount);
    }

    /**
     * @notice 3. FILL SELL ASK (BUY xMoney): Buyer commits to buy $xMoney from maker's Sell Ask.
     */
    function fillSellAsk(
        uint256 orderId,
        uint256 xMoneyAmount,
        string calldata buyerXHandle
    ) external returns (uint256 tradeId) {
        Order storage order = orders[orderId];
        if (!order.active || order.side != OrderSide.ASK) revert OrderNotActive();
        if (xMoneyAmount < order.minAmount || xMoneyAmount > order.maxAmount || order.availableXMoney < xMoneyAmount) {
            revert InsufficientOrderLiquidity();
        }

        order.availableXMoney -= xMoneyAmount;
        if (order.availableXMoney < order.minAmount) order.active = false; // drained: nothing fillable remains
        uint256 expectedCents = _expectedCents(xMoneyAmount, order.fiatRateBps);
        tradeId = nextTradeId++;
        uint256 deadline = block.timestamp + TRADE_TIMEOUT;

        trades[tradeId] = Trade({
            orderId: orderId,
            side: OrderSide.ASK,
            seller: order.maker,
            sellerXHandle: order.makerXHandle,
            buyer: msg.sender,
            buyerXHandle: buyerXHandle,
            xMoneyAmount: xMoneyAmount,
            expectedCents: expectedCents,
            deadline: deadline,
            completed: false,
            cancelled: false
        });

        emit TradeInitiated(tradeId, orderId, OrderSide.ASK, order.maker, order.makerXHandle, msg.sender, buyerXHandle, xMoneyAmount, expectedCents, deadline);
    }

    /**
     * @notice 4. FILL BUY BID (SELL xMoney): Seller deposits native $xMoney into escrow to fill maker's Buy Bid.
     *         msg.value must equal xMoneyAmount.
     */
    function fillBuyBid(
        uint256 orderId,
        uint256 xMoneyAmount,
        string calldata sellerXHandle
    ) external payable returns (uint256 tradeId) {
        Order storage order = orders[orderId];
        if (!order.active || order.side != OrderSide.BID) revert OrderNotActive();
        if (xMoneyAmount < order.minAmount || xMoneyAmount > order.maxAmount || order.availableXMoney < xMoneyAmount) {
            revert InsufficientOrderLiquidity();
        }
        if (msg.value != xMoneyAmount) revert ValueMismatch();

        order.availableXMoney -= xMoneyAmount;
        if (order.availableXMoney < order.minAmount) order.active = false; // drained: nothing fillable remains
        uint256 expectedCents = _expectedCents(xMoneyAmount, order.fiatRateBps);
        tradeId = nextTradeId++;
        uint256 deadline = block.timestamp + TRADE_TIMEOUT;

        trades[tradeId] = Trade({
            orderId: orderId,
            side: OrderSide.BID,
            seller: msg.sender,
            sellerXHandle: sellerXHandle,
            buyer: order.maker,
            buyerXHandle: order.makerXHandle,
            xMoneyAmount: xMoneyAmount,
            expectedCents: expectedCents,
            deadline: deadline,
            completed: false,
            cancelled: false
        });

        emit TradeInitiated(tradeId, orderId, OrderSide.BID, msg.sender, sellerXHandle, order.maker, order.makerXHandle, xMoneyAmount, expectedCents, deadline);
    }

    /**
     * @notice 5. RELEASE TRADE: Seller verifies X Money fiat receipt and releases $xMoney.
     */
    function releaseTrade(uint256 tradeId) external {
        Trade storage trade = trades[tradeId];

        if (msg.sender != trade.seller) revert Unauthorized();
        if (trade.completed || trade.cancelled) revert TradeAlreadySettled();

        trade.completed = true;

        uint256 burnSkim = (trade.xMoneyAmount * BURN_BPS) / 10000;
        uint256 rakeSkim = (trade.xMoneyAmount * FANOUT_RAKE_BPS) / 10000;
        uint256 net = trade.xMoneyAmount - burnSkim - rakeSkim;

        totalXMoneyBurned += burnSkim;
        totalXMoneyRakedToFanout += rakeSkim;
        totalSettledVolumeXMoney += trade.xMoneyAmount;

        emit TradeCompleted(tradeId, trade.orderId, trade.buyer, net, burnSkim, rakeSkim);

        if (burnSkim > 0) _send(DEAD, burnSkim);
        if (rakeSkim > 0) _send(FANOUT, rakeSkim);
        _send(trade.buyer, net);
    }

    /**
     * @notice 6. TIMEOUT CANCEL: Seller reclaims $xMoney if buyer failed to send fiat on X Money.
     */
    function cancelTradeTimeout(uint256 tradeId) external {
        Trade storage trade = trades[tradeId];
        Order storage order = orders[trade.orderId];

        if (msg.sender != trade.seller) revert Unauthorized();
        if (block.timestamp <= trade.deadline) revert TradeDeadlineNotPassed();
        if (trade.completed || trade.cancelled) revert TradeAlreadySettled();

        trade.cancelled = true;

        emit TradeCancelled(tradeId, trade.orderId, "TIMEOUT_REFUNDED");

        if (trade.side == OrderSide.ASK) {
            order.availableXMoney += trade.xMoneyAmount;
        } else {
            _send(trade.seller, trade.xMoneyAmount);
        }
    }

    /**
     * @notice 7. CANCEL ORDER: Maker cancels active order and withdraws uncommitted $xMoney.
     */
    function cancelOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (msg.sender != order.maker) revert Unauthorized();
        // an order drained by fills is already inactive but may still hold funds (e.g. returned by a timed-out trade)
        if (!order.active && order.availableXMoney == 0) revert OrderNotActive();

        order.active = false;
        uint256 remaining = order.availableXMoney;
        order.availableXMoney = 0;

        emit OrderCancelled(orderId, remaining);

        if (order.side == OrderSide.ASK && remaining > 0) {
            _send(order.maker, remaining);
        }
    }

    function _expectedCents(uint256 xMoneyAmount, uint256 fiatRateBps) internal pure returns (uint256) {
        // xMoney has 18 decimals. cents = amount * rateBps / (1e18 * 100)
        return (xMoneyAmount * fiatRateBps) / (1e18 * 100);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
