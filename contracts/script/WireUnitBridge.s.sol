// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {XMoneyMultiReserveVault} from "../src/evm/XMoneyMultiReserveVault.sol";

/// @notice Mark the rollup inbox and bridge as tax-exempt, then hand the
///         vault to the timelock. Bridge transfers of the gas token must not
///         burn, or the inbox escrows less than it asks the bridge to pull.
contract WireUnitBridge is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        XMoneyMultiReserveVault vault = XMoneyMultiReserveVault(vm.envAddress("VAULT"));
        address inbox = vm.envAddress("INBOX");
        address bridge = vm.envAddress("BRIDGE");
        address timelock = vm.envAddress("TIMELOCK");
        require(vault.owner() == deployer, "vault owner");

        vm.startBroadcast(deployer);
        vault.setBridgeSystem(inbox, bridge);
        vault.transferOwnership(timelock);
        vm.stopBroadcast();

        require(vault.owner() == timelock, "timelock");
        require(vault.isBridgeSystem(inbox) && vault.isBridgeSystem(bridge), "bridge exempt");
        console.log("vault owner", vault.owner());
        console.log("inbox exempt", inbox);
        console.log("bridge exempt", bridge);
    }
}
