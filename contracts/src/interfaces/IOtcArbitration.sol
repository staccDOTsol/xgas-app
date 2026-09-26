// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Result of an OTC dispute, shared by RobinhoodEthOtc and OtcArbitration.
///         ABI-encoded as uint8: 0 None, 1 BuyerPaid, 2 BuyerDidNotPay, 3 LongStop.
///         LongStop (value 3, formerly Split): no quorum within LONG_STOP of the dispute opening. The escrow
///         returns the ETH to the seller (to the Sell order unless the maker cancelled it), the bond goes back
///         to the seller and the buyer is not flagged. Nothing is ever split.
enum Outcome {
    None,
    BuyerPaid,
    BuyerDidNotPay,
    LongStop
}

/// @notice The slice of OtcArbitration that RobinhoodEthOtc and the deploy script call.
interface IOtcArbitration {
    /// @dev Only the bound escrow. msg.value is the seller's dispute bond (exactly bondFor(ethAmount));
    ///      the commit phase starts now.
    function openDispute(uint256 tradeId, address buyer, address seller) external payable;

    /// @dev Deployer only, exactly once.
    function bind(address escrow) external;

    function escrow() external view returns (address);
}

/// @notice The callback OtcArbitration makes into the escrow once a dispute is resolved.
interface IOtcEscrowCallback {
    function onDisputeResolved(uint256 tradeId, Outcome outcome) external;
}
