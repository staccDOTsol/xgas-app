// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title XGasRouter
 * @notice L4 Native Gas Value Router.
 *         On every native transaction with value:
 *         - 0.01% (1 bp) is burned permanently to 0x000...dEaD
 *         - 0.01% (1 bp) protocol rake is sent to Stacc Wizards / Homecoming Fee Fanout on Robinhood Chain
 *         - 99.98% is delivered net to the recipient.
 */
contract XGasRouter {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address payable public immutable FANOUT;

    constructor(address payable fanout_) {
        if (fanout_ == address(0)) revert ZeroAddress();
        FANOUT = fanout_;
    }

    uint256 public constant BURN_BPS = 1;        // 0.01%
    uint256 public constant FANOUT_RAKE_BPS = 1; // 0.01%

    uint256 public totalNativeBurned;
    uint256 public totalFanoutRaked;
    uint256 public totalNativeRouted;

    event ValueTransferred(
        address indexed from,
        address indexed to,
        uint256 netAmount,
        uint256 burnAmount,
        uint256 rakeAmount,
        string memo
    );

    error NoValueProvided();
    error ZeroAddress();
    error TransferFailed();

    function sendValue(address payable to, string calldata memo) external payable returns (uint256 netAmount, uint256 burnAmount, uint256 rakeAmount) {
        if (msg.value == 0) revert NoValueProvided();
        if (to == address(0)) revert ZeroAddress();

        burnAmount = (msg.value * BURN_BPS) / 10000;
        rakeAmount = (msg.value * FANOUT_RAKE_BPS) / 10000;
        netAmount = msg.value - burnAmount - rakeAmount;

        totalNativeBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalNativeRouted += msg.value;

        emit ValueTransferred(msg.sender, to, netAmount, burnAmount, rakeAmount, memo);

        if (burnAmount > 0) {
            (bool burnOk, ) = DEAD.call{value: burnAmount}("");
            if (!burnOk) revert TransferFailed();
        }

        if (rakeAmount > 0) {
            (bool rakeOk, ) = FANOUT.call{value: rakeAmount}("");
            if (!rakeOk) revert TransferFailed();
        }

        (bool sendOk, ) = to.call{value: netAmount}("");
        if (!sendOk) revert TransferFailed();
    }

    receive() external payable {
        uint256 burnAmount = (msg.value * BURN_BPS) / 10000;
        uint256 rakeAmount = (msg.value * FANOUT_RAKE_BPS) / 10000;

        totalNativeBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalNativeRouted += msg.value;

        if (burnAmount > 0) {
            (bool burnOk, ) = DEAD.call{value: burnAmount}("");
            require(burnOk, "Burn failed");
        }
        if (rakeAmount > 0) {
            (bool rakeOk, ) = FANOUT.call{value: rakeAmount}("");
            require(rakeOk, "Rake failed");
        }
    }
}
