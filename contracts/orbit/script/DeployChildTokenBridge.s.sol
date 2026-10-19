// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlasmaChild} from "../src/PlasmaChild.sol";
import {L2ERC20Gateway} from "token-bridge/tokenbridge/arbitrum/gateway/L2ERC20Gateway.sol";
import {L2GatewayRouter} from "token-bridge/tokenbridge/arbitrum/gateway/L2GatewayRouter.sol";
import {StandardArbERC20} from "token-bridge/tokenbridge/arbitrum/StandardArbERC20.sol";
import {BeaconProxyFactory} from "token-bridge/tokenbridge/libraries/ClonableBeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @notice First transactions of CHILD_DEPLOYER on the child chain.
///         Nonces 0..4 must match the addresses baked into the Plasma
///         L1ERC20Gateway at launch. Run this against the child RPC after
///         the sequencer is up and this key has XPL on the child. Do not
///         point it at Plasma.
contract DeployChildTokenBridge is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == PlasmaChild.CHAIN_ID, "not the plasma child");
        address l1Gateway = vm.envAddress("L1_GATEWAY");
        address l1Router = vm.envAddress("L1_ROUTER");

        vm.startBroadcast(deployer);
        L2ERC20Gateway gateway = new L2ERC20Gateway();
        L2GatewayRouter router = new L2GatewayRouter();
        StandardArbERC20 impl = new StandardArbERC20();
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl));
        BeaconProxyFactory factory = new BeaconProxyFactory();

        factory.initialize(address(beacon));
        gateway.initialize(l1Gateway, address(router), address(factory));
        router.initialize(l1Router, address(gateway));
        vm.stopBroadcast();

        require(address(gateway) == vm.computeCreateAddress(deployer, PlasmaChild.CHILD_GATEWAY_NONCE), "gateway nonce");
        require(address(router) == vm.computeCreateAddress(deployer, PlasmaChild.CHILD_ROUTER_NONCE), "router nonce");
        require(address(impl) == vm.computeCreateAddress(deployer, PlasmaChild.CHILD_TOKEN_IMPL_NONCE), "impl nonce");
        require(address(beacon) == vm.computeCreateAddress(deployer, PlasmaChild.CHILD_BEACON_NONCE), "beacon nonce");
        require(address(factory) == vm.computeCreateAddress(deployer, PlasmaChild.CHILD_FACTORY_NONCE), "factory nonce");

        console.log("l2 gateway", address(gateway));
        console.log("l2 router", address(router));
        console.log("l2 token impl", address(impl));
        console.log("l2 beacon", address(beacon));
        console.log("l2 factory", address(factory));
    }
}
