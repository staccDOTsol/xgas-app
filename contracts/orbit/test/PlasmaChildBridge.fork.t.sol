// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PlasmaChild} from "../src/PlasmaChild.sol";
import {EthRollupLaunch} from "../src/EthRollupLaunch.sol";
import {StandardGatewayLaunch} from "../src/StandardGatewayLaunch.sol";
import {L1ERC20Gateway} from "token-bridge/tokenbridge/ethereum/gateway/L1ERC20Gateway.sol";
import {L1GatewayRouter} from "token-bridge/tokenbridge/ethereum/gateway/L1GatewayRouter.sol";
import {IInbox} from "nitro-src/bridge/IInbox.sol";
import {ISequencerInbox} from "nitro-src/bridge/ISequencerInbox.sol";
import {IGasRefunder} from "nitro-src/libraries/IGasRefunder.sol";
import {IOutbox} from "nitro-src/bridge/IOutbox.sol";
import {IBridge} from "nitro-src/bridge/IBridge.sol";
import {IRollupUser} from "nitro-src/rollup/IRollupLogic.sol";
import {RollupLib} from "nitro-src/rollup/RollupLib.sol";
import {AssertionInputs, AssertionState, ConfigData} from "nitro-src/rollup/Assertion.sol";
import {GlobalState} from "nitro-src/state/GlobalState.sol";
import {MachineStatus} from "nitro-src/state/Machine.sol";
import {ITokenGateway} from "token-bridge/tokenbridge/libraries/gateway/ITokenGateway.sol";

interface IWXPL {
    function deposit() external payable;
}

