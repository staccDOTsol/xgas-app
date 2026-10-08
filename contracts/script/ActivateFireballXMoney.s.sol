// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFireballProtocolFanout} from "../src/fireball/FireballBridgeFeeForwarder.sol";

interface IFireballAssetHistory {
    function totalDeposited(address token) external view returns (uint256);
}

/// @notice Register xMoney before its first bridge delivery, while its fanout balance is zero.
contract ActivateFireballXMoney is Script {
    address internal constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address internal constant FANOUT = 0x0a87Da84277232720e0908CC7470e3A7f925748f;

    function run() external {
        require(block.chainid == 4663, "Robinhood only");
        uint256 signerKey = vm.envUint("PRIVATE_KEY");
        require(vm.addr(signerKey) == vm.envAddress("EXPECTED_DEPLOYER"), "signer mismatch");
        require(XMONEY.code.length > 0 && FANOUT.code.length > 0, "missing live code");
        IFireballProtocolFanout fanout = IFireballProtocolFanout(FANOUT);
        require(fanout.registeredCount() > 0, "no Fireball outputs");
        require(IERC20(XMONEY).balanceOf(FANOUT) == 0, "reconcile preexisting xMoney");
        require(IFireballAssetHistory(FANOUT).totalDeposited(XMONEY) == 0, "reconcile xMoney history");
        require(!fanout.isAssetActive(XMONEY), "xMoney already active");

        vm.startBroadcast(signerKey);
        fanout.ensureAsset(XMONEY);
        vm.stopBroadcast();
        require(fanout.isAssetActive(XMONEY), "xMoney registration failed");
        console.log("Fireball xMoney asset active:", XMONEY);
    }
}
