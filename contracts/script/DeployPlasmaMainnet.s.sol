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

        IERC20[] memory reserves = _reserves();

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
        vm.serializeAddress(obj, "usdc", Plasma.USDC);
        string memory reserveList;
        for (uint256 i = 0; i < reserves.length; i++) {
            reserveList = string.concat(reserveList, i == 0 ? "" : ",", vm.toString(address(reserves[i])));
        }
        string memory json = vm.serializeString(obj, "reserves", reserveList);
        vm.writeJson(json, "deployments/plasma-vault.json");
    }

    /// @dev RESERVE_TOKENS is a comma-separated list of USD stables, each valued at $1.
    ///      Default is Plasma USDT0 and Circle USDC.
    function _reserves() internal view returns (IERC20[] memory list) {
        string memory raw = vm.envOr("RESERVE_TOKENS", string(""));
        if (bytes(raw).length == 0) {
            list = new IERC20[](2);
            list[0] = IERC20(Plasma.USDT0);
            list[1] = IERC20(Plasma.USDC);
            return list;
        }
        bytes memory b = bytes(raw);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") n++;
        }
        list = new IERC20[](n);
        uint256 idx;
        uint256 start;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                list[idx++] = IERC20(vm.parseAddress(_slice(b, start, i)));
                start = i + 1;
            }
        }
    }

    function _slice(bytes memory b, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = b[i];
        }
        return string(out);
    }
}
