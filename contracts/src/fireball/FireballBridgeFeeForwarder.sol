// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFireballProtocolFanout {
    function ensureAsset(address token) external;
    function harvest(address token) external;
    function registeredCount() external view returns (uint64);
    function isAssetActive(address token) external view returns (bool);
}

/// @notice Receives xMoney released by an Orbit Outbox withdrawal and books it into
///         the Fireball product-fee ledger. Outbox token delivery has no ERC20 hook;
///         anyone must call forward() after the withdrawal has actually executed.
/// @dev This is deliberately a separate address from the fanout. It avoids booking
///      a bridge transfer before the challenge window or silently assigning direct
///      transfers to the wrong output cohort. The booking epoch is the forward tx.
contract FireballBridgeFeeForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable xMoney;
    IFireballProtocolFanout public immutable fanout;

    uint256 public totalForwarded;
    uint256 public totalCredited;

    event Forwarded(uint256 sent, uint256 credited);

    error BadAddress();
    error NoOutputs();
    error NothingToForward();
    error AssetInactive();

    constructor(address xMoney_, address fanout_) {
        if (xMoney_.code.length == 0 || fanout_.code.length == 0) revert BadAddress();
        xMoney = IERC20(xMoney_);
        fanout = IFireballProtocolFanout(fanout_);
    }

    function forward() external nonReentrant returns (uint256 sent, uint256 credited) {
        if (fanout.registeredCount() == 0) revert NoOutputs();
        sent = xMoney.balanceOf(address(this));
        if (sent == 0) revert NothingToForward();

        // Ensure before the transfer, so a previously unknown asset cannot be
        // retroactively assigned to the current cohort. Registration is idempotent.
        fanout.ensureAsset(address(xMoney));
        if (!fanout.isAssetActive(address(xMoney))) revert AssetInactive();

        uint256 beforeBalance = xMoney.balanceOf(address(fanout));
        xMoney.safeTransfer(address(fanout), sent);
        credited = xMoney.balanceOf(address(fanout)) - beforeBalance;
        fanout.harvest(address(xMoney));

        totalForwarded += sent;
        totalCredited += credited;
        emit Forwarded(sent, credited);
    }
}
