// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlasmaChild} from "../src/PlasmaChild.sol";
import {EthRollupLaunch} from "../src/EthRollupLaunch.sol";
import {StandardGatewayLaunch} from "../src/StandardGatewayLaunch.sol";

/// @notice One-shot launch against whatever RPC this script is pointed at.
///         `forge script` without `--broadcast` simulates on a fork and sends nothing.
///         Do not pass `--broadcast` until the keys, the license review, and the
///         child-chain L2 gateway addresses are settled.
contract LaunchPlasmaChild is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        address owner = vm.envAddress("ROLLUP_OWNER");
        address validator = vm.envAddress("VALIDATOR");
        address poster = vm.envAddress("BATCH_POSTER");
        address posterManager = vm.envAddress("BATCH_POSTER_MANAGER");

        require(block.chainid == PlasmaChild.PARENT_CHAIN_ID, "not plasma");

        // Cheatcode balance for the simulation. A real broadcast ignores this
        // and spends the deployer's XPL on gas only (no factory retryables).
        vm.deal(deployer, 1 ether);

        vm.startBroadcast(deployer);
        EthRollupLaunch.Result memory rollup = EthRollupLaunch.deploy(
            EthRollupLaunch.Params({
                owner: owner,
                stakeToken: PlasmaChild.WXPL,
                loserStakeEscrow: vm.envAddress("LOSER_STAKE_ESCROW"),
                validator: validator,
                batchPoster: poster,
                batchPosterManager: posterManager,
                chainId: PlasmaChild.CHAIN_ID,
                confirmPeriodBlocks: PlasmaChild.CONFIRM_PERIOD_BLOCKS,
                minimumAssertionPeriod: 75,
                wasmModuleRoot: vm.envBytes32("WASM_MODULE_ROOT"),
                chainConfig: vm.envString("CHAIN_CONFIG"),
                nativeToken: address(0)
            })
        );
        StandardGatewayLaunch gateways = new StandardGatewayLaunch();
        StandardGatewayLaunch.Result memory g = gateways.deploy(
            rollup.inbox,
            PlasmaChild.L2_ERC20_GATEWAY,
            PlasmaChild.L2_GATEWAY_ROUTER,
            PlasmaChild.L2_BEACON_PROXY_FACTORY,
            owner
        );
        vm.stopBroadcast();

        console.log("rollup", rollup.rollup);
        console.log("bridge", rollup.bridge);
        console.log("inbox", rollup.inbox);
        console.log("sequencerInbox", rollup.sequencerInbox);
        console.log("outbox", rollup.outbox);
        console.log("createRollupGas", rollup.createRollupGas);
        console.log("gateway", address(g.gateway));
        console.log("router", address(g.router));
        console.log("l2 USDT0", g.gateway.calculateL2TokenAddress(PlasmaChild.USDT0));
        console.log("l2 USDC", g.gateway.calculateL2TokenAddress(PlasmaChild.USDC));
    }
}
