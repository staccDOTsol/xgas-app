// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {SimpleAccountFactory} from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import {DeployXgasAA} from "../../script/DeployXgasAA.s.sol";
import {XgasDevPaymaster} from "../../src/aa/XgasDevPaymaster.sol";
import {EntryPointV07Code} from "../../src/aa/canonical/EntryPointV07Code.sol";

/// @dev Runs the deploy script (not broadcast anywhere) in both modes.
contract DeployXgasAATest is Test {
    bytes constant CREATE2_DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 constant PK = 0xA11CE5EED;
    address deployer;
    address pmSigner = makeAddr("pmSigner");
    DeployXgasAA script;

    function setUp() public {
        vm.chainId(466302);
        deployer = vm.addr(PK);
        vm.deal(deployer, 10 ether);
        script = new DeployXgasAA();
    }

    function _check(DeployXgasAA.Deployment memory d) internal {
        assertGt(d.entryPoint.code.length, 0);
        assertGt(d.factory.code.length, 0);
        assertGt(d.paymaster.code.length, 0);
        // byte-identical runtime to the canonical EntryPoint creation code's output
        address ref;
        bytes memory init = new EntryPointV07Code().initCode();
        assembly {
            ref := create(0, add(init, 0x20), mload(init))
        }
        // equal once the one immutable (its SenderCreator, created at EntryPoint nonce 1) is masked out
        assertEq(
            keccak256(_mask(d.entryPoint.code, vm.computeCreateAddress(d.entryPoint, 1))),
            keccak256(_mask(ref.code, vm.computeCreateAddress(ref, 1))),
            "EntryPoint runtime is canonical"
        );
        assertEq(address(SimpleAccountFactory(d.factory).accountImplementation().entryPoint()), d.entryPoint);
        XgasDevPaymaster pm = XgasDevPaymaster(payable(d.paymaster));
        assertEq(pm.owner(), deployer, "owner = deployer");
        assertEq(pm.signer(), pmSigner);
        assertEq(address(pm.entryPoint()), d.entryPoint);
        IEntryPoint.DepositInfo memory info = IEntryPoint(d.entryPoint).getDepositInfo(d.paymaster);
        assertTrue(info.staked);
        assertEq(info.unstakeDelaySec, 86400);
    }

    function _mask(bytes memory code, address a) internal pure returns (bytes memory) {
        bytes20 pat = bytes20(a);
        uint256 hits;
        for (uint256 i; i + 20 <= code.length; i++) {
            bool m = true;
            for (uint256 j; j < 20; j++) {
                if (code[i + j] != pat[j]) {
                    m = false;
                    break;
                }
            }
            if (m) {
                for (uint256 j; j < 20; j++) {
                    code[i + j] = 0;
                }
                hits++;
            }
        }
        require(hits > 0, "immutable not found");
        return code;
    }

    function test_PlainMode_WhenNoCreate2Deployer() public {
        vm.etch(CREATE2_DEPLOYER, ""); // the 466302 state today
        uint64 n = vm.getNonce(deployer);
        DeployXgasAA.Deployment memory d = script.deploy(PK, pmSigner, 1 ether, 0.5 ether, 86400);
        assertFalse(d.canonical);
        assertEq(d.entryPoint, vm.computeCreateAddress(deployer, n));
        assertEq(d.factory, vm.computeCreateAddress(deployer, n + 1));
        assertEq(d.paymaster, vm.computeCreateAddress(deployer, n + 2));
        assertEq(XgasDevPaymaster(payable(d.paymaster)).getDeposit(), 1 ether);
        _check(d);
    }

    function test_CanonicalMode_WhenCreate2DeployerExists() public {
        vm.etch(CREATE2_DEPLOYER, CREATE2_DEPLOYER_RUNTIME);
        DeployXgasAA.Deployment memory d = script.deploy(PK, pmSigner, 1 ether, 0.5 ether, 86400);
        assertTrue(d.canonical);
        assertEq(d.entryPoint, 0x0000000071727De22E5E9d8BAf0edAc6f37da032);
        assertEq(d.factory, 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985);
        // the canonical EntryPoint's SenderCreator, as on every other chain
        assertEq(vm.computeCreateAddress(d.entryPoint, 1), 0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C);
        assertGt(address(0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C).code.length, 0);
        bytes memory pmInit = abi.encodePacked(
            type(XgasDevPaymaster).creationCode, abi.encode(d.entryPoint, deployer, pmSigner)
        );
        assertEq(d.paymaster, vm.computeCreate2Address(script.PAYMASTER_SALT(), keccak256(pmInit), CREATE2_DEPLOYER));
        _check(d);
    }

    function test_CanonicalMode_RerunSkipsExisting() public {
        vm.etch(CREATE2_DEPLOYER, CREATE2_DEPLOYER_RUNTIME);
        DeployXgasAA.Deployment memory a = script.deploy(PK, pmSigner, 1 ether, 0.5 ether, 86400);
        DeployXgasAA.Deployment memory b = script.deploy(PK, pmSigner, 1 ether, 0, 86400);
        assertEq(a.entryPoint, b.entryPoint);
        assertEq(a.factory, b.factory);
        assertEq(a.paymaster, b.paymaster);
        assertEq(XgasDevPaymaster(payable(b.paymaster)).getDeposit(), 2 ether);
    }

    function test_RevertsOnWrongChain() public {
        vm.chainId(466301);
        vm.expectRevert("DeployXgasAA: not the xGas L4 (466302)");
        script.deploy(PK, pmSigner, 0, 0, 86400);
    }

    function test_RevertsOnZeroSigner() public {
        vm.expectRevert("DeployXgasAA: PAYMASTER_SIGNER unset");
        script.deploy(PK, address(0), 0, 0, 86400);
    }
}
