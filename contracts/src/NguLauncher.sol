// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {NguToken} from "./NguToken.sol";

/// @title NGU launcher: permissionless factory for fungible number-go-up tokens.
/// @notice Zero launch fee. Every launch, mint, and burn pays 0.01% burn + 0.01%
///         FanoutSink — the money is in the flow, not the launch toll.
///         Economics are immutable per token once launched.
contract NguLauncher {
    /// @notice Protocol fee sink for every NGU token (xGas FanoutSink).
    address public immutable fanoutSink;

    address[] public allTokens;
    mapping(address => bool) public isNguToken;

    event NguLaunched(
        address indexed token,
        address indexed creator,
        uint256 maxSupply,
        uint256 basePrice,
        uint16 stepBps,
        uint16 betaBps,
        uint256 seedQty,
        uint256 seedValue
    );

    error ZeroAddress();

    constructor(address fanoutSink_) {
        if (fanoutSink_ == address(0)) revert ZeroAddress();
        fanoutSink = fanoutSink_;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Permissionless. msg.value seeds the reserve behind `seedQty` creator
    ///         tokens (may be 0/0 for a cold start at basePrice).
    function launch(
        string calldata name,
        string calldata symbol,
        uint256 maxSupply,
        uint256 basePrice,
        uint16 stepBps,
        uint16 betaBps,
        uint256 seedQty
    ) external payable returns (address token) {
        token = address(
            new NguToken{value: msg.value}(
                name, symbol, fanoutSink, maxSupply, basePrice, stepBps, betaBps, seedQty, msg.sender
            )
        );
        allTokens.push(token);
        isNguToken[token] = true;
        emit NguLaunched(token, msg.sender, maxSupply, basePrice, stepBps, betaBps, seedQty, msg.value);
    }
}
