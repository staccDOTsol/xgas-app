// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Plasma mainnet (chain 9745). Reserve is USDT0, verified on
///         https://rpc.plasma.to: name "USDT0", symbol "USDT0", decimals 6.
///         Address published by the deploy request and matched on-chain.
library Plasma {
    uint256 internal constant CHAIN_ID = 9745;
    address internal constant USDT0 = 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb;
    /// @dev Circle's published Plasma USDC. Verified on https://rpc.plasma.to:
    ///      name USDC, symbol USDC, decimals 6.
    ///      https://developers.circle.com/stablecoins/usdc-contract-addresses
    address internal constant USDC = 0x2d661C89D812261039AF9764eceaAee884f5F67F;
    /// @dev Wrapped XPL from Plasma docs. Verified: name "Wrapped XPL", symbol WXPL, decimals 18.
    address internal constant WXPL = 0x6100E367285b01F48D07953803A2d8dCA5D19873;
    string internal constant RPC = "https://rpc.plasma.to";
}

/// @notice Tempo mainnet (chain 4217).
///         Reserve is OUSD, the stablecoin Tempo documents for holding and
///         settling: https://tempo.xyz/developers/docs/guide/ousd
///         address 0x20c0…874BE, name "OpenUSD", symbol "OUSD", decimals 6
///         (read back from https://rpc.tempo.xyz).
///         pathUSD (0x20C0…0000) is Bridge-issued routing liquidity and the
///         fallback fee token, not the asset the vault locks. See
///         https://tempo.xyz/developers/docs/protocol/exchange/quote-tokens
///         and https://tempo.xyz/developers/docs/protocol/fees/spec-fee.
library Tempo {
    uint256 internal constant CHAIN_ID = 4217;
    address internal constant OUSD = 0x20c0000000000000000000006a37DA5C996874BE;
    address internal constant PATH_USD = 0x20C0000000000000000000000000000000000000;
    string internal constant RPC = "https://rpc.tempo.xyz";

    /// @dev attodollars (1e-18 USD) per gas, divided by this, is a 6-decimal
    ///      stablecoin base unit. ceil(gasPrice * gasUsed / FEE_SCALE).
    uint256 internal constant FEE_SCALE = 1e12;
    /// @dev Fee-spec cap. Live base fee can sit at the floor (6e8).
    uint256 internal constant BASE_FEE_CAP_ATTO = 12_000_000_000;
}
