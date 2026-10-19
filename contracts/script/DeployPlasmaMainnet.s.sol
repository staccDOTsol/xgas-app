// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Plasma} from "../src/evm/EvmChains.sol";
import {XMoneyTimelock} from "../src/XMoneyTimelock.sol";
import {XMoneyMultiReserveVault} from "../src/evm/XMoneyMultiReserveVault.sol";
import {MultiReserveFanout} from "../src/evm/MultiReserveFanout.sol";
import {MultiReserveBuyback} from "../src/evm/MultiReserveBuyback.sol";

/// @notice Plasma mainnet xMoney vault. Reserves are USDT0 and Circle USDC
///         on Plasma itself. The child-chain vault (bridged reserves) cannot
///         be deployed here: those L2 tokens have no code until a deposit
///         lands on a running child. See DeployChildReserves.s.sol.
contract DeployPlasmaMainnet is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == Plasma.CHAIN_ID, "not plasma");
        require(Plasma.USDT0.code.length > 0 && Plasma.USDC.code.length > 0, "reserve missing");

        address owner = vm.envOr("OWNER", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address treasury = vm.envOr("FANOUT_TREASURY", deployer);

        IERC20[] memory reserves = new IERC20[](2);
        reserves[0] = IERC20(Plasma.USDT0);
        reserves[1] = IERC20(Plasma.USDC);

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

        string memory obj = "plasma-vault";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "owner", owner);
        vm.serializeAddress(obj, "keeper", keeper);
        vm.serializeAddress(obj, "treasury", treasury);
        vm.serializeAddress(obj, "timelock", address(timelock));
        vm.serializeAddress(obj, "fanout", address(fanout));
        vm.serializeAddress(obj, "vault", address(vault));
        vm.serializeAddress(obj, "buyback", address(buyback));
        vm.serializeAddress(obj, "usdt0", Plasma.USDT0);
        string memory json = vm.serializeAddress(obj, "usdc", Plasma.USDC);
        vm.writeJson(json, "deployments/plasma-vault.json");
    }
}
