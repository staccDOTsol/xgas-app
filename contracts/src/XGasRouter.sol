// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title XGasRouter
 * @notice L4 Native Gas Value Router.
 *         On every native transaction with value:
 *         - 0.01% (1 bp) is burned permanently to 0x000...dEaD
 *         - 0.01% (1 bp) protocol rake is sent to Stacc Wizards / Homecoming Fee Fanout on Robinhood Chain
 *         - 0.02% (2 bp) goes to the buyback sink, which bridges it to XgasDevBuyback on Robinhood (buys + burns XGAS.DEV)
 *         - 99.96% is delivered net to the recipient.
 *         Plain transfers with no calldata revert, so no value can be stranded here.
 */
contract XGasRouter {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address payable public immutable FANOUT;
    address payable public immutable BUYBACK;

    constructor(address payable fanout_, address payable buyback_) {
        if (fanout_ == address(0) || buyback_ == address(0)) revert ZeroAddress();
        FANOUT = fanout_;
        BUYBACK = buyback_;
    }

    uint256 public constant BURN_BPS = 1;        // 0.01%
    uint256 public constant FANOUT_RAKE_BPS = 1; // 0.01%
    uint256 public constant BUYBACK_BPS = 2;     // 0.02%

    uint256 public totalNativeBurned;
    uint256 public totalFanoutRaked;
    uint256 public totalBuyback;
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
    error UseSendValue();

    function sendValue(address payable to, string calldata memo) external payable returns (uint256 netAmount, uint256 burnAmount, uint256 rakeAmount, uint256 buybackAmount) {
        if (msg.value == 0) revert NoValueProvided();
        if (to == address(0)) revert ZeroAddress();

        burnAmount = (msg.value * BURN_BPS) / 10000;
        rakeAmount = (msg.value * FANOUT_RAKE_BPS) / 10000;
        buybackAmount = (msg.value * BUYBACK_BPS) / 10000;
        netAmount = msg.value - burnAmount - rakeAmount - buybackAmount;

        totalNativeBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalBuyback += buybackAmount;
        totalNativeRouted += msg.value;

        emit ValueTransferred(msg.sender, to, netAmount, burnAmount, rakeAmount, memo); // buyback = 2x burnAmount

        if (burnAmount > 0) {
            (bool burnOk, ) = DEAD.call{value: burnAmount}("");
            if (!burnOk) revert TransferFailed();
        }

        if (rakeAmount > 0) {
            (bool rakeOk, ) = FANOUT.call{value: rakeAmount}("");
            if (!rakeOk) revert TransferFailed();
        }

        if (buybackAmount > 0) {
            (bool buybackOk, ) = BUYBACK.call{value: buybackAmount}("");
            if (!buybackOk) revert TransferFailed();
        }

        (bool sendOk, ) = to.call{value: netAmount}("");
        if (!sendOk) revert TransferFailed();
    }

    /// @notice Plain transfers are refused. The old receive() skimmed the fees and then kept the
    ///         other 99.96% with no way out; value only moves through sendValue, to a named recipient.
    receive() external payable {
        revert UseSendValue();
    }
}
