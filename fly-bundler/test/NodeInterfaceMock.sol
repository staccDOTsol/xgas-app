// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// Stand-in for Nitro's NodeInterface (0x...C8) on an anvil fork, where Nitro's virtual contracts do not exist.
/// Alto's arbitrum chain type calls gasEstimateL1Component for preVerificationGas and for the bundle gas limit.
/// Calibrated against the live 466302 node on 2026-09-26 (random calldata, L2 base fee 0.1 gwei,
/// ArbGasInfo L1 base fee estimate 84 gwei): 500 B -> 9.6M, 1000 B -> 17.1M, 2000 B -> 32.0M gas.
contract NodeInterfaceMock {
    function gasEstimateL1Component(address, bool, bytes calldata data)
        external
        payable
        returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)
    {
        gasEstimateForL1 = uint64(2_000_000 + 15_000 * data.length);
        baseFee = block.basefee;
        l1BaseFeeEstimate = 84 gwei;
    }
}
