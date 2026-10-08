// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FanoutSink} from "../src/FanoutSink.sol";
import {XMoneyEscrow} from "../src/XMoneyEscrow.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";
import {XGasRouter} from "../src/XGasRouter.sol";
import {NguLauncher} from "../src/NguLauncher.sol";

/// @notice Deploy each Fireball successor in a separate transaction, preserving
///         every historical escrow, FOMO round and NGU token on its old address.
///         No frontend or server route is switched by this script.
contract DeployOrbitL4Fireball is Script {
    function run() external returns (address deployed) {
        require(block.chainid == 466302, "current xGas Orbit only");
        uint256 signerKey = vm.envUint("PRIVATE_KEY");
        require(vm.addr(signerKey) == vm.envAddress("EXPECTED_DEPLOYER"), "signer mismatch");
        string memory step = vm.envString("FIREBALL_L4_STEP");
        address forwarder = vm.envAddress("FIREBALL_FORWARDER_PARENT");
        address buyback = vm.envAddress("BUYBACK_SINK");
        require(forwarder != address(0), "forwarder required");
        require(buyback.code.length > 0, "buyback sink missing");

        if (_eq(step, "sink")) {
            vm.startBroadcast(signerKey);
            deployed = address(new FanoutSink(forwarder));
            vm.stopBroadcast();
            require(FanoutSink(payable(deployed)).fanout() == forwarder, "sink parent mismatch");
            console.log("Fireball L4 sink:", deployed);
            return deployed;
        }

        address sink = vm.envAddress("FIREBALL_L4_SINK");
        require(sink.code.length > 0, "new sink missing");
        require(FanoutSink(payable(sink)).fanout() == forwarder, "new sink parent mismatch");
        require(sink != buyback, "sinks must differ");

        vm.startBroadcast(signerKey);
        if (_eq(step, "escrow")) deployed = address(new XMoneyEscrow(sink, buyback));
        else if (_eq(step, "fomo")) deployed = address(new FomoAttritionL4(sink, buyback));
        else if (_eq(step, "router")) deployed = address(new XGasRouter(payable(sink), payable(buyback)));
        else if (_eq(step, "ngu")) deployed = address(new NguLauncher(sink, buyback));
        else revert("step must be sink/escrow/fomo/router/ngu");
        vm.stopBroadcast();
        console.log("Fireball L4 successor:", deployed);
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
