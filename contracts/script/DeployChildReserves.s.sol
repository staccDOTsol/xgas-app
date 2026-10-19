// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XMoneyTimelock} from "../src/XMoneyTimelock.sol";
import {XMoneyMultiReserveVault} from "../src/evm/XMoneyMultiReserveVault.sol";
import {MultiReserveFanout} from "../src/evm/MultiReserveFanout.sol";
import {MultiReserveBuyback} from "../src/evm/MultiReserveBuyback.sol";

/// @notice Child-chain $xMoney backed by bridged USDT0 and USDC.
///         RESERVE_USDT0 and RESERVE_USDC are the L2 addresses from
///         L1ERC20Gateway.calculateL2TokenAddress, not the Plasma L1 addresses.
///         Simulate with `forge script` and no `--broadcast`.
contract DeployChildReserves is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        address owner = vm.envAddress("OWNER");
        address keeper = vm.envAddress("KEEPER");
        address treasury = vm.envAddress("FANOUT_TREASURY");

        IERC20[] memory reserves = new IERC20[](2);
        reserves[0] = IERC20(vm.envAddress("RESERVE_USDT0"));
        reserves[1] = IERC20(vm.envAddress("RESERVE_USDC"));

        vm.startBroadcast(deployer);
        MultiReserveFanout fanout = new MultiReserveFanout(treasury, deployer);
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        XMoneyTimelock timelock = new XMoneyTimelock(1 days, proposers, executors);
        XMoneyMultiReserveVault vault = new XMoneyMultiReserveVault(reserves, address(fanout), address(timelock));
        MultiReserveBuyback buyback = new MultiReserveBuyback(vault, address(timelock), keeper);
        fanout.setBuyback(address(buyback));
        vm.stopBroadcast();

        console.log("timelock", address(timelock));
        console.log("fanout", address(fanout));
        console.log("vault", address(vault));
        console.log("buyback", address(buyback));
    }
}
