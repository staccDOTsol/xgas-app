// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {XMoneyUSD} from "../src/XMoneyUSD.sol";

/**
 * @notice L3 (Robinhood Chain #4663) deployment: the USDG vault / bridge inbox only.
 *         Escrow, War of Attrition and the value router live on the xgas Orbit L4
 *         (see DeployOrbitL4.s.sol; the app server auto-deploys them at boot).
 */
contract DeployXMoneyStack is Script {
    function run() external {
        uint256 deployerPrivateKey;
        try vm.envUint("DEPLOYER_PRIVATE_KEY") returns (uint256 k) {
            deployerPrivateKey = k;
        } catch {
            string memory rawKey = vm.envString("DEPLOYER_PRIVATE_KEY");
            if (bytes(rawKey).length == 64) {
                deployerPrivateKey = vm.parseUint(string.concat("0x", rawKey));
            } else {
                deployerPrivateKey = vm.parseUint(rawKey);
            }
        }

        address deployer = vm.addr(deployerPrivateKey);
        console.log("=== DEPLOYING X MONEY L3 VAULT ===");
        console.log("Deployer Address:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);
        XMoneyUSD xUsd = new XMoneyUSD();
        console.log("XMoneyUSD (Vault) deployed at:", address(xUsd));
        vm.stopBroadcast();
    }
}
