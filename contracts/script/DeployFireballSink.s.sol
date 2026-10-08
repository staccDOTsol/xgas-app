// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

/// @notice Stages only the replacement fee sink on current xGas L4 (466302).
///         Foundry simulates without --broadcast. Verify FIREBALL_FANOUT_PARENT on
///         Robinhood Chain before a real deployment; an L4 contract cannot inspect it.
contract DeployFireballSink is Script {
    address internal constant OLD_8010 = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address internal constant OLD_10000 = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;

    function run() external returns (address sink) {
        require(block.chainid == 466302, "Current xGas L4 only");
        address parent = vm.envAddress("FIREBALL_FANOUT_PARENT");
        require(parent != address(0) && parent != OLD_8010 && parent != OLD_10000, "New Fireball parent required");

        sink = vm.envOr("FIREBALL_FANOUT_SINK", address(0));
        if (sink != address(0)) {
            require(sink.code.length > 0 && FanoutSink(payable(sink)).fanout() == parent, "Existing sink parent mismatch");
            console.log("Verified existing Fireball FanoutSink on L4:", sink);
            return sink;
        }

        vm.startBroadcast();
        sink = address(new FanoutSink(parent));
        vm.stopBroadcast();
        require(FanoutSink(payable(sink)).fanout() == parent, "Deployed sink parent mismatch");
        console.log("New Fireball FanoutSink on L4:", sink);
    }
}
