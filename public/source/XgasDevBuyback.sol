// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Uniswap v4 PoolManager, only the calls a two-hop exact-in swap needs.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact in
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IXMoneyVault is IERC20 {
    function exitRollup(uint256 xMoneyAmount) external returns (uint256 usdgOut);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title XgasDevBuyback — the XGAS.DEV flywheel on Robinhood Chain
 * @notice Every xgas fee path sends 0.02% here. On the L4 that fee is native $xMoney, collected by a
 *         FanoutSink whose parent-chain destination is this contract; the Outbox releases it here as the
 *         xMoney ERC-20. `execute` redeems that xMoney for USDG at the vault's r/s, swaps USDG -> ETH -> XGAS.DEV
 *         through two Uniswap v4 pools in one unlock, and burns every XGAS.DEV it bought.
 *
 *         There is no withdraw. Anything that lands here (xMoney, USDG, ETH) can only leave as a buy of
 *         XGAS.DEV that is then burned.
 *
 *         Only the keeper calls `execute`, with a minimum out it computed from a simulation just before.
 *         A permissionless trigger would let anyone pump the pool, trigger the buy at the top and sell into it.
 *         The owner (the xMoney 24h timelock) can replace the keeper or re-point the pools if liquidity moves.
 */
contract XgasDevBuyback {
    using SafeERC20 for IERC20;

    IPoolManager public constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IXMoneyVault public constant XMONEY = IXMoneyVault(0xa924C725B64cC346f275269EFA4Bd0538cfBa97E);
    IERC20 public constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address public constant XGAS_DEV = 0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3;
    address internal constant NATIVE = address(0);

    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    address public owner;
    address public keeper;
    /// @notice ETH / USDG pool (currency0 = native ETH, currency1 = USDG).
    PoolKey public usdgPool;
    /// @notice ETH / XGAS.DEV pool (currency0 = native ETH, currency1 = XGAS.DEV).
    PoolKey public xgasPool;

    uint256 public totalXMoneyRedeemed;
    uint256 public totalUsdgSpent;
    uint256 public totalEthSpent;
    uint256 public totalXgasBurned;

    event BuybackBurned(uint256 xMoneyRedeemed, uint256 usdgSpent, uint256 ethSpent, uint256 xgasBurned);
    event KeeperSet(address keeper);
    event PoolsSet(PoolKey usdgPool, PoolKey xgasPool);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error NothingToBuy();
    error Slippage(uint256 out, uint256 minOut);
    error BadPool();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address owner_, address keeper_, PoolKey memory usdgPool_, PoolKey memory xgasPool_) {
        owner = owner_;
        keeper = keeper_;
        _setPools(usdgPool_, xgasPool_);
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- the flywheel

    /// @notice Redeem any xMoney for USDG, buy XGAS.DEV with all USDG and ETH held, burn it.
    /// @param minXgasOut Revert unless at least this much XGAS.DEV is bought (keeper simulates first).
    function execute(uint256 minXgasOut) external returns (uint256 burned) {
        if (msg.sender != keeper) revert Unauthorized();

        uint256 xMoney = XMONEY.balanceOf(address(this));
        if (xMoney > 0) {
            XMONEY.exitRollup(xMoney);
            totalXMoneyRedeemed += xMoney;
        }

        uint256 usdg = USDG.balanceOf(address(this));
        uint256 eth = address(this).balance;
        if (usdg == 0 && eth == 0) revert NothingToBuy();

        (uint256 usdgSpent, uint256 ethSpent, uint256 xgasOut) =
            abi.decode(POOL_MANAGER.unlock(abi.encode(usdg, eth)), (uint256, uint256, uint256));
        if (xgasOut < minXgasOut) revert Slippage(xgasOut, minXgasOut);

        IBurnable(XGAS_DEV).burn(xgasOut);
        totalUsdgSpent += usdgSpent;
        totalEthSpent += ethSpent;
        totalXgasBurned += xgasOut;
        emit BuybackBurned(xMoney, usdgSpent, ethSpent, xgasOut);
        return xgasOut;
    }

    /// @dev USDG -> ETH in `usdgPool`, then (that ETH + ETH held) -> XGAS.DEV in `xgasPool`, settled net.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert Unauthorized();
        (uint256 usdgIn, uint256 ethHeld) = abi.decode(data, (uint256, uint256));

        uint256 usdgOwed;
        uint256 ethFromUsdg;
        if (usdgIn > 0) {
            // oneForZero: pay USDG (currency1), receive ETH (currency0)
            (int128 d0, int128 d1) = _split(
                POOL_MANAGER.swap(usdgPool, SwapParams(false, -int256(usdgIn), MAX_SQRT_PRICE_LIMIT), "")
            );
            ethFromUsdg = uint256(int256(d0));
            usdgOwed = uint256(-int256(d1));
        }

        uint256 ethIn = ethFromUsdg + ethHeld;
        uint256 ethOwed;
        uint256 xgasOut;
        if (ethIn > 0) {
            // zeroForOne: pay ETH (currency0), receive XGAS.DEV (currency1)
            (int128 d0, int128 d1) = _split(
                POOL_MANAGER.swap(xgasPool, SwapParams(true, -int256(ethIn), MIN_SQRT_PRICE_LIMIT), "")
            );
            ethOwed = uint256(-int256(d0));
            xgasOut = uint256(int256(d1));
        }

        if (usdgOwed > 0) {
            POOL_MANAGER.sync(address(USDG));
            USDG.safeTransfer(address(POOL_MANAGER), usdgOwed);
            POOL_MANAGER.settle();
        }
        // ETH nets out: we are owed ethFromUsdg by hop 1 and owe ethOwed to hop 2.
        uint256 ethSpent;
        if (ethOwed > ethFromUsdg) {
            ethSpent = ethOwed - ethFromUsdg;
            POOL_MANAGER.settle{value: ethSpent}();
        } else if (ethFromUsdg > ethOwed) {
            POOL_MANAGER.take(NATIVE, address(this), ethFromUsdg - ethOwed); // partial fill on hop 2
        }
        if (xgasOut > 0) POOL_MANAGER.take(XGAS_DEV, address(this), xgasOut);

        return abi.encode(usdgOwed, ethSpent, xgasOut);
    }

    // ---------------------------------------------------------------- admin (behind the 24h timelock)

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setPools(PoolKey calldata usdgPool_, PoolKey calldata xgasPool_) external onlyOwner {
        _setPools(usdgPool_, xgasPool_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _setPools(PoolKey memory usdgPool_, PoolKey memory xgasPool_) internal {
        if (usdgPool_.currency0 != NATIVE || usdgPool_.currency1 != address(USDG)) revert BadPool();
        if (xgasPool_.currency0 != NATIVE || xgasPool_.currency1 != XGAS_DEV) revert BadPool();
        usdgPool = usdgPool_;
        xgasPool = xgasPool_;
        emit PoolsSet(usdgPool_, xgasPool_);
    }

    function _split(int256 delta) internal pure returns (int128 amount0, int128 amount1) {
        amount0 = int128(delta >> 128);
        amount1 = int128(delta);
    }
}
