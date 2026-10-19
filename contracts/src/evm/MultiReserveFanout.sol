// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Rake sink for a child vault that holds more than one reserve.
///         `distribute` splits whichever reserve token is passed, 2/3 buyback and 1/3 treasury.
contract MultiReserveFanout {
    using SafeERC20 for IERC20;

    address public immutable treasury;
    address public immutable linker;
    address public buyback;

    uint256 public constant BUYBACK_NUM = 2;
    uint256 public constant BUYBACK_DEN = 3;

    event BuybackSet(address buyback);
    event Distributed(address indexed token, uint256 toBuyback, uint256 toTreasury);

    error ZeroAddress();
    error Unauthorized();
    error AlreadySet();
    error BuybackNotSet();

    constructor(address treasury_, address linker_) {
        if (treasury_ == address(0) || linker_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        linker = linker_;
    }

    function setBuyback(address buyback_) external {
        if (msg.sender != linker) revert Unauthorized();
        if (buyback != address(0)) revert AlreadySet();
        if (buyback_ == address(0)) revert ZeroAddress();
        buyback = buyback_;
        emit BuybackSet(buyback_);
    }

    function distribute(IERC20 token) external returns (uint256 toBuyback, uint256 toTreasury) {
        if (buyback == address(0)) revert BuybackNotSet();
        uint256 bal = token.balanceOf(address(this));
        toBuyback = (bal * BUYBACK_NUM) / BUYBACK_DEN;
        toTreasury = bal - toBuyback;
        if (toBuyback > 0) token.safeTransfer(buyback, toBuyback);
        if (toTreasury > 0) token.safeTransfer(treasury, toTreasury);
        emit Distributed(address(token), toBuyback, toTreasury);
    }
}
