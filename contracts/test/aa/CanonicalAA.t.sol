// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SimpleAccountFactory} from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import {SimpleAccount} from "@account-abstraction/contracts/samples/SimpleAccount.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {EntryPointV07Code} from "../../src/aa/canonical/EntryPointV07Code.sol";
import {SimpleAccountFactoryV07Code} from "../../src/aa/canonical/SimpleAccountFactoryV07Code.sol";

/// @dev The embedded creation code is the canonical v0.7 deployment, and the deterministic-deployer route lands on
///      the canonical addresses.
contract CanonicalAATest is Test {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // Runtime code of Arachnid's deterministic-deployment-proxy (what the presigned tx deploys at CREATE2_DEPLOYER).
    bytes constant CREATE2_DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    address constant CANONICAL_ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant CANONICAL_FACTORY = 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985;
    bytes32 constant ENTRYPOINT_SALT = 0x90d8084deab30c2a37c45e8d47f49f2f7965183cb6990a98943ef94940681de3;

    bytes epInit;
    bytes factoryInit;

    function setUp() public {
        epInit = new EntryPointV07Code().initCode();
        factoryInit = abi.encodePacked(new SimpleAccountFactoryV07Code().initCode(), abi.encode(CANONICAL_ENTRYPOINT));
    }

    function test_InitCodeHashesAreThePackageArtifacts() public {
        assertEq(keccak256(epInit), 0x30516d9cdbeabfaf62ea32d081a10ee3b95b92e5549cfc86353bbe85741c1404);
        assertEq(
            keccak256(new SimpleAccountFactoryV07Code().initCode()),
            0x2e4b2194efbc7fd73d749dee9f3a8a601a35fff2a87576bc970684083ed67cad
        );
    }

    function test_Create2AddressesAreCanonical() public pure {
        // pure re-derivation (no deployment) of the addresses the canonical salts give
        assertEq(
            vm.computeCreate2Address(ENTRYPOINT_SALT, 0x30516d9cdbeabfaf62ea32d081a10ee3b95b92e5549cfc86353bbe85741c1404, CREATE2_DEPLOYER),
            CANONICAL_ENTRYPOINT
        );
    }

    function test_FactoryCreate2AddressIsCanonical() public view {
        assertEq(vm.computeCreate2Address(bytes32(0), keccak256(factoryInit), CREATE2_DEPLOYER), CANONICAL_FACTORY);
    }

    function test_DeterministicDeployerLandsOnCanonicalAddresses() public {
        vm.etch(CREATE2_DEPLOYER, CREATE2_DEPLOYER_RUNTIME);
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(ENTRYPOINT_SALT, epInit));
        assertTrue(ok);
        assertEq(address(bytes20(ret)), CANONICAL_ENTRYPOINT);
        (ok, ret) = CREATE2_DEPLOYER.call(abi.encodePacked(bytes32(0), factoryInit));
        assertTrue(ok);
        assertEq(address(bytes20(ret)), CANONICAL_FACTORY);

        assertTrue(IERC165(CANONICAL_ENTRYPOINT).supportsInterface(type(IEntryPoint).interfaceId));
        SimpleAccountFactory f = SimpleAccountFactory(CANONICAL_FACTORY);
        assertEq(address(f.accountImplementation().entryPoint()), CANONICAL_ENTRYPOINT);
        // counterfactual account addresses from the canonical factory match what createAccount deploys
        address predicted = f.getAddress(address(0xB0B), 0);
        SimpleAccount acct = f.createAccount(address(0xB0B), 0);
        assertEq(address(acct), predicted);
        assertEq(acct.owner(), address(0xB0B));
    }

    /// @dev The vendored sources compile and expose the same IEntryPoint interface id as the canonical bytecode,
    ///      which is what BasePaymaster checks at construction.
    function test_VendoredSourceMatchesCanonicalInterface() public {
        address canonical;
        bytes memory code = epInit;
        assembly {
            canonical := create(0, add(code, 0x20), mload(code))
        }
        EntryPoint fromSource = new EntryPoint();
        bytes4 id = type(IEntryPoint).interfaceId;
        assertTrue(IERC165(canonical).supportsInterface(id));
        assertTrue(fromSource.supportsInterface(id));
    }
}
