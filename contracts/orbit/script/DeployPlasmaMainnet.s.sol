// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlasmaChild} from "../src/PlasmaChild.sol";
import {EthRollupLaunch} from "../src/EthRollupLaunch.sol";
import {StandardGatewayLaunch} from "../src/StandardGatewayLaunch.sol";
import {IRollupUser} from "nitro-src/rollup/IRollupLogic.sol";

/// @notice Plasma mainnet (9745) launch of an XPL-native Orbit child plus the
///         standard ERC-20 gateway for USDT0 and USDC.
///
///         Broadcast with deploy-plasma-mainnet.sh. That wrapper passes
///         `--rpc-url https://rpc.plasma.to --private-key $PLASMA_DEPLOYER_KEY
///         --broadcast --slow`. Do not add `--broadcast` by hand against a
///         public RPC unless that key is the funded deployer.
///
///         Each template is its own transaction. createRollup is one
///         transaction. Both have to stay under Plasma's 36,000,000 gas cap.
///         The xMoney vault is a second script in contracts/, run by the same
///         wrapper, because it compiles against a different OpenZeppelin.
contract DeployPlasmaMainnet is Script {
    address internal deployer;
    address internal childDeployer;
    address internal l2Gateway;
    address internal l2Router;
    address internal l2Factory;
    EthRollupLaunch.Result internal launched;
    StandardGatewayLaunch.Result internal wired;

    function run() external {
        deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == PlasmaChild.PARENT_CHAIN_ID, "not plasma");
        childDeployer = vm.envOr("CHILD_DEPLOYER", deployer);
        // Same nonce order as script/DeployChildTokenBridge.s.sol.
        l2Gateway = vm.computeCreateAddress(childDeployer, PlasmaChild.CHILD_GATEWAY_NONCE);
        l2Router = vm.computeCreateAddress(childDeployer, PlasmaChild.CHILD_ROUTER_NONCE);
        l2Factory = vm.computeCreateAddress(childDeployer, PlasmaChild.CHILD_FACTORY_NONCE);
        _broadcast();
        _write();
    }

    function _broadcast() internal {
        bytes32 wasm = vm.envBytes32("WASM_MODULE_ROOT");
        require(wasm != bytes32(0), "wasm module root");
        vm.startBroadcast(deployer);
        launched = EthRollupLaunch.deploy(_params(wasm));
        StandardGatewayLaunch gateways = new StandardGatewayLaunch();
        wired = gateways.deploy(launched.inbox, l2Gateway, l2Router, l2Factory, vm.envOr("ROLLUP_OWNER", deployer));
        vm.stopBroadcast();
    }

    function _params(bytes32 wasm) internal view returns (EthRollupLaunch.Params memory) {
        return EthRollupLaunch.Params({
            owner: vm.envOr("ROLLUP_OWNER", deployer),
            stakeToken: PlasmaChild.WXPL,
            loserStakeEscrow: vm.envOr("LOSER_STAKE_ESCROW", deployer),
            validator: vm.envOr("VALIDATOR", deployer),
            batchPoster: vm.envOr("BATCH_POSTER", deployer),
            batchPosterManager: vm.envOr("BATCH_POSTER_MANAGER", deployer),
            chainId: PlasmaChild.CHAIN_ID,
            confirmPeriodBlocks: PlasmaChild.CONFIRM_PERIOD_BLOCKS,
            minimumAssertionPeriod: 75,
            wasmModuleRoot: wasm,
            chainConfig: vm.envOr(
                "CHAIN_CONFIG",
                string(
                    '{"chainId":974502,"arbitrum":{"EnableArbOS":true,"DataAvailabilityCommittee":false,"InitialArbOSVersion":51,"InitialChainOwner":"0x0000000000000000000000000000000000000000"}}'
                )
            )
        });
    }

    function _write() internal {
        address upgradeExecutor = IRollupUser(launched.rollup).owner();
        address l2Usdt0 = wired.gateway.calculateL2TokenAddress(PlasmaChild.USDT0);
        address l2Usdc = wired.gateway.calculateL2TokenAddress(PlasmaChild.USDC);

        console.log("rollup", launched.rollup);
        console.log("bridge", launched.bridge);
        console.log("inbox", launched.inbox);
        console.log("sequencerInbox", launched.sequencerInbox);
        console.log("outbox", launched.outbox);
        console.log("upgradeExecutor", upgradeExecutor);
        console.log("gateway", address(wired.gateway));
        console.log("router", address(wired.router));
        console.log("l2 gateway", l2Gateway);
        console.log("l2 router", l2Router);
        console.log("l2 factory", l2Factory);
        console.log("l2 USDT0", l2Usdt0);
        console.log("l2 USDC", l2Usdc);

        string memory obj = "plasma-rollup";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "childChainId", PlasmaChild.CHAIN_ID);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "childDeployer", childDeployer);
        vm.serializeAddress(obj, "rollup", launched.rollup);
        vm.serializeAddress(obj, "bridge", launched.bridge);
        vm.serializeAddress(obj, "inbox", launched.inbox);
        vm.serializeAddress(obj, "sequencerInbox", launched.sequencerInbox);
        vm.serializeAddress(obj, "outbox", launched.outbox);
        vm.serializeAddress(obj, "upgradeExecutor", upgradeExecutor);
        vm.serializeAddress(obj, "rollupCreator", address(launched.rollupCreator));
        vm.serializeAddress(obj, "gateway", address(wired.gateway));
        vm.serializeAddress(obj, "router", address(wired.router));
        vm.serializeAddress(obj, "l2Erc20Gateway", l2Gateway);
        vm.serializeAddress(obj, "l2GatewayRouter", l2Router);
        vm.serializeAddress(obj, "l2BeaconProxyFactory", l2Factory);
        vm.serializeAddress(obj, "l2Usdt0", l2Usdt0);
        vm.serializeAddress(obj, "l2Usdc", l2Usdc);
        vm.serializeAddress(obj, "usdt0", PlasmaChild.USDT0);
        vm.serializeAddress(obj, "usdc", PlasmaChild.USDC);
        vm.serializeAddress(obj, "wxpl", PlasmaChild.WXPL);
        string memory json = vm.serializeBytes32(obj, "wasmModuleRoot", vm.envBytes32("WASM_MODULE_ROOT"));
        vm.writeJson(json, "deployments/plasma-rollup.json");
    }
}
