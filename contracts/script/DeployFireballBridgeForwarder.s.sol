// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FireballBridgeFeeForwarder, IFireballProtocolFanout} from "../src/fireball/FireballBridgeFeeForwarder.sol";

/// @notice Parent-chain half of a new L4 fee route. Simulation is the default;
///         a broadcast must be coordinated with the signer owner. The forwarder
///         address becomes the destination of a new L4 FanoutSink only after the
///         xMoney asset is active on the new fanout.
contract DeployFireballBridgeForwarder is Script {
    address internal constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address internal constant NEW_FANOUT = 0x0a87Da84277232720e0908CC7470e3A7f925748f;

    function run() external returns (address forwarder) {
        require(block.chainid == 4663, "Robinhood only");
        uint256 signerKey = vm.envUint("PRIVATE_KEY");
        require(vm.addr(signerKey) == vm.envAddress("EXPECTED_DEPLOYER"), "signer mismatch");
        require(XMONEY.code.length > 0 && NEW_FANOUT.code.length > 0, "missing live code");
        IFireballProtocolFanout fanout = IFireballProtocolFanout(NEW_FANOUT);
        require(fanout.registeredCount() > 0, "no Fireball outputs");
        // Asset registration must be completed and reviewed before the first
        // Outbox execution. A preexisting unregistered balance is quarantined.
        require(fanout.isAssetActive(XMONEY), "xMoney asset not active");

        forwarder = vm.envOr("FIREBALL_BRIDGE_FORWARDER", address(0));
        if (forwarder != address(0)) {
            require(forwarder.code.length > 0, "forwarder code missing");
            FireballBridgeFeeForwarder existing = FireballBridgeFeeForwarder(forwarder);
            require(address(existing.xMoney()) == XMONEY, "wrong xMoney");
            require(address(existing.fanout()) == NEW_FANOUT, "wrong fanout");
            console.log("Verified Fireball bridge forwarder:", forwarder);
            return forwarder;
        }

        vm.startBroadcast(signerKey);
        forwarder = address(new FireballBridgeFeeForwarder(XMONEY, NEW_FANOUT));
        vm.stopBroadcast();
        require(address(FireballBridgeFeeForwarder(forwarder).fanout()) == NEW_FANOUT, "wrong fanout");
        console.log("New Fireball bridge forwarder:", forwarder);
    }
}
