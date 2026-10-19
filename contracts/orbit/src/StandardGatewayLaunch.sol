// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {L1ERC20Gateway} from "token-bridge/tokenbridge/ethereum/gateway/L1ERC20Gateway.sol";
import {L1GatewayRouter} from "token-bridge/tokenbridge/ethereum/gateway/L1GatewayRouter.sol";
import {ClonableBeaconProxy} from "token-bridge/tokenbridge/libraries/ClonableBeaconProxy.sol";

/// @notice Standard ETH-rollup ERC-20 gateway (payable retryables).
///         Not L1OrbitERC20Gateway: that one pays fees in a custom gas token
///         and reverts when msg.value != 0.
contract StandardGatewayLaunch {
    struct Result {
        L1ERC20Gateway gateway;
        L1GatewayRouter router;
        bytes32 cloneableProxyHash;
    }

    function deploy(
        address inbox,
        address l2Gateway,
        address l2Router,
        address l2BeaconProxyFactory,
        address owner
    ) external returns (Result memory r) {
        r.gateway = new L1ERC20Gateway();
        r.router = new L1GatewayRouter();
        r.cloneableProxyHash = keccak256(type(ClonableBeaconProxy).creationCode);
        r.gateway.initialize(l2Gateway, address(r.router), inbox, r.cloneableProxyHash, l2BeaconProxyFactory);
        // default gateway is set here, so deposits do not need a separate
        // setGateways retryable. The L2 router is told later, on the child.
        r.router.initialize(owner, address(r.gateway), address(0), l2Router, inbox);
    }
}
