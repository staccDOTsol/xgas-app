// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {RobinhoodEthOtcFireball, IFireballFeeBooking} from "../src/fireball/RobinhoodEthOtcFireball.sol";

/// @notice A separate desk and arbitration for new orders. Each step is one
///         transaction. Old orders, disputes, stakes and claims stay on the old
///         contracts. New arbitration needs a three-day arbiter stake warm-up.
contract DeployRobinhoodOtcFireball is Script {
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant FANOUT = 0x0a87Da84277232720e0908CC7470e3A7f925748f;

    function run() external returns (address deployed) {
        require(block.chainid == 4663, "Robinhood only");
        require(WETH.code.length > 0 && FANOUT.code.length > 0, "fee path code missing");
        IFireballFeeBooking f = IFireballFeeBooking(FANOUT);
        require(f.registeredCount() > 0 && f.isAssetActive(WETH), "Fireball WETH track inactive");

        string memory step = vm.envString("FIREBALL_OTC_STEP");
        address expected = vm.envAddress("EXPECTED_DEPLOYER");
        require(expected != address(0), "expected deployer required");

        if (_eq(step, "arbitration")) {
            vm.startBroadcast(expected);
            deployed = address(new OtcArbitration());
            vm.stopBroadcast();
            require(OtcArbitration(deployed).deployer() == expected, "wrong deployer");
            console.log("Fireball OTC arbitration:", deployed);
            return deployed;
        }

        address arb = vm.envAddress("FIREBALL_OTC_ARBITRATION");
        require(arb.code.length > 0, "arbitration missing");
        require(OtcArbitration(arb).deployer() == expected, "wrong arbitration deployer");
        if (_eq(step, "escrow")) {
            require(OtcArbitration(arb).escrow() == address(0), "arbitration already bound");
            vm.startBroadcast(expected);
            deployed = address(new RobinhoodEthOtcFireball(WETH, FANOUT, arb));
            vm.stopBroadcast();
            require(RobinhoodEthOtcFireball(deployed).arbitration() == arb, "wrong arbitration");
            require(RobinhoodEthOtcFireball(deployed).feeFanout() == FANOUT, "wrong fanout");
            console.log("Fireball OTC escrow:", deployed);
            return deployed;
        }

        require(_eq(step, "bind"), "step must be arbitration/escrow/bind");
        address escrow = vm.envAddress("FIREBALL_OTC_ESCROW");
        require(escrow.code.length > 0, "escrow missing");
        require(RobinhoodEthOtcFireball(escrow).arbitration() == arb, "wrong escrow arbitration");
        require(RobinhoodEthOtcFireball(escrow).feeFanout() == FANOUT, "wrong escrow fanout");
        require(OtcArbitration(arb).escrow() == address(0), "already bound");
        vm.startBroadcast(expected);
        OtcArbitration(arb).bind(escrow);
        vm.stopBroadcast();
        require(OtcArbitration(arb).escrow() == escrow, "bind failed");
        deployed = escrow;
        console.log("Bound Fireball OTC escrow:", escrow);
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
