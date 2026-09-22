// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Owner of the XMoney vault/gas token. Every admin change (bridge addresses, retryable gas
///         params) must be queued here and waits `minDelay` before anyone can execute it.
contract XMoneyTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0)) {}
}
