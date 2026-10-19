// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {XMoneyMultiReserveVault} from "./XMoneyMultiReserveVault.sol";

/// @notice Keeper turns a reserve rake into $xMoney and sends that $xMoney to 0xdead.
contract MultiReserveBuyback {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    XMoneyMultiReserveVault public immutable vault;
    address public owner;
    address public keeper;

    event Bought(address indexed reserve, uint256 reserveSpent, uint256 xMoneyBurned);
    event KeeperSet(address keeper);

    error ZeroAddress();
    error Unauthorized();
    error NothingToBuy();
    error NotReserve(address token);
    error Slippage(uint256 out, uint256 minOut);

    constructor(XMoneyMultiReserveVault vault_, address owner_, address keeper_) {
        if (address(vault_) == address(0) || owner_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        vault = vault_;
        owner = owner_;
        keeper = keeper_;
        uint256 n = vault_.reserveCount();
        for (uint256 i = 0; i < n; i++) {
            IERC20(vault_.reserves(i)).forceApprove(address(vault_), type(uint256).max);
        }
        emit KeeperSet(keeper_);
    }

    function execute(IERC20 reserve, uint256 minMinted) external returns (uint256 minted) {
        if (msg.sender != keeper) revert Unauthorized();
        if (!vault.isReserve(address(reserve))) revert NotReserve(address(reserve));
        uint256 bal = reserve.balanceOf(address(this));
        if (bal == 0) revert NothingToBuy();
        minted = vault.enter(reserve, bal, address(this));
        if (minted < minMinted) revert Slippage(minted, minMinted);
        IERC20(address(vault)).safeTransfer(DEAD, minted);
        emit Bought(address(reserve), bal, minted);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }
}
