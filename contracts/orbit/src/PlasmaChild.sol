// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Addresses for an XPL-native Orbit child of Plasma mainnet.
///         Chain id 974502 is provisional and not registered anywhere.
///         USDC is Circle's published Plasma address:
///         https://developers.circle.com/stablecoins/usdc-contract-addresses
///         Verified on https://rpc.plasma.to (name USDC, symbol USDC, decimals 6).
///         USDT0 and WXPL were read from the same RPC (USDT0 decimals 6;
///         WXPL name "Wrapped XPL", symbol WXPL, decimals 18, `deposit()` accepts XPL).
library PlasmaChild {
    uint256 internal constant PARENT_CHAIN_ID = 9745;
    uint256 internal constant CHAIN_ID = 974502;

    address internal constant USDT0 = 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb;
    address internal constant USDC = 0x2d661C89D812261039AF9764eceaAee884f5F67F;
    address internal constant WXPL = 0x6100E367285b01F48D07953803A2d8dCA5D19873;

    /// @dev Fixed counterparts used by the fork test, which never deploys the
    ///      L2 contracts. The mainnet script does not use these. It predicts
    ///      the child addresses from `CHILD_DEPLOYER`'s nonce, and
    ///      DeployChildTokenBridge.s.sol has to be that deployer's first
    ///      transactions on the child. Withdrawals check
    ///      `outbox.l2ToL1Sender()` against whichever address the L1 gateway
    ///      was initialized with.
    address internal constant L2_ERC20_GATEWAY = 0xC0fFeE0000000000000000000000000000000974;
    address internal constant L2_GATEWAY_ROUTER = 0xc0fFEe0000000000000000000000000000000975;
    address internal constant L2_BEACON_PROXY_FACTORY = 0xC0FFEe0000000000000000000000000000000976;

    /// @dev CREATE nonces of DeployChildTokenBridge, in order.
    uint64 internal constant CHILD_GATEWAY_NONCE = 0;
    uint64 internal constant CHILD_ROUTER_NONCE = 1;
    uint64 internal constant CHILD_TOKEN_IMPL_NONCE = 2;
    uint64 internal constant CHILD_BEACON_NONCE = 3;
    uint64 internal constant CHILD_FACTORY_NONCE = 4;

    uint256 internal constant MAX_DATA_SIZE = 117_964;
    string internal constant PARENT_RPC = "https://rpc.plasma.to";

    /// @dev Production confirmation window, same order of magnitude as 466302
    ///      (50400 parent blocks). The fork test uses 1 so it can confirm
    ///      without waiting. AnyTrust fast confirmer stays unset.
    uint64 internal constant CONFIRM_PERIOD_BLOCKS = 50_400;
}
