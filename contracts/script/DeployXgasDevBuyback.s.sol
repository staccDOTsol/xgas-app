// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {XgasDevBuyback, PoolKey} from "../src/XgasDevBuyback.sol";

/**
 * @notice Robinhood Chain (#4663). Owner is the xMoney 24h timelock; the keeper is the host's Outbox executor key
 *         (KEEPER). Pools: the deepest ETH/USDG v4 pool and the XGAS.DEV graduation pool (0x33c7e7e6…5bc1).
 */
contract DeployXgasDevBuyback is Script {
    address constant TIMELOCK = 0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant XGAS_DEV = 0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3;

    function run() external {
        PoolKey memory usdgPool = PoolKey(address(0), USDG, 0x800000, 10, 0x06a889870C8f83640D6816319f72e2aA579b6080);
        PoolKey memory xgasPool = PoolKey(address(0), XGAS_DEV, 0, 200, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);
        vm.startBroadcast();
        XgasDevBuyback bb = new XgasDevBuyback(TIMELOCK, vm.envAddress("KEEPER"), usdgPool, xgasPool);
        vm.stopBroadcast();
        console.log("XgasDevBuyback (Robinhood) deployed at:", address(bb));
    }
}
