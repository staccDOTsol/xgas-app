// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/PoolManager.sol";

/// @title DeployAmm: the tolled v4 PoolManager on the xGas L4 (chain 466302).
/// @notice env:
///           PRIVATE_KEY            deployer
///           AMM_OWNER              PoolManager owner (defaults to deployer); sets fee controller / per-pool protocol fee
///           AMM_FEE_COLLECTOR      protocolFeeController: the only address that can collectProtocolFees.
///                                  Point it at the xGas FanoutSink / buyback splitter so every toll feeds the flywheel.
///         run:
///           forge script script/DeployAmm.s.sol --rpc-url https://xgas.dev/rpc --broadcast
contract DeployAmm is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("AMM_OWNER", deployer);
        address collector = vm.envOr("AMM_FEE_COLLECTOR", address(0));

        vm.startBroadcast(pk);
        PoolManager pm = new PoolManager(owner);
        if (collector != address(0) && owner == deployer) {
            pm.setProtocolFeeController(collector);
        }
        vm.stopBroadcast();

        console.log("PoolManager (JitToll):", address(pm));
        console.log("  owner:", owner);
        console.log("  protocolFeeController:", collector);
        console.log("  toll floor (pips):", uint256(1000));
    }
}
