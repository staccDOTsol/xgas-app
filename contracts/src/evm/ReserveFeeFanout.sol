// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ReserveFeeFanout
 * @notice ERC-20 rake sink for Plasma and Tempo. The vault sends the 1 bp reserve
 *         rake here. `distribute` forwards 2/3 to the buyback and 1/3 to `treasury`,
 *         the same 2:1 split as the L4's 0.02% buyback and 0.01% fanout sinks.
 *
 *         No native balance. FanoutSink's ArbSys.withdrawEth path is not used.
 */
contract ReserveFeeFanout {
    using SafeERC20 for IERC20;

    IERC20 public immutable reserve;
    address public immutable treasury;
    /// @notice Deployer key that may call `setBuyback` once. Powerless afterwards.
    address public immutable linker;
    address public buyback;

    uint256 public constant BUYBACK_NUM = 2;
    uint256 public constant BUYBACK_DEN = 3;

    uint256 public totalDistributed;

    event BuybackSet(address buyback);
    event Distributed(uint256 toBuyback, uint256 toTreasury);

    error ZeroAddress();
    error Unauthorized();
    error AlreadySet();
    error BuybackNotSet();

    constructor(IERC20 reserve_, address treasury_, address linker_) {
        if (address(reserve_) == address(0) || treasury_ == address(0) || linker_ == address(0)) revert ZeroAddress();
        reserve = reserve_;
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

    function pending() external view returns (uint256) {
        return reserve.balanceOf(address(this));
    }

    /// @notice Anyone can split the reserve token currently held.
    function distribute() external returns (uint256 toBuyback, uint256 toTreasury) {
        if (buyback == address(0)) revert BuybackNotSet();
        uint256 bal = reserve.balanceOf(address(this));
        toBuyback = (bal * BUYBACK_NUM) / BUYBACK_DEN;
        toTreasury = bal - toBuyback;
        if (toBuyback > 0) reserve.safeTransfer(buyback, toBuyback);
        if (toTreasury > 0) reserve.safeTransfer(treasury, toTreasury);
        totalDistributed += toBuyback + toTreasury;
        emit Distributed(toBuyback, toTreasury);
    }
}
