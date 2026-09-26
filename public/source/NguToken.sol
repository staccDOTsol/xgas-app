// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NGU token: fungible number-go-up on xGas.
/// @notice Port of Staccpad's NguCollection curve (nft-range/src/ngu) to ERC-20,
///         denominated in native $xMoney. The collection is its own market.
///
///         price(next) = max(lastPrice * (1 + step), floor / beta)
///         floor       = reserve / supply
///         buy         mints `qty` whole tokens; 0.01% of each unit price is burned,
///                     0.01% goes to the FanoutSink, 0.02% to the XGAS.DEV buyback sink,
///                     the rest backs the floor.
///         sell        burns `qty` whole tokens; redeems 99.96% of min(floor, lastPrice)
///                     per token. 0.01% burned, 0.01% FanoutSink, 0.02% buyback sink.
///
///         Both the mint price and the floor are monotone: the contract reverts rather
///         than let either drop (FloorWouldDrop). 1 token = 1e18 base units = 1 curve step.
///         Whole tokens only on the curve; fractions trade on secondary markets.
///
///         Warp note: bridging locks tokens in a Hyperlane collateral escrow. Locked
///         tokens remain in totalSupply, the reserve doesn't move, so the floor doesn't
///         move. A bridge is a transfer into escrow, not an economic event.
/// @dev The launcher that deploys every NguToken; each token reads its fee sinks from it once, at construction.
interface INguSinks {
    function fanoutSink() external view returns (address);
    function buybackSink() external view returns (address);
}

