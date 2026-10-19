// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {XMoneyTimelock} from "../src/XMoneyTimelock.sol";
import {XMoneyMultiReserveVault} from "../src/evm/XMoneyMultiReserveVault.sol";
import {MultiReserveFanout} from "../src/evm/MultiReserveFanout.sol";
import {MultiReserveBuyback} from "../src/evm/MultiReserveBuyback.sol";
import {UnitConfig} from "./UnitConfig.sol";

/// @notice Deploy the unit named by UNIT_CONFIG. The vault is the gas token.
///         Owner stays the deployer until WireUnitBridge transfers it to the
///         timelock, after the rollup inbox exists and is marked tax-exempt.
contract DeployUnit is Script {
    address internal deployer;
    address internal owner;
    address internal keeper;
    address internal treasury;
    XMoneyTimelock internal timelock;
    MultiReserveFanout internal fanout;
    XMoneyMultiReserveVault internal vault;
    MultiReserveBuyback internal buyback;

    function run() external {
        UnitConfig.Unit memory u = UnitConfig.parse(vm.readFile(vm.envString("UNIT_CONFIG")));
        deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == u.parentChainId, "parent chain");
        owner = vm.envOr("OWNER", deployer);
        keeper = vm.envOr("KEEPER", deployer);
        treasury = vm.envOr("FANOUT_TREASURY", deployer);
        _checkReserves(u);
        _broadcast(u);
        _write(u.id, u.name, u.symbol);
    }

    function _checkReserves(UnitConfig.Unit memory u) internal view {
        for (uint256 i = 0; i < u.reserves.length; i++) {
            UnitConfig.Reserve memory r = u.reserves[i];
            require(r.token.code.length > 0, "reserve has no code");
            uint8 d = IERC20Metadata(r.token).decimals();
            require(d == r.decimals, "reserve decimals");
            require(d <= 18, "reserve decimals");
        }
    }

    function _broadcast(UnitConfig.Unit memory u) internal {
        IERC20[] memory reserves = new IERC20[](u.reserves.length);
        for (uint256 i = 0; i < u.reserves.length; i++) {
            reserves[i] = IERC20(u.reserves[i].token);
        }
        vm.startBroadcast(deployer);
        fanout = new MultiReserveFanout(treasury, deployer);
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new XMoneyTimelock(1 days, proposers, executors);
        // Deployer owns the vault only long enough to exempt the inbox.
        vault = new XMoneyMultiReserveVault(u.name, u.symbol, reserves, address(fanout), deployer);
        buyback = new MultiReserveBuyback(vault, address(timelock), keeper);
        fanout.setBuyback(address(buyback));
        vm.stopBroadcast();
    }

    function _write(string memory id, string memory name_, string memory symbol_) internal {
        console.log("unit", id);
        console.log("symbol", symbol_);
        console.log("timelock", address(timelock));
        console.log("fanout", address(fanout));
        console.log("vault", address(vault));
        console.log("buyback", address(buyback));

        string memory obj = "unit";
        vm.serializeString(obj, "id", id);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "timelock", address(timelock));
        vm.serializeAddress(obj, "fanout", address(fanout));
        vm.serializeAddress(obj, "vault", address(vault));
        vm.serializeAddress(obj, "buyback", address(buyback));
        vm.serializeString(obj, "name", name_);
        string memory json = vm.serializeString(obj, "symbol", symbol_);
        vm.writeJson(json, string.concat("deployments/", id, ".json"));
    }
}
