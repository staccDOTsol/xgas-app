// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PonsV2Token} from "./PonsV2Token.sol";
import {IPoolManager} from "./v4-core/interfaces/IPoolManager.sol";

/// @title PonsV2 launcher: permissionless factory for therig-proof curve tokens.
/// @notice Same economics as NguLauncher (zero launch fee, fees in the flow), plus the
///         canonical PoolManager every token graduates into. Immutable per launch.
contract PonsV2Launcher {
    address public immutable fanoutSink;
    address public immutable buybackSink;
    IPoolManager public immutable poolManager;

    address[] public allTokens;
    mapping(address => bool) public isPonsToken;

    event PonsLaunched(address indexed token, address indexed creator, uint256 seedValue, PonsV2Token.LaunchParams p);

    error ZeroAddress();

    constructor(address fanoutSink_, address buybackSink_, IPoolManager poolManager_) {
        if (fanoutSink_ == address(0) || buybackSink_ == address(0) || address(poolManager_) == address(0)) {
            revert ZeroAddress();
        }
        fanoutSink = fanoutSink_;
        buybackSink = buybackSink_;
        poolManager = poolManager_;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Permissionless. msg.value seeds the reserve behind `p.seedQty` creator tokens.
    ///         p.poolFee / p.tickSpacing describe the canonical pool; the PoolManager toll is on top.
    function launch(PonsV2Token.LaunchParams calldata p) external payable returns (address token) {
        token = address(new PonsV2Token{value: msg.value}(p, msg.sender, poolManager));
        allTokens.push(token);
        isPonsToken[token] = true;
        emit PonsLaunched(token, msg.sender, msg.value, p);
    }
}
