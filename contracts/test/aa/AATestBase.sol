// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SimpleAccountFactory} from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import {SimpleAccount} from "@account-abstraction/contracts/samples/SimpleAccount.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {XgasDevPaymaster} from "../../src/aa/XgasDevPaymaster.sol";
import {EntryPointV07Code} from "../../src/aa/canonical/EntryPointV07Code.sol";
import {SimpleAccountFactoryV07Code} from "../../src/aa/canonical/SimpleAccountFactoryV07Code.sol";

contract Target {
    uint256 public count;
    mapping(address => uint256) public bySender;

    function inc() external {
        count++;
        bySender[msg.sender]++;
    }

    function boom() external pure {
        revert("boom");
    }

    function burn() external pure {
        while (true) {}
    }
}

/// @dev Shared fixture: the canonical v0.7 EntryPoint and SimpleAccountFactory bytecode (not recompiled), plus the
///      paymaster, on chain id 466302.
abstract contract AATestBase is Test {
    using MessageHashUtils for bytes32;

    uint256 internal constant L4 = 466302;
    uint128 internal constant PM_VERIFICATION_GAS = 60_000;
    uint128 internal constant PM_POSTOP_GAS = 40_000;
    uint256 internal constant VERIFICATION_GAS = 500_000;
    uint256 internal constant CALL_GAS = 200_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 60_000;
    uint256 internal constant MAX_PRIORITY_FEE = 0.01 gwei;
    uint256 internal constant MAX_FEE = 0.2 gwei;
    uint256 internal constant BASE_FEE = 0.1 gwei;

    IEntryPoint internal ep;
    SimpleAccountFactory internal factory;
    XgasDevPaymaster internal pm;
    Target internal target;

    address internal pmOwner = makeAddr("pmOwner");
    uint256 internal signerKey;
    address internal signerAddr;
    uint256 internal payerKey; // the Robinhood EOA that owns the smart account and pays in XGAS.DEV
    address internal payer;
    address payable internal bundler;

    function setUp() public virtual {
        vm.chainId(L4);
        vm.warp(1_800_000_000);
        vm.fee(BASE_FEE);
        (signerAddr, signerKey) = makeAddrAndKey("paymasterSigner");
        (payer, payerKey) = makeAddrAndKey("robinhoodPayer");
        bundler = payable(makeAddr("bundler"));

        ep = IEntryPoint(_deployRaw(new EntryPointV07Code().initCode()));
        factory = SimpleAccountFactory(
            _deployRaw(abi.encodePacked(new SimpleAccountFactoryV07Code().initCode(), abi.encode(address(ep))))
        );
        pm = new XgasDevPaymaster(ep, pmOwner, signerAddr);
        vm.deal(address(this), 100 ether);
        pm.deposit{value: 10 ether}();
        target = new Target();
    }

    function _deployRaw(bytes memory initCode) internal returns (address addr) {
        assembly {
            addr := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(addr != address(0), "deploy failed");
    }

    // ------------------------------------------------------------------------------------------- op building

    struct Sponsor {
        uint48 validUntil;
        uint48 validAfter;
        uint256 maxCharge;
        address payer;
    }

    function _defaultSponsor() internal view returns (Sponsor memory s) {
        s = Sponsor(uint48(block.timestamp + 300), uint48(block.timestamp - 10), 5e18, payer);
    }

    function _accountOf(address owner) internal view returns (address) {
        return factory.getAddress(owner, 0);
    }

    /// @dev Unsigned op from `owner`'s SimpleAccount calling `data` on the target, deploying the account if needed.
    function _op(address owner, bytes memory data) internal view returns (PackedUserOperation memory op) {
        op.sender = _accountOf(owner);
        op.nonce = ep.getNonce(op.sender, 0);
        if (op.sender.code.length == 0) {
            op.initCode = abi.encodePacked(address(factory), abi.encodeCall(SimpleAccountFactory.createAccount, (owner, 0)));
        }
        op.callData = abi.encodeCall(SimpleAccount.execute, (address(target), 0, data));
        op.accountGasLimits = bytes32((VERIFICATION_GAS << 128) | CALL_GAS);
        op.preVerificationGas = PRE_VERIFICATION_GAS;
        op.gasFees = bytes32((MAX_PRIORITY_FEE << 128) | MAX_FEE);
    }

    function _pnd(address paymaster, uint128 postOpGas, Sponsor memory s, bytes memory sig)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            paymaster, PM_VERIFICATION_GAS, postOpGas, s.validUntil, s.validAfter, s.maxCharge, s.payer, sig
        );
    }

    /// @dev Signs the sponsorship for `paymaster` with `key` (EIP-191 over getHash) and writes paymasterAndData.
    function _sponsor(PackedUserOperation memory op, XgasDevPaymaster paymaster, uint256 key, Sponsor memory s)
        internal
        view
    {
        op.paymasterAndData = _pnd(address(paymaster), PM_POSTOP_GAS, s, new bytes(65));
        bytes32 h = paymaster.getHash(op, s.validUntil, s.validAfter, s.maxCharge, s.payer);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, h.toEthSignedMessageHash());
        op.paymasterAndData = _pnd(address(paymaster), PM_POSTOP_GAS, s, abi.encodePacked(r, sg, v));
    }

    function _signAccount(PackedUserOperation memory op, uint256 ownerKey) internal view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, ep.getUserOpHash(op).toEthSignedMessageHash());
        op.signature = abi.encodePacked(r, s, v);
    }

    function _sponsoredOp(bytes memory data) internal view returns (PackedUserOperation memory op) {
        op = _op(payer, data);
        _sponsor(op, pm, signerKey, _defaultSponsor());
        _signAccount(op, payerKey);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, bundler);
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, uint256(0), reason));
    }

    /// @dev Upper bound of what the EntryPoint can take from the deposit for `op` (v0.7 requiredPrefund).
    function _maxCost(PackedUserOperation memory op) internal pure returns (uint256) {
        uint256 pmGas = uint256(bytes32(_slice(op.paymasterAndData, 20, 52)));
        uint256 gas = (uint256(op.accountGasLimits) >> 128) + uint128(uint256(op.accountGasLimits))
            + op.preVerificationGas + (pmGas >> 128) + uint128(pmGas);
        return gas * uint128(uint256(op.gasFees));
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i = from; i < to; i++) {
            out[i - from] = b[i];
        }
    }

    // ------------------------------------------------------------------------------------------- log helpers

    struct Charged {
        bool found;
        bytes32 userOpHash;
        address sender;
        address robinhoodPayer;
        uint256 actualGasCost;
        uint256 actualUserOpFeePerGas;
        uint256 maxXgasDevCharge;
        bool succeeded;
    }

    struct OpEvent {
        bool found;
        bytes32 userOpHash;
        address sender;
        address paymaster;
        bool success;
        uint256 actualGasCost;
    }

    function _decode(Vm.Log[] memory logs, address paymaster)
        internal
        pure
        returns (Charged memory c, OpEvent memory o)
    {
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter == paymaster && l.topics[0] == XgasDevPaymaster.XgasDevGasCharged.selector) {
                require(!c.found, "two charge events");
                c.found = true;
                c.userOpHash = l.topics[1];
                c.sender = address(uint160(uint256(l.topics[2])));
                c.robinhoodPayer = address(uint160(uint256(l.topics[3])));
                (c.actualGasCost, c.actualUserOpFeePerGas, c.maxXgasDevCharge, c.succeeded) =
                    abi.decode(l.data, (uint256, uint256, uint256, bool));
            }
            if (l.topics[0] == IEntryPoint.UserOperationEvent.selector) {
                o.found = true;
                o.userOpHash = l.topics[1];
                o.sender = address(uint160(uint256(l.topics[2])));
                o.paymaster = address(uint160(uint256(l.topics[3])));
                (, o.success, o.actualGasCost,) = abi.decode(l.data, (uint256, bool, uint256, uint256));
            }
        }
    }
}
