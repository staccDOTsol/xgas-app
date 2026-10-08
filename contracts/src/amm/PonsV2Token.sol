// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NguToken} from "../NguToken.sol";
import {GuardedERC20} from "./GuardedERC20.sol";
import {ReferenceFeeERC20} from "./ReferenceFeeERC20.sol";

import {IPoolManager} from "./v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "./v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "./v4-core/interfaces/IHooks.sol";
import {PoolKey} from "./v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "./v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "./v4-core/types/Currency.sol";
import {BalanceDelta} from "./v4-core/types/BalanceDelta.sol";
import {TickMath} from "./v4-core/libraries/TickMath.sol";
import {FullMath} from "./v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "./v4-core/libraries/FixedPoint96.sol";

/// @title PonsV2Token: NGU's monotone curve, then a permanent pool.
/// @notice Therig-proof by construction:
///           - no creator fee: curve fees go burn / FanoutSink / XGAS.DEV buyback (NguToken)
///           - monotone curve: a buy then a sell cannot move the price down, so walking the
///             curve is a donation to every holder (NguToken)
///           - curve-only transfers before graduation: no pool can exist on any AMM while
///             the curve is the oracle (GuardedERC20)
///           - graduation opens ONE pool on the canonical PoolManager at the curve's last
///             price, with the whole reserve, in a full-range position this contract holds
///             and has no function to remove
///           - after graduation every transfer is a reference counted per block and pays
///             10 bp * n^2 in kind, half to the sealed sink and half to the issuer's
///             beneficiary (ReferenceFeeERC20, the ERC-20 form of EIP-12384)
///
///         Graduation is permissionless once the curve sells out: `graduate()`. The curve
///         closes (buy / sell / donate revert), reserve goes to the pool, and the tokens the
///         pool needs at that price are minted to the position. Fees the position earns are
///         harvested by anyone: native to the FanoutSink, tokens to 0xdead.
contract PonsV2Token is NguToken, GuardedERC20, IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    int24 public tickLower;
    int24 public tickUpper;
    uint128 public liquidity;
    uint160 public graduationSqrtPriceX96;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 maxSupply;
        uint256 basePrice;
        uint16 stepBps;
        uint16 betaBps;
        uint256 seedQty;
        uint24 poolFee;
        int24 tickSpacing;
        /// destination of the issuer's half of every reference fee; zero = the sink
        address beneficiary;
    }

    event PoolOpened(PoolId indexed id, uint160 sqrtPriceX96, uint128 liquidity, uint256 xMoney, uint256 tokens);
    event Harvested(uint256 xMoneyToFanout, uint256 tokensBurned);

    error NotSoldOut();
    error CurveClosed();
    error NotPoolManager();
    error EmptyReserve();

    constructor(LaunchParams memory p, address creator_, IPoolManager poolManager_)
        payable
        NguToken(p.name, p.symbol, p.maxSupply, p.basePrice, p.stepBps, p.betaBps, p.seedQty, creator_)
        ReferenceFeeERC20(p.beneficiary)
    {
        if (address(poolManager_) == address(0) || p.tickSpacing <= 0) revert BadParams();
        poolManager = poolManager_;
        poolFee = p.poolFee;
        tickSpacing = p.tickSpacing;
    }

    receive() external payable override {
        if (msg.sender == address(poolManager)) return; // take() during harvest
        NguToken.donate();
    }

    // ───────────────────────── guard wiring ─────────────────────────

    /// @dev The curve is this contract: before graduation only mint and burn move tokens.
    function _curve() internal pure override returns (address) {
        return address(0);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, GuardedERC20) {
        GuardedERC20._update(from, to, value);
    }

    /// @dev The graduation deposit into the canonical pool is not a reference either:
    ///      it is the token moving its own reserve, once.
    function _counted(address from, address to) internal view override returns (bool) {
        if (from == address(this)) return false;
        return super._counted(from, to);
    }

    // ───────────────────────── curve, closed at graduation ─────────────────────────

    function buy(uint256 qty, address to) public payable override returns (uint256) {
        if (graduated) revert CurveClosed();
        return NguToken.buy(qty, to);
    }

    function sell(uint256 qty, address payable to, uint256 minOut) public override returns (uint256) {
        if (graduated) revert CurveClosed();
        return NguToken.sell(qty, to, minOut);
    }

    function donate() public payable override {
        if (graduated) revert CurveClosed();
        NguToken.donate();
    }

    // ───────────────────────── graduation ─────────────────────────

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(this)), poolFee, tickSpacing, IHooks(address(0)));
    }

    /// @notice Permissionless once the curve is sold out. Opens the canonical pool at the
    ///         curve's last price and moves the entire reserve into a permanent full-range
    ///         position owned by this contract.
    function graduate() external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        if (minted < maxSupply) revert NotSoldOut();
        uint256 r = reserve;
        if (r == 0) revert EmptyReserve();

        // price in the pool is token per xMoney: 1e18 / lastPrice, as a Q96 sqrt
        uint160 sqrtP = _sqrtPriceX96(lastPrice);
        tickLower = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        tickUpper = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);

        // liquidity the reserve can back on the xMoney side; tokens are minted to match
        uint256 l = FullMath.mulDiv(r, FullMath.mulDiv(sqrtP, sqrtUpper, FixedPoint96.Q96), sqrtUpper - sqrtP);
        if (l == 0 || l > type(uint128).max) revert BadParams();
        liquidity = uint128(l - 1); // one unit of slack for the pool's round-up
        graduationSqrtPriceX96 = sqrtP;

        reserve = 0;
        _graduate();

        PoolKey memory key = poolKey();
        poolManager.initialize(key, sqrtP);
        poolManager.unlock(abi.encode(uint8(0)));
    }

    /// @notice Collect the fees the permanent position earned: xMoney to the FanoutSink,
    ///         tokens to 0xdead. Anyone may call.
    function harvest() external nonReentrant {
        if (!graduated) revert NotSoldOut();
        poolManager.unlock(abi.encode(uint8(1)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint8 mode = abi.decode(data, (uint8));
        PoolKey memory key = poolKey();
        if (mode == 0) {
            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key, IPoolManager.ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(liquidity)), bytes32(0)), ""
            );
            uint256 owe0 = uint256(uint128(-delta.amount0()));
            uint256 owe1 = uint256(uint128(-delta.amount1()));
            // tokens: minted straight into the position
            _mint(address(this), owe1);
            poolManager.sync(key.currency1);
            _transfer(address(this), address(poolManager), owe1);
            poolManager.settle();
            // xMoney: the reserve
            poolManager.settle{value: owe0}();
            emit PoolOpened(key.toId(), graduationSqrtPriceX96, liquidity, owe0, owe1);
        } else {
            (, BalanceDelta fees) = poolManager.modifyLiquidity(
                key, IPoolManager.ModifyLiquidityParams(tickLower, tickUpper, 0, bytes32(0)), ""
            );
            uint256 f0 = uint256(uint128(fees.amount0()));
            uint256 f1 = uint256(uint128(fees.amount1()));
            if (f0 != 0) poolManager.take(key.currency0, fanoutSink, f0);
            if (f1 != 0) poolManager.take(key.currency1, DEAD, f1);
            emit Harvested(f0, f1);
        }
        return "";
    }

    /// @dev sqrt(1e18 / priceWeiPerToken) in Q96, clamped to the tick range.
    function _sqrtPriceX96(uint256 priceWeiPerToken) internal pure returns (uint160) {
        uint256 ratioX192 = FullMath.mulDiv(1e18, 1 << 192, priceWeiPerToken);
        uint256 s = _isqrt(ratioX192);
        if (s <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        if (s >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(s);
    }

    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
