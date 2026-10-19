// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EthRollupLaunch} from "../src/EthRollupLaunch.sol";
import {IRollupUser} from "nitro-src/rollup/IRollupLogic.sol";

/// @notice Orbit child whose gas token is the sovereign unit (an ERC-20).
///         This is not the XPL-native Plasma broadcast. That path passes
///         nativeToken = address(0) and lives in DeployPlasmaMainnet.s.sol.
contract DeployUnitChain is Script {
    address internal deployer;
    EthRollupLaunch.Result internal launched;
    address internal gasToken;
    bytes32 internal wasmRoot;
    string internal chainConfig;

    function run() external {
        deployer = vm.envAddress("DEPLOYER");
        require(block.chainid == vm.envUint("PARENT_CHAIN_ID"), "parent chain");
        gasToken = vm.envAddress("NATIVE_TOKEN");
        require(gasToken.code.length > 0, "gas token has no code");
        wasmRoot = vm.envBytes32("WASM_MODULE_ROOT");
        chainConfig = vm.envString("CHAIN_CONFIG");
        require(wasmRoot != bytes32(0), "wasm module root");
        _broadcast();
        _write();
    }

    function _broadcast() internal {
        vm.startBroadcast(deployer);
        launched = EthRollupLaunch.deploy(
            EthRollupLaunch.Params({
                owner: vm.envOr("ROLLUP_OWNER", deployer),
                stakeToken: vm.envAddress("STAKE_TOKEN"),
                loserStakeEscrow: vm.envOr("LOSER_STAKE_ESCROW", deployer),
                validator: vm.envOr("VALIDATOR", deployer),
                batchPoster: vm.envOr("BATCH_POSTER", deployer),
                batchPosterManager: vm.envOr("BATCH_POSTER_MANAGER", deployer),
                chainId: vm.envUint("CHILD_CHAIN_ID"),
                confirmPeriodBlocks: uint64(vm.envUint("CONFIRM_PERIOD_BLOCKS")),
                minimumAssertionPeriod: 75,
                wasmModuleRoot: wasmRoot,
                chainConfig: chainConfig,
                nativeToken: gasToken
            })
        );
        vm.stopBroadcast();
    }

    function _write() internal {
        address upgradeExecutor = IRollupUser(launched.rollup).owner();
        console.log("rollup", launched.rollup);
        console.log("bridge", launched.bridge);
        console.log("inbox", launched.inbox);
        console.log("sequencerInbox", launched.sequencerInbox);
        console.log("outbox", launched.outbox);
        console.log("upgradeExecutor", upgradeExecutor);
        console.log("gasToken", gasToken);

        string memory obj = "unit-chain";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "childChainId", vm.envUint("CHILD_CHAIN_ID"));
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "gasToken", gasToken);
        vm.serializeAddress(obj, "rollup", launched.rollup);
        vm.serializeAddress(obj, "bridge", launched.bridge);
        vm.serializeAddress(obj, "inbox", launched.inbox);
        vm.serializeAddress(obj, "sequencerInbox", launched.sequencerInbox);
        vm.serializeAddress(obj, "outbox", launched.outbox);
        vm.serializeAddress(obj, "upgradeExecutor", upgradeExecutor);
        vm.serializeBytes32(obj, "wasmModuleRoot", wasmRoot);
        string memory json = vm.serializeString(obj, "chainConfig", chainConfig);
        vm.writeJson(json, string.concat("deployments/", vm.envString("UNIT_ID"), "-rollup.json"));
    }
}
