// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {XgasDevPaymaster} from "../src/aa/XgasDevPaymaster.sol";
import {EntryPointV07Code} from "../src/aa/canonical/EntryPointV07Code.sol";
import {SimpleAccountFactoryV07Code} from "../src/aa/canonical/SimpleAccountFactoryV07Code.sol";

/**
 * @notice ERC-4337 v0.7 on the xGas L4 (chain 466302): EntryPoint, SimpleAccountFactory and XgasDevPaymaster.
 *
 *         EntryPoint and SimpleAccountFactory are deployed from the exact creation code of the canonical v0.7
 *         deployment (npm account-abstraction contracts 0.7.0 artifacts), never recompiled, so the runtime code is
 *         byte-identical to 0x0000000071727De22E5E9d8BAf0edAc6f37da032 / 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985
 *         on every other chain.
 *
 *         Two modes, chosen from chain state:
 *         - CANONICAL, when the deterministic CREATE2 deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C has code:
 *           EntryPoint lands at 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (canonical salt), the factory at
 *           0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985 (salt 0), the paymaster at a CREATE2 address fixed by
 *           (entryPoint, owner, signer). Contracts already present are skipped, so the script is rerunnable.
 *           viem / permissionless defaults then work with no address overrides.
 *         - PLAIN, when it has no code (the case on 466302 at block 18, checked 2026-09-26): ordinary CREATEs from
 *           the deployer, addresses printed at the end and dependent on the deployer's nonce.
 *
 *         To get the canonical addresses on 466302, bootstrap the CREATE2 deployer BEFORE running this script
 *         (costs 0.01 xMoney): send 0.01 xMoney to 0x3fab184622dc19b6109349b94811493bf2a45362, then publish its
 *         presigned pre-EIP-155 transaction (https://github.com/Arachnid/deterministic-deployment-proxy):
 *           cast publish --rpc-url https://xgas.dev/rpc 0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222
 *         It needs the L4 base fee at or under 100 gwei and a node that accepts unprotected transactions over RPC
 *         (Nitro: --execution.rpc.tx-allow-unprotected). If the RPC refuses it, the same raw transaction can be
 *         force-included from the parent chain through the Orbit inbox (sendL2Message), as the Orbit
 *         RollupCreator's DeployHelper does.
 *
 *         Env: PRIVATE_KEY (deployer, becomes the paymaster owner), PAYMASTER_SIGNER (address of the server's
 *         PAYMASTER_SIGNER_KEY), optional PAYMASTER_DEPOSIT (xMoney wei to deposit in the EntryPoint),
 *         PAYMASTER_STAKE (xMoney wei; ERC-7562 bundlers need the paymaster staked because it reads its own
 *         storage) and PAYMASTER_UNSTAKE_DELAY (seconds, default 86400).
 *
 *         forge script script/DeployXgasAA.s.sol --rpc-url https://xgas.dev/rpc --broadcast --slow
 */
