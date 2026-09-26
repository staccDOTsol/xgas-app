// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// One Outcome enum for both contracts (ABI-encoded as uint8: 0 None, 1 BuyerPaid, 2 BuyerDidNotPay, 3 LongStop).
import {Outcome} from "./IOtcArbitration.sol";

/// @notice The single escrow hook OtcArbitration calls when a dispute is final.
interface IRobinhoodEthOtc {
    function onDisputeResolved(uint256 tradeId, Outcome outcome) external;
}
