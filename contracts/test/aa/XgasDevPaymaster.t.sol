// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {XgasDevPaymaster} from "../../src/aa/XgasDevPaymaster.sol";
import {AATestBase, Target} from "./AATestBase.sol";

contract XgasDevPaymasterTest is AATestBase {
    using MessageHashUtils for bytes32;

    // ---------------------------------------------------------------------------------------------- deployment

    function test_Constructor_SetsOwnerSignerEntryPoint() public view {
        assertEq(pm.owner(), pmOwner);
        assertEq(pm.signer(), signerAddr);
        assertEq(address(pm.entryPoint()), address(ep));
        assertFalse(pm.paused());
        assertEq(pm.getDeposit(), 10 ether);
    }

    function test_Constructor_OwnerDefaultsToDeployerWhenSame() public {
        XgasDevPaymaster p = new XgasDevPaymaster(ep, address(this), signerAddr);
        assertEq(p.owner(), address(this));
    }

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(XgasDevPaymaster.ZeroAddress.selector);
        new XgasDevPaymaster(ep, address(0), signerAddr);
        vm.expectRevert(XgasDevPaymaster.ZeroAddress.selector);
        new XgasDevPaymaster(ep, pmOwner, address(0));
    }

    function test_Constructor_RejectsNonEntryPoint() public {
        vm.expectRevert();
        new XgasDevPaymaster(IEntryPoint(address(target)), pmOwner, signerAddr);
    }

    // ------------------------------------------------------------------------------------- valid sponsorship

    function test_ValidSponsorship_DeploysAccountAndExecutes() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        address sender = op.sender;
        assertEq(sender.code.length, 0);
        assertEq(sender.balance, 0);
        uint256 depositBefore = pm.getDeposit();

        _handle(op);

        assertGt(sender.code.length, 0, "account deployed");
        assertEq(target.count(), 1);
        assertEq(target.bySender(sender), 1);
        assertEq(sender.balance, 0, "sender paid nothing in xMoney");
        assertEq(ep.balanceOf(sender), 0);
        assertLt(pm.getDeposit(), depositBefore, "paymaster deposit paid");
        assertGt(bundler.balance, 0, "bundler compensated");
    }

    function test_ValidSponsorship_SecondOpOnDeployedAccount() public {
        _handle(_sponsoredOp(abi.encodeCall(Target.inc, ())));
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        assertEq(op.initCode.length, 0);
        assertEq(op.nonce, 1);
        _handle(op);
        assertEq(target.count(), 2);
    }

    function test_PostOpEvent_Correctness() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        bytes32 userOpHash = ep.getUserOpHash(op);
        uint256 depositBefore = pm.getDeposit();

        vm.recordLogs();
        _handle(op);
        (Charged memory c, OpEvent memory o) = _decode(vm.getRecordedLogs(), address(pm));

        assertTrue(c.found && o.found);
        assertEq(c.userOpHash, userOpHash);
        assertEq(c.sender, op.sender);
        assertEq(c.robinhoodPayer, s.payer);
        assertEq(c.maxXgasDevCharge, s.maxCharge);
        assertTrue(c.succeeded);
        assertEq(c.actualUserOpFeePerGas, BASE_FEE + MAX_PRIORITY_FEE, "min(maxFee, basefee + tip)");
        assertGt(c.actualGasCost, 0);
        assertEq(c.actualGasCost % c.actualUserOpFeePerGas, 0);

        assertEq(o.userOpHash, userOpHash);
        assertEq(o.paymaster, address(pm));
        assertTrue(o.success);
        // postOp sees the cost before its own gas; the EntryPoint's final charge is a bit higher, bounded by maxCost.
        assertLe(c.actualGasCost, o.actualGasCost);
        assertLe(o.actualGasCost, _maxCost(op));
        assertEq(depositBefore - pm.getDeposit(), o.actualGasCost, "deposit debited by the final cost");
    }

    // ------------------------------------------------------------------------------------------- time window

    function test_Expired_RevertsAA32() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        s.validUntil = uint48(block.timestamp - 1);
        _sponsor(op, pm, signerKey, s);
        _signAccount(op, payerKey);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
    }

    function test_ExpiresAfterWindow_RevertsAA32() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        vm.warp(block.timestamp + 301);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
    }

    function test_NotYetValid_RevertsAA32() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        s.validAfter = uint48(block.timestamp + 60);
        _sponsor(op, pm, signerKey, s);
        _signAccount(op, payerKey);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);

        vm.warp(block.timestamp + 61);
        _handle(op);
        assertEq(target.count(), 1);
    }

    // --------------------------------------------------------------------------------------------- signatures

    function test_WrongSigner_RevertsAA34() public {
        (, uint256 rogueKey) = makeAddrAndKey("rogue");
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, rogueKey, _defaultSponsor());
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedMaxCharge_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        _sponsor(op, pm, signerKey, s);
        bytes memory sig = _slice(op.paymasterAndData, 116, 181);
        s.maxCharge = 1; // user lowers what the server may debit
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, s, sig);
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedPayer_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        _sponsor(op, pm, signerKey, s);
        bytes memory sig = _slice(op.paymasterAndData, 116, 181);
        s.payer = makeAddr("someoneElse"); // user shifts the debit to another Robinhood address
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, s, sig);
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedGasLimits_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor());
        op.accountGasLimits = bytes32((VERIFICATION_GAS << 128) | (CALL_GAS * 10)); // raise max cost after quote
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedGasFees_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor());
        op.gasFees = bytes32((MAX_PRIORITY_FEE << 128) | (MAX_FEE * 100));
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedCallData_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor());
        op.callData = abi.encodeWithSignature("execute(address,uint256,bytes)", address(target), 0, hex"");
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_TamperedPostOpGas_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        _sponsor(op, pm, signerKey, s);
        bytes memory sig = _slice(op.paymasterAndData, 116, 181);
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS + 1, s, sig);
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_ReplayAcrossPaymaster_RevertsAA34() public {
        XgasDevPaymaster pm2 = new XgasDevPaymaster(ep, pmOwner, signerAddr); // same signer, other address
        pm2.deposit{value: 1 ether}();
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        _sponsor(op, pm, signerKey, s);
        bytes memory sig = _slice(op.paymasterAndData, 116, 181);
        op.paymasterAndData = _pnd(address(pm2), PM_POSTOP_GAS, s, sig); // same approval, pointed at pm2
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_ReplayAcrossChain_RevertsAA34() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor()); // approved for 466302
        vm.chainId(466301); // same paymaster address on another chain (e.g. the L3)
        _signAccount(op, payerKey); // the user can re-sign their own account signature for that chain
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function test_ReplaySameOp_WithInitCode_RevertsAA10() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        _handle(op);
        _expectFailedOp("AA10 sender already constructed");
        _handle(op);
        assertEq(target.count(), 1);
    }

    function test_ReplaySameOp_DeployedAccount_RevertsAA25() public {
        _handle(_sponsoredOp(abi.encodeCall(Target.inc, ())));
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        _handle(op);
        _expectFailedOp("AA25 invalid account nonce");
        _handle(op);
        assertEq(target.count(), 2);
    }

    function test_BadAccountSignature_PaymasterNotCharged() public {
        (, uint256 otherKey) = makeAddrAndKey("notTheOwner");
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor());
        _signAccount(op, otherKey);
        uint256 depositBefore = pm.getDeposit();
        _expectFailedOp("AA24 signature error");
        _handle(op);
        assertEq(pm.getDeposit(), depositBefore);
    }

    function test_InvalidSignatureLength_RevertsAA33() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, _defaultSponsor(), new bytes(64));
        _signAccount(op, payerKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                uint256(0),
                "AA33 reverted",
                abi.encodeWithSelector(XgasDevPaymaster.InvalidSignatureLength.selector, uint256(64))
            )
        );
        _handle(op);
    }

    function test_ShortPaymasterData_RevertsAA33() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        op.paymasterAndData = abi.encodePacked(address(pm), PM_VERIFICATION_GAS, PM_POSTOP_GAS, uint48(0));
        _signAccount(op, payerKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                uint256(0),
                "AA33 reverted",
                abi.encodeWithSelector(XgasDevPaymaster.InvalidPaymasterDataLength.selector, uint256(58))
            )
        );
        _handle(op);
    }

    function test_PostOpGasTooLow_RevertsAA33() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        op.paymasterAndData = _pnd(address(pm), 24_999, s, new bytes(65));
        _signAccount(op, payerKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                uint256(0),
                "AA33 reverted",
                abi.encodeWithSelector(XgasDevPaymaster.PostOpGasLimitTooLow.selector, uint256(24_999), uint256(25_000))
            )
        );
        _handle(op);
    }

    /// @dev ERC-7677 stub data: a dummy 65-byte signature must not revert validation (it reports sigFailed) and
    ///      must return the real context, so bundler gas estimation includes postOp.
    function test_StubSignature_DoesNotRevertValidation() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        bytes[3] memory stubs = [
            new bytes(65), // all zero: ecrecover error path
            abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(27)), // well formed, wrong signer
            abi.encodePacked(bytes32(type(uint256).max), bytes32(type(uint256).max), uint8(28)) // high s
        ];
        for (uint256 i; i < stubs.length; i++) {
            op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, s, stubs[i]);
            vm.prank(address(ep));
            (bytes memory context, uint256 validationData) = pm.validatePaymasterUserOp(op, bytes32("h"), 1 ether);
            assertEq(validationData & 1, 1, "sigFailed");
            assertEq(uint48(validationData >> 160), s.validUntil);
            assertEq(uint48(validationData >> 208), s.validAfter);
            assertEq(context, abi.encode(op.sender, bytes32("h"), s.payer, s.maxCharge));
        }
    }

    function test_ValidationData_PacksWindowOnSuccess() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        _sponsor(op, pm, signerKey, s);
        vm.prank(address(ep));
        (, uint256 validationData) = pm.validatePaymasterUserOp(op, bytes32(0), 1 ether);
        assertEq(validationData, (uint256(s.validAfter) << 208) | (uint256(s.validUntil) << 160));
    }

    // ------------------------------------------------------------------------ griefing: reverting user ops

    function test_Griefing_RevertingCallStillCharged() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.boom, ()));
        uint256 depositBefore = pm.getDeposit();
        vm.recordLogs();
        _handle(op);
        (Charged memory c, OpEvent memory o) = _decode(vm.getRecordedLogs(), address(pm));

        assertTrue(c.found, "debit event emitted even though the call reverted");
        assertFalse(c.succeeded);
        assertFalse(o.success);
        assertEq(c.robinhoodPayer, payer);
        assertEq(c.maxXgasDevCharge, 5e18);
        assertGt(c.actualGasCost, 0);
        assertLe(c.actualGasCost, o.actualGasCost);
        assertLe(o.actualGasCost, _maxCost(op), "never more than the signed gas limits allow");
        assertEq(depositBefore - pm.getDeposit(), o.actualGasCost);
        assertGt(op.sender.code.length, 0, "account creation kept even though the call reverted");
    }

    function test_Griefing_GasBurningCallBoundedBySignedLimits() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.burn, ()));
        uint256 depositBefore = pm.getDeposit();
        vm.recordLogs();
        _handle(op);
        (Charged memory c, OpEvent memory o) = _decode(vm.getRecordedLogs(), address(pm));

        assertTrue(c.found);
        assertFalse(c.succeeded);
        assertFalse(o.success);
        // the whole callGasLimit is burned, and still the charge stays within the signed maximum
        assertGt(c.actualGasCost, CALL_GAS * c.actualUserOpFeePerGas);
        assertLe(o.actualGasCost, _maxCost(op));
        assertEq(depositBefore - pm.getDeposit(), o.actualGasCost);
    }

    function test_Griefing_ReusingApprovalAfterRevertFailsNonce() public {
        _handle(_sponsoredOp(abi.encodeCall(Target.inc, ()))); // deploy the account first
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.boom, ()));
        _handle(op);
        _expectFailedOp("AA25 invalid account nonce");
        _handle(op);
    }

    function test_DepositTooLow_RevertsAA31() public {
        uint256 all = pm.getDeposit();
        vm.prank(pmOwner);
        pm.withdrawTo(payable(pmOwner), all);
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        _expectFailedOp("AA31 paymaster deposit too low");
        _handle(op);
    }

    // ------------------------------------------------------------------------------------------------- admin

    function test_Pause_BlocksNewOps_UnpauseRestores() public {
        vm.prank(pmOwner);
        pm.pause();
        assertTrue(pm.paused());
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                uint256(0),
                "AA33 reverted",
                abi.encodeWithSelector(XgasDevPaymaster.PaymasterPaused.selector)
            )
        );
        _handle(op);

        vm.prank(pmOwner);
        pm.unpause();
        _handle(op);
        assertEq(target.count(), 1);
    }

    function test_Pause_SignerCanPauseButNotUnpause() public {
        vm.prank(signerAddr);
        pm.pause();
        assertTrue(pm.paused());
        vm.prank(signerAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signerAddr));
        pm.unpause();
    }

    function test_Pause_StrangerCannotPause() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(XgasDevPaymaster.NotOwnerOrSigner.selector);
        pm.pause();
    }

    function test_SignerRotation() public {
        (address newSigner, uint256 newKey) = makeAddrAndKey("newSigner");
        vm.expectEmit(address(pm));
        emit XgasDevPaymaster.SignerChanged(signerAddr, newSigner);
        vm.prank(pmOwner);
        pm.setSigner(newSigner);
        assertEq(pm.signer(), newSigner);

        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ())); // old signer
        _expectFailedOp("AA34 signature error");
        _handle(op);

        op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, newKey, _defaultSponsor());
        _signAccount(op, payerKey);
        _handle(op);
        assertEq(target.count(), 1);
    }

    function test_SetSigner_RejectsZero() public {
        vm.prank(pmOwner);
        vm.expectRevert(XgasDevPaymaster.ZeroAddress.selector);
        pm.setSigner(address(0));
    }

    function test_OnlyOwner_AdminFunctions() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        pm.setSigner(stranger);
        vm.expectRevert(err);
        pm.unpause();
        vm.expectRevert(err);
        pm.withdrawTo(payable(stranger), 1);
        vm.expectRevert(err);
        pm.addStake{value: 1}(1);
        vm.expectRevert(err);
        pm.unlockStake();
        vm.expectRevert(err);
        pm.withdrawStake(payable(stranger));
        vm.expectRevert(err);
        pm.transferOwnership(stranger);
        vm.stopPrank();
    }

    function test_RenounceOwnership_Disabled() public {
        vm.prank(pmOwner);
        vm.expectRevert(XgasDevPaymaster.RenounceDisabled.selector);
        pm.renounceOwnership();
        assertEq(pm.owner(), pmOwner);
    }

    function test_TransferOwnership_NewOwnerControls() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(pmOwner);
        pm.transferOwnership(newOwner);
        assertEq(pm.owner(), newOwner);
        vm.prank(newOwner);
        pm.setSigner(newOwner);
        assertEq(pm.signer(), newOwner);
    }

    function test_WithdrawTo_OwnerWithdrawsDeposit() public {
        address payable to = payable(makeAddr("treasury"));
        vm.prank(pmOwner);
        pm.withdrawTo(to, 4 ether);
        assertEq(to.balance, 4 ether);
        assertEq(pm.getDeposit(), 6 ether);
    }

    function test_Receive_DepositsToEntryPoint() public {
        (bool ok,) = address(pm).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(pm.getDeposit(), 12 ether);
        assertEq(address(pm).balance, 0);
    }

    function test_Stake_OwnerCanStakeUnlockWithdraw() public {
        vm.deal(pmOwner, 5 ether);
        vm.prank(pmOwner);
        pm.addStake{value: 1 ether}(86400);
        IEntryPoint.DepositInfo memory info = ep.getDepositInfo(address(pm));
        assertTrue(info.staked);
        assertEq(info.stake, 1 ether);
        assertEq(info.unstakeDelaySec, 86400);
        vm.prank(pmOwner);
        pm.unlockStake();
        vm.warp(block.timestamp + 86401);
        address payable to = payable(makeAddr("stakeOut"));
        vm.prank(pmOwner);
        pm.withdrawStake(to);
        assertEq(to.balance, 1 ether);
    }

    function test_OnlyEntryPoint_ValidateAndPostOp() public {
        PackedUserOperation memory op = _sponsoredOp(abi.encodeCall(Target.inc, ()));
        vm.expectRevert("Sender not EntryPoint");
        pm.validatePaymasterUserOp(op, bytes32(0), 1);
        vm.expectRevert("Sender not EntryPoint");
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(address(1), bytes32(0), address(2), uint256(3)), 1, 1);
    }

    function test_PostOp_EmitsFromContextForBothModes() public {
        bytes memory ctx = abi.encode(address(0xA11CE), bytes32("op"), address(0xB0B), uint256(7e18));
        vm.expectEmit(address(pm));
        emit XgasDevPaymaster.XgasDevGasCharged(bytes32("op"), address(0xA11CE), address(0xB0B), 123, 4, 7e18, true);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, ctx, 123, 4);

        vm.expectEmit(address(pm));
        emit XgasDevPaymaster.XgasDevGasCharged(bytes32("op"), address(0xA11CE), address(0xB0B), 9, 1, 7e18, false);
        vm.prank(address(ep));
        pm.postOp(IPaymaster.PostOpMode.opReverted, ctx, 9, 1);
    }

    // ---------------------------------------------------------------------------------------- hash spec

    /// @dev The off-chain recipe (what server/paymaster must reproduce), checked against the contract.
    function _offchainHash(
        PackedUserOperation memory op,
        uint256 chainId,
        address paymaster,
        uint48 validUntil,
        uint48 validAfter,
        uint256 maxCharge,
        address robinhoodPayer
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(_opPart(op), chainId, paymaster, validUntil, validAfter, maxCharge, robinhoodPayer));
    }

    function _opPart(PackedUserOperation memory op) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                uint256(bytes32(_slice(op.paymasterAndData, 20, 52))),
                op.preVerificationGas,
                op.gasFees
            )
        );
    }

    function test_GetHash_MatchesOffchainRecipe() public view {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, s, new bytes(65));
        assertEq(
            pm.getHash(op, s.validUntil, s.validAfter, s.maxCharge, s.payer),
            _offchainHash(op, L4, address(pm), s.validUntil, s.validAfter, s.maxCharge, s.payer)
        );
    }

    function test_ParsePaymasterAndData() public view {
        Sponsor memory s = _defaultSponsor();
        bytes memory sig = abi.encodePacked(bytes32(uint256(11)), bytes32(uint256(22)), uint8(27));
        bytes memory pnd = _pnd(address(pm), PM_POSTOP_GAS, s, sig);
        assertEq(pnd.length, 181);
        (uint48 vu, uint48 va, uint256 maxCharge, address p, bytes memory sg) = pm.parsePaymasterAndData(pnd);
        assertEq(vu, s.validUntil);
        assertEq(va, s.validAfter);
        assertEq(maxCharge, s.maxCharge);
        assertEq(p, s.payer);
        assertEq(sg, sig);
    }

    /// @dev Fixed vector for the server's JS implementation (see the constants for every input).
    function test_HashVector() public pure {
        PackedUserOperation memory op;
        op.sender = 0x1111111111111111111111111111111111111111;
        op.nonce = 7;
        op.initCode = hex"";
        op.callData = hex"b61d27f6";
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | 200_000);
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(0.01 gwei) << 128) | 0.2 gwei);
        op.paymasterAndData = abi.encodePacked(
            address(0x2222222222222222222222222222222222222222), uint128(60_000), uint128(40_000)
        );
        bytes32 h = _offchainHash(
            op,
            466302,
            0x2222222222222222222222222222222222222222,
            1_800_000_300,
            1_799_999_990,
            5e18,
            0x3333333333333333333333333333333333333333
        );
        assertEq(h, 0x9de657ce339ffbd6788ae515ddd335187daf8b89773f690ec0deef2b29c15189);
    }

    // ------------------------------------------------------------------------------------------------ fuzz

    function testFuzz_AnyTamperedChargeOrPayerFails(uint256 maxCharge, address otherPayer) public {
        Sponsor memory s = _defaultSponsor();
        vm.assume(maxCharge != s.maxCharge && otherPayer != s.payer);
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, s);
        bytes memory sig = _slice(op.paymasterAndData, 116, 181);
        Sponsor memory t = s;
        if (maxCharge % 2 == 0) t.maxCharge = maxCharge;
        else t.payer = otherPayer;
        op.paymasterAndData = _pnd(address(pm), PM_POSTOP_GAS, t, sig);
        _signAccount(op, payerKey);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    function testFuzz_WindowEnforced(uint32 until, uint32 afterOffset) public {
        until = uint32(bound(until, 1, 3600));
        afterOffset = uint32(bound(afterOffset, 0, 3600));
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        s.validUntil = uint48(block.timestamp + until);
        s.validAfter = uint48(block.timestamp - afterOffset);
        _sponsor(op, pm, signerKey, s);
        _signAccount(op, payerKey);
        vm.warp(block.timestamp + until + 1);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
        vm.warp(block.timestamp - 1);
        _handle(op);
        assertEq(target.count(), 1);
    }

    /// @dev The on-chain floor is enough: an op signed with exactly MIN_POSTOP_GAS runs postOp and emits the debit.
    function test_MinPostOpGas_IsSufficientEndToEnd() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        Sponsor memory s = _defaultSponsor();
        uint128 minGas = uint128(pm.MIN_POSTOP_GAS());
        op.paymasterAndData = _pnd(address(pm), minGas, s, new bytes(65));
        bytes32 h = pm.getHash(op, s.validUntil, s.validAfter, s.maxCharge, s.payer);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(signerKey, h.toEthSignedMessageHash());
        op.paymasterAndData = _pnd(address(pm), minGas, s, abi.encodePacked(r, sg, v));
        _signAccount(op, payerKey);
        vm.recordLogs();
        _handle(op);
        (Charged memory c, OpEvent memory o) = _decode(vm.getRecordedLogs(), address(pm));
        assertTrue(c.found && c.succeeded && o.success);
        assertEq(target.count(), 1);
    }

    // ------------------------------------------------------------------------------------------ gas report

    /// @dev Smallest gas cap (500 gas steps) under which each hook still succeeds when called like the EntryPoint
    ///      calls it. Guides paymasterVerificationGasLimit / paymasterPostOpGasLimit for the server.
    function test_GasReport_ValidationAndPostOp() public {
        PackedUserOperation memory op = _op(payer, abi.encodeCall(Target.inc, ()));
        _sponsor(op, pm, signerKey, _defaultSponsor());
        bytes memory validateCall = abi.encodeCall(IPaymaster.validatePaymasterUserOp, (op, bytes32("h"), 1 ether));
        bytes memory ctx = abi.encode(op.sender, bytes32("h"), payer, uint256(5e18));
        bytes memory postOpCall =
            abi.encodeCall(IPaymaster.postOp, (IPaymaster.PostOpMode.opSucceeded, ctx, 1e12, 1e8));
        uint256 validationGas = _minGas(validateCall);
        uint256 postOpGas = _minGas(postOpCall);
        emit log_named_uint("paymaster validation gas (min cap)", validationGas);
        emit log_named_uint("paymaster postOp gas (min cap)", postOpGas);
        assertLt(validationGas, PM_VERIFICATION_GAS / 2);
        assertLt(postOpGas, pm.MIN_POSTOP_GAS() / 2);
    }

    function _minGas(bytes memory data) internal returns (uint256 cap) {
        for (cap = 500; cap < 200_000; cap += 500) {
            uint256 snap = vm.snapshotState();
            vm.prank(address(ep));
            (bool ok,) = address(pm).call{gas: cap}(data);
            vm.revertToState(snap);
            if (ok) return cap;
        }
        revert("no cap found");
    }
}