contract DeployXgasAA is Script {
    uint256 public constant L4_CHAIN_ID = 466302;

    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address public constant CANONICAL_ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address public constant CANONICAL_FACTORY = 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985;
    bytes32 public constant ENTRYPOINT_SALT = 0x90d8084deab30c2a37c45e8d47f49f2f7965183cb6990a98943ef94940681de3;
    bytes32 public constant FACTORY_SALT = bytes32(0);
    bytes32 public constant PAYMASTER_SALT = keccak256("xgas.dev XgasDevPaymaster v1");

    struct Deployment {
        address entryPoint;
        address factory;
        address paymaster;
        bool canonical;
    }

    function run() external returns (Deployment memory) {
        return deploy(
            vm.envUint("PRIVATE_KEY"),
            vm.envAddress("PAYMASTER_SIGNER"),
            vm.envOr("PAYMASTER_DEPOSIT", uint256(0)),
            vm.envOr("PAYMASTER_STAKE", uint256(0)),
            vm.envOr("PAYMASTER_UNSTAKE_DELAY", uint256(86400))
        );
    }

    /// @dev run() with explicit inputs (used by the tests, so they do not race on process env vars).
    function deploy(uint256 pk, address pmSigner, uint256 depositWei, uint256 stakeWei, uint256 unstakeDelay)
        public
        returns (Deployment memory d)
    {
        require(block.chainid == L4_CHAIN_ID, "DeployXgasAA: not the xGas L4 (466302)");
        address deployer = vm.addr(pk);
        require(pmSigner != address(0), "DeployXgasAA: PAYMASTER_SIGNER unset");
        require(unstakeDelay > 0 && unstakeDelay <= type(uint32).max, "DeployXgasAA: bad PAYMASTER_UNSTAKE_DELAY");

        // Local-only helpers (created before startBroadcast, so never sent on chain).
        bytes memory epInit = new EntryPointV07Code().initCode();
        bytes memory factoryInitNoArgs = new SimpleAccountFactoryV07Code().initCode();

        d.canonical = CREATE2_DEPLOYER.code.length > 0;
        console.log(d.canonical ? "mode: CANONICAL (CREATE2 deployer present)" : "mode: PLAIN (no CREATE2 deployer)");
        console.log("deployer / paymaster owner:", deployer);
        console.log("paymaster signer:", pmSigner);

        vm.startBroadcast(pk);
        if (d.canonical) {
            d.entryPoint = _create2(ENTRYPOINT_SALT, epInit);
            d.factory = _create2(FACTORY_SALT, abi.encodePacked(factoryInitNoArgs, abi.encode(d.entryPoint)));
            d.paymaster = _create2(
                PAYMASTER_SALT,
                abi.encodePacked(type(XgasDevPaymaster).creationCode, abi.encode(d.entryPoint, deployer, pmSigner))
            );
            require(d.entryPoint == CANONICAL_ENTRYPOINT, "DeployXgasAA: EntryPoint not canonical");
            require(d.factory == CANONICAL_FACTORY, "DeployXgasAA: factory not canonical");
        } else {
            d.entryPoint = _create(epInit);
            d.factory = _create(abi.encodePacked(factoryInitNoArgs, abi.encode(d.entryPoint)));
            d.paymaster = address(new XgasDevPaymaster(IEntryPoint(d.entryPoint), deployer, pmSigner));
        }

        XgasDevPaymaster pm = XgasDevPaymaster(payable(d.paymaster));
        if (depositWei > 0) pm.deposit{value: depositWei}();
        if (stakeWei > 0) pm.addStake{value: stakeWei}(uint32(unstakeDelay));
        vm.stopBroadcast();

        require(pm.owner() == deployer, "DeployXgasAA: paymaster owner mismatch");
        require(pm.signer() == pmSigner, "DeployXgasAA: paymaster signer mismatch");
        require(address(pm.entryPoint()) == d.entryPoint, "DeployXgasAA: paymaster entryPoint mismatch");

        console.log("EntryPoint v0.7:            ", d.entryPoint);
        console.log("SimpleAccountFactory v0.7:  ", d.factory);
        console.log("XgasDevPaymaster:           ", d.paymaster);
        console.log("paymaster EntryPoint deposit (wei):", pm.getDeposit());
    }

    /// @dev CREATE2 through the deterministic deployer; skips if the address already has code.
    function _create2(bytes32 salt, bytes memory initCode) internal returns (address addr) {
        addr = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (addr.code.length > 0) {
            console.log("already deployed, skipping:", addr);
            return addr;
        }
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == addr, "DeployXgasAA: CREATE2 deploy failed");
    }

    /// @dev Plain CREATE of raw creation code (a broadcast CREATE transaction from the deployer).
    function _create(bytes memory initCode) internal returns (address addr) {
        assembly {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(addr != address(0) && addr.code.length > 0, "DeployXgasAA: CREATE failed");
    }
}
