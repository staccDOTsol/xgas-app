// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FanoutSink} from "../src/FanoutSink.sol";
import {XMoneyEscrow} from "../src/XMoneyEscrow.sol";
import {XGasRouter} from "../src/XGasRouter.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";

/**
 * @notice xgas Orbit L4 (#466301) deployment. The sink goes first: every rake on this chain lands there and
 *         is bridged to the Stacc Wizards Fee Fanout on Robinhood (`FANOUT_PARENT`, the 8010-share fanout).
 *         Set FANOUT_SINK to reuse an existing sink instead of deploying a new one.
 */
contract DeployOrbitL4 is Script {
    address constant FANOUT_PARENT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;

    function run() external {
        vm.startBroadcast();
        address sink = vm.envOr("FANOUT_SINK", address(0));
        if (sink == address(0)) {
            sink = address(new FanoutSink(FANOUT_PARENT));
            console.log("0. FanoutSink (L4) deployed at:", sink);
        } else {
            console.log("0. FanoutSink (L4) reused at:", sink);
        }
        XMoneyEscrow escrow = new XMoneyEscrow(sink);
        console.log("1. XMoneyEscrow (L4) deployed at:", address(escrow));
        FomoAttritionL4 fomo = new FomoAttritionL4(sink);
        console.log("2. FomoAttritionL4 (L4) deployed at:", address(fomo));
        XGasRouter router = new XGasRouter(payable(sink));
        console.log("3. XGasRouter (L4) deployed at:", address(router));
        vm.stopBroadcast();
    }
}
