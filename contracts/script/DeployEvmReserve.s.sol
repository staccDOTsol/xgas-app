// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EvmReserveDeploy} from "../src/evm/EvmReserveDeploy.sol";

/**
 * @notice Deploys the ERC-20 $xMoney vault, fanout, buyback, and 24h timelock.
 *         The private key never enters this contract. Pass it only on the CLI
 *         (`--private-key` / `--account` / `--interactive`) when broadcasting.
 *
 *         Required env (addresses, not keys):
 *           DEPLOYER          sender. Must be the address of the CLI key.
 *           OWNER             sole timelock proposer and canceller.
 *           KEEPER            sole buyback executor.
 *           FANOUT_TREASURY   receives 1/3 of each fanout distribution.
 *
 *         `vm.deal` below funds the local simulation only. Forge does not broadcast it.
 */
abstract contract DeployEvmReserve is Script {
    error WrongChain(uint256 got, uint256 want);

    function chainId() internal pure virtual returns (uint256);
    function reserve() internal pure virtual returns (address);
    function chainName() internal pure virtual returns (string memory);

    function run() external {
        uint256 want = chainId();
        if (block.chainid != want) revert WrongChain(block.chainid, want);

        address deployer = vm.envAddress("DEPLOYER");
        address owner = vm.envAddress("OWNER");
        address keeper = vm.envAddress("KEEPER");
        address treasury = vm.envAddress("FANOUT_TREASURY");

        console.log("=== X MONEY ERC-20 RESERVE ===");
        console.log("Chain:", chainName());
        console.log("Chain id:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Owner (timelock proposer):", owner);
        console.log("Keeper:", keeper);
        console.log("Fanout treasury:", treasury);
        console.log("Reserve:", reserve());

        // Simulation only. Ignored on a real broadcast.
        vm.deal(deployer, 100 ether);

        vm.startBroadcast(deployer);
        EvmReserveDeploy.Result memory r =
            EvmReserveDeploy.deploy(IERC20(reserve()), deployer, owner, keeper, treasury);
        vm.stopBroadcast();

        console.log("Timelock:", address(r.timelock));
        console.log("Fanout:", address(r.fanout));
        console.log("Buyback:", address(r.buyback));
        console.log("Vault:", address(r.vault));
        console.log("Vault owner:", r.vault.owner());
        console.log("Reserve decimals:", r.vault.reserveDecimals());
        console.log("Scale factor:", r.vault.scaleFactor());
        console.log("Buyback owner:", r.buyback.owner());
        console.log("Fanout buyback:", r.fanout.buyback());
    }
}