contract NguToken is ERC20, ReentrancyGuard {
    /// @notice 0.01% of every mint/burn payment sent to 0xdead (1 bp).
    uint16 public constant BURN_BPS = 1;
    /// @notice 0.01% of every mint/burn payment sent to the FanoutSink (1 bp).
    uint16 public constant FANOUT_BPS = 1;
    /// @notice 0.02% of every mint/burn payment sent to the buyback sink, which bridges it to
    ///         XgasDevBuyback on Robinhood to buy and burn XGAS.DEV (2 bp).
    uint16 public constant BUYBACK_BPS = 2;
    uint16 public constant MAX_STEP_BPS = 5000;
    uint16 public constant MIN_BETA_BPS = 5000;
    uint16 public constant MAX_BETA_BPS = 9500;
    uint16 public constant MAX_PER_TX = 50;
    uint256 public constant UNIT = 1e18;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint8 public constant TICK_BUY = 0;
    uint8 public constant TICK_SELL = 1;
    uint8 public constant TICK_DONATE = 2;

    address public immutable launcher;
    address public immutable fanoutSink;
    address public immutable buybackSink;
    /// @notice Max whole tokens ever mintable.
    uint256 public immutable maxSupply;
    uint256 public immutable basePrice;
    uint16 public immutable stepBps;
    /// @notice Floor protection in bps: buy price >= floor / (betaBps/10000).
    ///         9000 = the redemption floor never sits below 90% of the buy price.
    uint16 public immutable betaBps;
    /// @notice Genesis tokens minted to the creator, backed by the launch payment.
    uint256 public immutable seedQty;

    /// @notice $xMoney backing every outstanding token. Only moves by the rules above.
    uint256 public reserve;
    /// @notice Whole tokens outstanding (minted minus burned).
    uint256 public supply;
    /// @notice Whole tokens ever minted (the curve's n). Counts against maxSupply.
    uint256 public minted;
    /// @notice Curve anchor: the last price a buyer paid (or base price at genesis).
    uint256 public lastPrice;

    event Tick(
        uint8 indexed kind,
        address indexed who,
        uint256 qty,
        uint256 price,
        uint256 floor,
        uint256 supply,
        uint256 reserve,
        uint256 minted
    );

    error BadParams();
    error SoldOut();
    error Underpaid();
    error Slippage();
    error FloorWouldDrop();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        uint256 basePrice_,
        uint16 stepBps_,
        uint16 betaBps_,
        uint256 seedQty_,
        address creator_
    ) payable ERC20(name_, symbol_) {
        if (
            maxSupply_ == 0 || basePrice_ == 0 || stepBps_ > MAX_STEP_BPS || betaBps_ < MIN_BETA_BPS
                || betaBps_ > MAX_BETA_BPS || seedQty_ > maxSupply_ || creator_ == address(0)
        ) revert BadParams();
        launcher = msg.sender;
        address fanoutSink_ = INguSinks(msg.sender).fanoutSink();
        address buybackSink_ = INguSinks(msg.sender).buybackSink();
        if (fanoutSink_ == address(0) || buybackSink_ == address(0)) revert BadParams();
        fanoutSink = fanoutSink_;
        buybackSink = buybackSink_;
        maxSupply = maxSupply_;
        basePrice = basePrice_;
        stepBps = stepBps_;
        betaBps = betaBps_;
        seedQty = seedQty_;
        lastPrice = basePrice_;

        // Genesis: creator's own $xMoney backs their seed tokens. No fee, no curve step.
        reserve = msg.value;
        for (uint256 i; i < seedQty_; i++) {
            _mint(creator_, UNIT);
        }
        supply = seedQty_;
        minted = seedQty_;
        emit Tick(TICK_DONATE, creator_, seedQty_, lastPrice, floor(), supply, reserve, minted);
    }

    // views

    /// @notice $xMoney redeemable per whole token right now.
    function floor() public view returns (uint256) {
        return supply == 0 ? 0 : reserve / supply;
    }

    /// @notice Price of the next whole token. Never lower than the last one paid.
    function nextPrice() public view returns (uint256) {
        return _next(reserve, supply, lastPrice, minted);
    }

    function _next(uint256 r, uint256 s, uint256 last, uint256 n) internal view returns (uint256) {
        if (n == 0) return basePrice;
        uint256 p1 = (last * (10_000 + uint256(stepBps))) / 10_000;
        if (s == 0) return p1;
        // floor / beta, with beta as a fraction: betaBps=9000 -> price >= floor / 0.9.
        uint256 p2 = (r * 10_000) / (uint256(betaBps) * s);
        return p1 > p2 ? p1 : p2;
    }

    /// @notice Total $xMoney for `qty` sequential whole-token buys from current state.
    function quoteBuy(uint256 qty) external view returns (uint256 cost) {
        uint256 r = reserve;
        uint256 s = supply;
        uint256 last = lastPrice;
        uint256 n = minted;
        for (uint256 q; q < qty; q++) {
            uint256 p = _next(r, s, last, n);
            cost += p;
            r += p - _fees(p);
            s++;
            n++;
            last = p;
        }
    }

    /// @notice $xMoney a holder receives for burning `qty` whole tokens now.
    /// @dev Matches `sell` exactly: per-unit, per-leg rounding (see `_fees`).
    function quoteSell(uint256 qty) external view returns (uint256 payout) {
        uint256 r = reserve;
        uint256 s = supply;
        for (uint256 q; q < qty && s > 0; q++) {
            uint256 b = _sellBase(r, s);
            payout += b - _fees(b);
            r -= b;
            s--;
        }
    }

    /// @dev Redemption basis: floor, capped at the last paid price so a fresh buy can
    ///      never be flipped back for more than it cost (matters after donations lift
    ///      the floor above the last price).
    function _sellBase(uint256 r, uint256 s) internal view returns (uint256) {
        uint256 f = r / s;
        return f > lastPrice ? lastPrice : f;
    }

    /// @notice Worst case for a buyer who sells straight back, in bps of what they paid.
    function maxLossBps() external view returns (uint256) {
        // sell returns (1 - 0.04%) of min(floor, price); floor >= beta * price once beta binds.
        uint256 recover = (uint256(betaBps) * (10_000 - BURN_BPS - FANOUT_BPS - BUYBACK_BPS)) / 10_000;
        return 10_000 - recover;
    }

    // buy / sell

    /// @notice Mint `qty` whole tokens on the curve to `to`. Overpayment is refunded.
    function buy(uint256 qty, address to) external payable nonReentrant returns (uint256 cost) {
        if (qty == 0 || qty > MAX_PER_TX) revert BadParams();
        if (minted + qty > maxSupply) revert SoldOut();
        if (to == address(0)) to = msg.sender;
        uint256 floorBefore = floor();
        uint256 burn;
        uint256 rake;
        uint256 buyback;
        for (uint256 q; q < qty; q++) {
            uint256 p = _next(reserve, supply, lastPrice, minted);
            cost += p;
            uint256 b = (p * BURN_BPS) / 10_000;
            uint256 r = (p * FANOUT_BPS) / 10_000;
            uint256 bb = (p * BUYBACK_BPS) / 10_000;
            burn += b;
            rake += r;
            buyback += bb;
            reserve += p - b - r - bb;
            supply++;
            lastPrice = p;
            _mint(to, UNIT);
            minted++;
        }
        if (msg.value < cost) revert Underpaid();
        if (floor() < floorBefore) revert FloorWouldDrop();
        emit Tick(TICK_BUY, to, qty, lastPrice, floor(), supply, reserve, minted);
        _toDead(burn);
        _fanout(rake);
        _send(buybackSink, buyback);
        if (msg.value > cost) _send(msg.sender, msg.value - cost);
    }

    /// @notice Burn `qty` whole tokens and redeem $xMoney from the reserve at
    ///         99.96% of min(floor, lastPrice) per token. Never touches the curve.
    function sell(uint256 qty, address payable to, uint256 minOut)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (qty == 0 || qty > MAX_PER_TX) revert BadParams();
        if (to == address(0)) to = payable(msg.sender);
        uint256 floorBefore = floor();
        uint256 burn;
        uint256 rake;
        uint256 buyback;
        for (uint256 q; q < qty && supply > 0; q++) {
            uint256 b = _sellBase(reserve, supply);
            uint256 bd = (b * BURN_BPS) / 10_000;
            uint256 r = (b * FANOUT_BPS) / 10_000;
            uint256 bb = (b * BUYBACK_BPS) / 10_000;
            payout += b - bd - r - bb;
            burn += bd;
            rake += r;
            buyback += bb;
            reserve -= b;
            supply--;
            _burn(msg.sender, UNIT);
        }
        if (payout == 0) revert BadParams();
        if (payout < minOut) revert Slippage();
        if (supply > 0 && floor() < floorBefore) revert FloorWouldDrop();
        emit Tick(TICK_SELL, msg.sender, qty, nextPrice(), floor(), supply, reserve, minted);
        _toDead(burn);
        _fanout(rake);
        _send(buybackSink, buyback);
        _send(to, payout);
    }

    /// @notice Any $xMoney sent here raises the floor for every holder. No tokens minted.
    function donate() external payable {
        reserve += msg.value;
        emit Tick(TICK_DONATE, msg.sender, 0, lastPrice, floor(), supply, reserve, minted);
    }

    receive() external payable {
        reserve += msg.value;
        emit Tick(TICK_DONATE, msg.sender, 0, lastPrice, floor(), supply, reserve, minted);
    }

    /// @dev Burn + Fanout + buyback on a payment, rounded per leg exactly as buy/sell do.
    function _fees(uint256 amount) internal pure returns (uint256) {
        return (amount * BURN_BPS) / 10_000 + (amount * FANOUT_BPS) / 10_000 + (amount * BUYBACK_BPS) / 10_000;
    }

    function _toDead(uint256 amount) internal {
        if (amount == 0) return;
        _send(DEAD, amount);
    }

    function _fanout(uint256 amount) internal {
        if (amount == 0) return;
        _send(fanoutSink, amount);
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send");
    }
}
