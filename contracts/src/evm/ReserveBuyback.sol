// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IXmoneyErc20Vault {
    function enter(uint256 amount, address recipient) external returns (uint256 minted);
}

/**
 * @title ReserveBuyback
 * @notice Holds reserve-token fees and, when the keeper calls `execute`, buys $xMoney
 *         from the vault and sends it to 0xdead. That pulls the tokens out of the
 *         circulating supply the vault's NAV uses, so r/s steps up. There is no
 *         withdraw, and there is no native-ETH leg: XgasDevBuyback's Uniswap v4
 *         path needs Robinhood pools and a native gas token, neither of which
 *         exists for this deploy.
 *
 *         The owner is the 24h timelock from the first transaction. The keeper
 *         is the only address that can execute.
 */
contract ReserveBuyback {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable reserve;
    address public immutable vault;
    address public owner;
    address public keeper;

    uint256 public totalReserveSpent;
    uint256 public totalXMoneyBurned;

    event Bought(uint256 reserveSpent, uint256 xMoneyBurned);
    event KeeperSet(address keeper);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error ZeroAddress();
    error Unauthorized();
    error NothingToBuy();
    error Slippage(uint256 out, uint256 minOut);

    constructor(IERC20 reserve_, address vault_, address owner_, address keeper_) {
        if (address(reserve_) == address(0) || vault_ == address(0) || owner_ == address(0) || keeper_ == address(0)) {
            revert ZeroAddress();
        }
        reserve = reserve_;
        vault = vault_;
        owner = owner_;
        keeper = keeper_;
        reserve.forceApprove(vault_, type(uint256).max);
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
    }

    /// @param minMinted Revert unless the vault mints at least this much $xMoney. Pass 0 to accept any fill.
    function execute(uint256 minMinted) external returns (uint256 minted) {
        if (msg.sender != keeper) revert Unauthorized();
        uint256 bal = reserve.balanceOf(address(this));
        if (bal == 0) revert NothingToBuy();
        minted = IXmoneyErc20Vault(vault).enter(bal, address(this));
        if (minted < minMinted) revert Slippage(minted, minMinted);
        IERC20(vault).safeTransfer(DEAD, minted);
        totalReserveSpent += bal;
        totalXMoneyBurned += minted;
        emit Bought(bal, minted);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