/// @notice Plasma mainnet fork. No broadcast.
///         Deposits and withdrawals for XPL (Inbox/Outbox value), USDT0, and Circle USDC.
contract PlasmaChildBridgeForkTest is Test {
    using SafeERC20 for IERC20;

    address constant USDT0_WHALE = 0x8741B106e9738a6971AD07DABCFe95FF66337b51;
    address constant USDC_WHALE = 0x622C27D929Cd68E4555530043d90C0745d7F7A36;

    uint256 constant TOKEN_AMOUNT = 1_000_000; // 1.0 of a 6-decimal stable
    uint256 constant XPL_IN = 0.2 ether;
    uint256 constant MAX_GAS = 100_000;
    uint256 constant GAS_PRICE_BID = 100;
    uint64 constant L2_BLOCK = 42;
    uint64 constant L1_BLOCK = 7;
    uint64 constant L2_TIME = 1_700_000_000;

    EthRollupLaunch.Result rollup;
    L1ERC20Gateway gateway;
    L1GatewayRouter router;

    address validator = makeAddr("validator");
    address poster = makeAddr("poster");
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.createSelectFork(PlasmaChild.PARENT_RPC);
        assertEq(block.chainid, PlasmaChild.PARENT_CHAIN_ID);
        assertEq(_symbol(PlasmaChild.USDC), "USDC");
        assertEq(_symbol(PlasmaChild.USDT0), "USDT0");
        assertEq(_decimals(PlasmaChild.USDT0), 6);
        assertEq(_decimals(PlasmaChild.USDC), 6);

        uint256 gasBefore = gasleft();
        rollup = EthRollupLaunch.deploy(
            EthRollupLaunch.Params({
                owner: owner,
                stakeToken: PlasmaChild.WXPL,
                loserStakeEscrow: makeAddr("escrow"),
                validator: validator,
                batchPoster: poster,
                batchPosterManager: owner,
                chainId: PlasmaChild.CHAIN_ID,
                confirmPeriodBlocks: 1,
                minimumAssertionPeriod: 0,
                wasmModuleRoot: keccak256("xgas-plasma-child-v1"),
                chainConfig: _chainConfig(),
                nativeToken: address(0)
            })
        );
        uint256 templatesAndCreate = gasBefore - gasleft();
        console.log("template+createRollup gas", templatesAndCreate);
        console.log("createRollup gas", rollup.createRollupGas);
        console.log("heaviest template gas", rollup.heaviestTemplateGas);
        console.log("plasma block gas limit", block.gaslimit);
        assertLt(rollup.heaviestTemplateGas, 36_000_000, "a template deploy exceeds Plasma's block gas limit");
        assertLt(rollup.createRollupGas, 36_000_000, "createRollup exceeds Plasma's block gas limit");

        StandardGatewayLaunch gateways = new StandardGatewayLaunch();
        StandardGatewayLaunch.Result memory g = gateways.deploy(
            rollup.inbox,
            PlasmaChild.L2_ERC20_GATEWAY,
            PlasmaChild.L2_GATEWAY_ROUTER,
            PlasmaChild.L2_BEACON_PROXY_FACTORY,
            owner
        );
        gateway = g.gateway;
        router = g.router;

        vm.prank(USDT0_WHALE);
        IERC20(PlasmaChild.USDT0).safeTransfer(alice, TOKEN_AMOUNT);
        vm.prank(USDC_WHALE);
        IERC20(PlasmaChild.USDC).safeTransfer(alice, TOKEN_AMOUNT);
    }

    function test_depositAndWithdraw_xplUsdt0Usdc() public {
        uint256 bridgeBefore = rollup.bridge.balance;
        uint256 aliceBefore = alice.balance;

        vm.deal(alice, aliceBefore + XPL_IN);
        vm.prank(alice, alice);
        uint256 g = gasleft();
        IInbox(rollup.inbox).depositEth{value: XPL_IN}();
        uint256 xplDepositGas = g - gasleft();
        assertEq(rollup.bridge.balance - bridgeBefore, XPL_IN, "XPL not escrowed in bridge");

        uint256 usdt0Gas = _depositToken(PlasmaChild.USDT0);
        uint256 usdcGas = _depositToken(PlasmaChild.USDC);
        assertEq(IERC20(PlasmaChild.USDT0).balanceOf(address(gateway)), TOKEN_AMOUNT, "USDT0 escrow");
        assertEq(IERC20(PlasmaChild.USDC).balanceOf(address(gateway)), TOKEN_AMOUNT, "USDC escrow");
        assertEq(IERC20(PlasmaChild.USDT0).balanceOf(alice), 0);
        assertEq(IERC20(PlasmaChild.USDC).balanceOf(alice), 0);

        uint256 batchGas = _postCalldataBatch();
        bool blobsRevert = _blobsRevert();

        bytes32 sendRoot = _confirmWithdrawalRoot();

        uint256 xplOutGas = _executeXpl();
        uint256 usdt0OutGas = _executeToken(PlasmaChild.USDT0, 1);
        uint256 usdcOutGas = _executeToken(PlasmaChild.USDC, 2);

        assertEq(alice.balance, aliceBefore, "XPL withdrawn to alice");
        assertEq(IERC20(PlasmaChild.USDT0).balanceOf(alice), TOKEN_AMOUNT, "USDT0 withdrawn");
        assertEq(IERC20(PlasmaChild.USDC).balanceOf(alice), TOKEN_AMOUNT, "USDC withdrawn");
        assertEq(IERC20(PlasmaChild.USDT0).balanceOf(address(gateway)), 0);
        assertEq(IERC20(PlasmaChild.USDC).balanceOf(address(gateway)), 0);
        assertTrue(IOutbox(rollup.outbox).isSpent(0));
        assertTrue(IOutbox(rollup.outbox).isSpent(1));
        assertTrue(IOutbox(rollup.outbox).isSpent(2));
        assertEq(IOutbox(rollup.outbox).roots(sendRoot), bytes32(uint256(1)));

        address usdt0L2 = gateway.calculateL2TokenAddress(PlasmaChild.USDT0);
        address usdcL2 = gateway.calculateL2TokenAddress(PlasmaChild.USDC);
        assertTrue(usdt0L2 != address(0) && usdcL2 != address(0) && usdt0L2 != usdcL2);

        console.log("xpl deposit gas", xplDepositGas);
        console.log("usdt0 deposit gas", usdt0Gas);
        console.log("usdc deposit gas", usdcGas);
        console.log("calldata batch gas", batchGas);
        console.log("blob batch reverted", blobsRevert);
        console.log("xpl withdraw gas", xplOutGas);
        console.log("usdt0 withdraw gas", usdt0OutGas);
        console.log("usdc withdraw gas", usdcOutGas);
        console.log("l2 usdt0", usdt0L2);
        console.log("l2 usdc", usdcL2);
        console.log("rollup", rollup.rollup);
        console.log("inbox", rollup.inbox);
        console.log("outbox", rollup.outbox);
        console.log("bridge", rollup.bridge);
        console.log("sequencerInbox", rollup.sequencerInbox);
        console.log("gateway", address(gateway));
        console.log("router", address(router));
    }

    function _depositToken(address token) internal returns (uint256 gasUsed) {
        bytes memory hook = "";
        bytes memory outbound = gateway.getOutboundCalldata(token, alice, alice, TOKEN_AMOUNT, hook);
        uint256 fee = IInbox(rollup.inbox).calculateRetryableSubmissionFee(outbound.length, 0);
        bytes memory userData = abi.encode(fee, hook);
        uint256 value = fee + MAX_GAS * GAS_PRICE_BID;
        vm.deal(alice, alice.balance + value);
        vm.startPrank(alice);
        IERC20(token).safeApprove(address(gateway), TOKEN_AMOUNT);
        uint256 g = gasleft();
        router.outboundTransfer{value: value}(token, alice, TOKEN_AMOUNT, MAX_GAS, GAS_PRICE_BID, userData);
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function _postCalldataBatch() internal returns (uint256 gasUsed) {
        ISequencerInbox seq = ISequencerInbox(rollup.sequencerInbox);
        uint256 delayed = seq.totalDelayedMessagesRead();
        vm.prank(poster);
        uint256 g = gasleft();
        seq.addSequencerL2Batch(type(uint256).max, "", delayed, IGasRefunder(address(0)), 1, 2);
        gasUsed = g - gasleft();
        assertGt(IBridge(rollup.bridge).sequencerMessageCount(), rollup.genesisNextInbox);
    }

    function _blobsRevert() internal returns (bool reverted) {
        ISequencerInbox seq = ISequencerInbox(rollup.sequencerInbox);
        uint256 delayed = seq.totalDelayedMessagesRead();
        vm.prank(poster);
        try seq.addSequencerL2BatchFromBlobs(type(uint256).max, delayed, IGasRefunder(address(0)), 2, 3) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assertTrue(reverted, "blob batch should revert with the dummy Reader4844");
    }

    function _confirmWithdrawalRoot() internal returns (bytes32 sendRoot) {
        IOutbox outbox = IOutbox(rollup.outbox);
        bytes32 xplItem = outbox.calculateItemHash(alice, alice, L2_BLOCK, L1_BLOCK, L2_TIME, XPL_IN, "");
        bytes32 usdt0Item = outbox.calculateItemHash(
            PlasmaChild.L2_ERC20_GATEWAY, address(gateway), L2_BLOCK, L1_BLOCK, L2_TIME, 0, _tokenData(PlasmaChild.USDT0, 1)
        );
        bytes32 usdcItem = outbox.calculateItemHash(
            PlasmaChild.L2_ERC20_GATEWAY, address(gateway), L2_BLOCK, L1_BLOCK, L2_TIME, 0, _tokenData(PlasmaChild.USDC, 2)
        );
        bytes32 dustItem = outbox.calculateItemHash(address(1), address(2), L2_BLOCK, L1_BLOCK, L2_TIME, 0, "");

        bytes32 a = keccak256(abi.encodePacked(xplItem));
        bytes32 b = keccak256(abi.encodePacked(usdt0Item));
        bytes32 c = keccak256(abi.encodePacked(usdcItem));
        bytes32 d = keccak256(abi.encodePacked(dustItem));
        bytes32 left = keccak256(abi.encodePacked(a, b));
        bytes32 right = keccak256(abi.encodePacked(c, d));
        sendRoot = keccak256(abi.encodePacked(left, right));

        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = b;
        proof0[1] = right;
        assertEq(outbox.calculateMerkleRoot(proof0, 0, xplItem), sendRoot);

        _stakeAndConfirm(sendRoot);
    }

    function _stakeAndConfirm(bytes32 sendRoot) internal {
        uint256 stake = 1e15;
        vm.deal(validator, stake);
        vm.startPrank(validator);
        IWXPL(PlasmaChild.WXPL).deposit{value: stake}();
        IERC20(PlasmaChild.WXPL).safeApprove(rollup.rollup, stake);

        AssertionInputs memory inputs;
        inputs.beforeStateData.prevPrevAssertionHash = bytes32(0);
        inputs.beforeStateData.sequencerBatchAcc = bytes32(0);
        inputs.beforeStateData.configData = _genesisConfig();
        inputs.beforeState = _emptyFinished();
        inputs.afterState = AssertionState({
            globalState: GlobalState({
                bytes32Vals: [bytes32(uint256(1)), sendRoot],
                u64Vals: [rollup.genesisNextInbox, uint64(0)]
            }),
            machineStatus: MachineStatus.FINISHED,
            endHistoryRoot: bytes32(0)
        });

        IRollupUser roll = IRollupUser(rollup.rollup);
        bytes32 prev = roll.latestConfirmed();
        bytes32 inboxAcc = IBridge(rollup.bridge).sequencerInboxAccs(rollup.genesisNextInbox - 1);
        roll.newStakeOnNewAssertion(stake, inputs, bytes32(0), validator);
        vm.stopPrank();

        vm.roll(block.number + 1);
        bytes32 created = RollupLib.assertionHash(prev, inputs.afterState, inboxAcc);
        vm.prank(validator);
        roll.confirmAssertion(created, prev, inputs.afterState, bytes32(0), inputs.beforeStateData.configData, inboxAcc);
    }

    function _executeXpl() internal returns (uint256 gasUsed) {
        bytes32[] memory proof = _proof(0);
        uint256 g = gasleft();
        IOutbox(rollup.outbox).executeTransaction(proof, 0, alice, alice, L2_BLOCK, L1_BLOCK, L2_TIME, XPL_IN, "");
        gasUsed = g - gasleft();
    }

    function _executeToken(address token, uint256 index) internal returns (uint256 gasUsed) {
        bytes32[] memory proof = _proof(index);
        bytes memory data = _tokenData(token, index);
        uint256 g = gasleft();
        IOutbox(rollup.outbox).executeTransaction(
            proof, index, PlasmaChild.L2_ERC20_GATEWAY, address(gateway), L2_BLOCK, L1_BLOCK, L2_TIME, 0, data
        );
        gasUsed = g - gasleft();
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory proof) {
        IOutbox outbox = IOutbox(rollup.outbox);
        bytes32 xplItem = outbox.calculateItemHash(alice, alice, L2_BLOCK, L1_BLOCK, L2_TIME, XPL_IN, "");
        bytes32 usdt0Item = outbox.calculateItemHash(
            PlasmaChild.L2_ERC20_GATEWAY, address(gateway), L2_BLOCK, L1_BLOCK, L2_TIME, 0, _tokenData(PlasmaChild.USDT0, 1)
        );
        bytes32 usdcItem = outbox.calculateItemHash(
            PlasmaChild.L2_ERC20_GATEWAY, address(gateway), L2_BLOCK, L1_BLOCK, L2_TIME, 0, _tokenData(PlasmaChild.USDC, 2)
        );
        bytes32 dustItem = outbox.calculateItemHash(address(1), address(2), L2_BLOCK, L1_BLOCK, L2_TIME, 0, "");
        bytes32 a = keccak256(abi.encodePacked(xplItem));
        bytes32 b = keccak256(abi.encodePacked(usdt0Item));
        bytes32 c = keccak256(abi.encodePacked(usdcItem));
        bytes32 d = keccak256(abi.encodePacked(dustItem));
        bytes32 left = keccak256(abi.encodePacked(a, b));
        bytes32 right = keccak256(abi.encodePacked(c, d));
        proof = new bytes32[](2);
        if (index == 0) {
            proof[0] = b;
            proof[1] = right;
        } else if (index == 1) {
            proof[0] = a;
            proof[1] = right;
        } else {
            proof[0] = d;
            proof[1] = left;
        }
    }

    function _tokenData(address token, uint256 exitNum) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            ITokenGateway.finalizeInboundTransfer.selector,
            token,
            alice,
            alice,
            TOKEN_AMOUNT,
            abi.encode(exitNum, bytes(""))
        );
    }

    function _genesisConfig() internal view returns (ConfigData memory) {
        IRollupUser roll = IRollupUser(rollup.rollup);
        return ConfigData({
            wasmModuleRoot: roll.wasmModuleRoot(),
            requiredStake: roll.baseStake(),
            challengeManager: address(roll.challengeManager()),
            confirmPeriodBlocks: roll.confirmPeriodBlocks(),
            nextInboxPosition: rollup.genesisNextInbox
        });
    }

    function _emptyFinished() internal pure returns (AssertionState memory) {
        return AssertionState({
            globalState: GlobalState({bytes32Vals: [bytes32(0), bytes32(0)], u64Vals: [uint64(0), uint64(0)]}),
            machineStatus: MachineStatus.FINISHED,
            endHistoryRoot: bytes32(0)
        });
    }

    function _chainConfig() internal pure returns (string memory) {
        return '{"chainId":974502,"arbitrum":{"EnableArbOS":true,"DataAvailabilityCommittee":false,"InitialArbOSVersion":51}}';
    }

    function _symbol(address token) internal view returns (string memory) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok && data.length >= 64, "symbol");
        return abi.decode(data, (string));
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && data.length >= 32, "decimals");
        return abi.decode(data, (uint8));
    }
}
