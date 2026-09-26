// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FanoutSink} from "../src/FanoutSink.sol";
import {XMoneyEscrow} from "../src/XMoneyEscrow.sol";
import {XGasRouter} from "../src/XGasRouter.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";
import {NguLauncher} from "../src/NguLauncher.sol";

/**
 * @notice xgas Orbit L4 (#466301) deployment. Two sinks go first, both plain FanoutSinks that withdraw to Robinhood:
 *           - the Fanout sink (0.01% of every fee path) -> Stacc Wizards Fee Fanout (`FANOUT_PARENT`)
 *           - the buyback sink (0.02% of every fee path) -> XgasDevBuyback (`XGAS_BUYBACK`), which buys + burns XGAS.DEV
 *         Set FANOUT_SINK / BUYBACK_SINK to reuse existing sinks instead of deploying new ones.
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
        address buyback = vm.envOr("BUYBACK_SINK", address(0));
        if (buyback == address(0)) {
            buyback = address(new FanoutSink(vm.envAddress("XGAS_BUYBACK")));
            console.log("0b. Buyback FanoutSink (L4) deployed at:", buyback);
        } else {
            console.log("0b. Buyback FanoutSink (L4) reused at:", buyback);
        }
        XMoneyEscrow escrow = new XMoneyEscrow(sink, buyback);
        console.log("1. XMoneyEscrow (L4) deployed at:", address(escrow));
        FomoAttritionL4 fomo = new FomoAttritionL4(sink, buyback);
        console.log("2. FomoAttritionL4 (L4) deployed at:", address(fomo));
        XGasRouter router = new XGasRouter(payable(sink), payable(buyback));
        console.log("3. XGasRouter (L4) deployed at:", address(router));
        NguLauncher launcher = new NguLauncher(sink, buyback);
        console.log("4. NguLauncher (L4) deployed at:", address(launcher));
        vm.stopBroadcast();
    }
}
