// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RollupCreator} from "nitro-src/rollup/RollupCreator.sol";
import {RollupAdminLogic} from "nitro-src/rollup/RollupAdminLogic.sol";
import {RollupUserLogic} from "nitro-src/rollup/RollupUserLogic.sol";
import {BridgeCreator} from "nitro-src/rollup/BridgeCreator.sol";
import {DeployHelper} from "nitro-src/rollup/DeployHelper.sol";
import {ValidatorWalletCreator} from "nitro-src/rollup/ValidatorWalletCreator.sol";
import {Bridge} from "nitro-src/bridge/Bridge.sol";
import {SequencerInbox} from "nitro-src/bridge/SequencerInbox.sol";
import {Inbox} from "nitro-src/bridge/Inbox.sol";
import {Outbox} from "nitro-src/bridge/Outbox.sol";
import {RollupEventInbox} from "nitro-src/rollup/RollupEventInbox.sol";
import {ERC20Bridge} from "nitro-src/bridge/ERC20Bridge.sol";
import {ERC20Inbox} from "nitro-src/bridge/ERC20Inbox.sol";
import {ERC20Outbox} from "nitro-src/bridge/ERC20Outbox.sol";
import {ERC20RollupEventInbox} from "nitro-src/rollup/ERC20RollupEventInbox.sol";
import {ISequencerInbox, IFeeTokenPricer} from "nitro-src/bridge/ISequencerInbox.sol";
import {IReader4844} from "nitro-src/libraries/IReader4844.sol";
import {IRollupAdmin} from "nitro-src/rollup/IRollupAdmin.sol";
import {IRollupUser} from "nitro-src/rollup/IRollupLogic.sol";
import {IOneStepProofEntry} from "nitro-src/osp/IOneStepProofEntry.sol";
import {OneStepProofEntry} from "nitro-src/osp/OneStepProofEntry.sol";
import {OneStepProver0} from "nitro-src/osp/OneStepProver0.sol";
import {OneStepProverMemory} from "nitro-src/osp/OneStepProverMemory.sol";
import {OneStepProverMath} from "nitro-src/osp/OneStepProverMath.sol";
import {OneStepProverHostIo} from "nitro-src/osp/OneStepProverHostIo.sol";
import {EdgeChallengeManager} from "nitro-src/challengeV2/EdgeChallengeManager.sol";
import {IEdgeChallengeManager} from "nitro-src/challengeV2/IEdgeChallengeManager.sol";
import {UpgradeExecutorMock} from "nitro-src/mocks/UpgradeExecutorMock.sol";
import {Config, AssertionState} from "nitro-src/rollup/Config.sol";
import {GlobalState} from "nitro-src/state/GlobalState.sol";
import {MachineStatus} from "nitro-src/state/Machine.sol";
import {BufferConfig} from "nitro-src/bridge/DelayBufferTypes.sol";
import {IBridge} from "nitro-src/bridge/IBridge.sol";
import {RollupCore} from "nitro-src/rollup/RollupCore.sol";

/// @notice Deploys an ETH-style (native parent gas) Orbit rollup.
///         `nativeToken` is address(0): the child gas token is the parent's
///         native coin. On Plasma that coin is XPL. Custom-gas ERC20Inbox
///         templates are still deployed because RollupCreator.setTemplates
///         checks both template sets, and they are not selected.
///
///         This is a library so each `new` is performed by the caller. A
///         Foundry script therefore broadcasts one transaction per template,
///         which is what fits in Plasma's 36_000_000 block gas limit.
///         `createRollup` itself stays one transaction.
library EthRollupLaunch {
    struct Params {
        address owner;
        address stakeToken;
        address loserStakeEscrow;
        address validator;
        address batchPoster;
        address batchPosterManager;
        uint256 chainId;
        uint64 confirmPeriodBlocks;
        uint256 minimumAssertionPeriod;
        bytes32 wasmModuleRoot;
        string chainConfig;
    }

    struct Result {
        RollupCreator rollupCreator;
        address rollup;
        address bridge;
        address inbox;
        address sequencerInbox;
        address outbox;
        uint64 genesisNextInbox;
        uint256 createRollupGas;
        uint256 heaviestTemplateGas;
    }

    uint256 public constant MAX_DATA_SIZE = 117_964;

    function deploy(Params memory p) internal returns (Result memory r) {
        IReader4844 reader = IReader4844(address(137));
        (BridgeCreator.BridgeTemplates memory ethTemplates, uint256 ethHeavy) = _ethTemplates(reader);
        (BridgeCreator.BridgeTemplates memory ercTemplates, uint256 ercHeavy) = _ercTemplates(reader);
        r.heaviestTemplateGas = _max(ethHeavy, ercHeavy);
        uint256 logicHeavy;
        (r.rollupCreator, logicHeavy) = _installCreator(ethTemplates, ercTemplates);
        r.heaviestTemplateGas = _max(r.heaviestTemplateGas, logicHeavy);

        uint256 gasBefore = gasleft();
        r.rollup = r.rollupCreator.createRollup(_params(p));
        r.createRollupGas = gasBefore - gasleft();

        RollupCore core = RollupCore(r.rollup);
        r.bridge = address(core.bridge());
        r.inbox = address(core.inbox());
        r.sequencerInbox = address(core.sequencerInbox());
        r.outbox = address(core.outbox());
        r.genesisNextInbox = uint64(IBridge(r.bridge).sequencerMessageCount());
    }

    function _ethTemplates(IReader4844 reader)
        private
        returns (BridgeCreator.BridgeTemplates memory templates, uint256 heavy)
    {
        uint256 step = gasleft();
        Bridge bridge = new Bridge();
        heavy = step - gasleft();
        step = gasleft();
        SequencerInbox seq = new SequencerInbox(MAX_DATA_SIZE, reader, false, false);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        SequencerInbox seqDelay = new SequencerInbox(MAX_DATA_SIZE, reader, false, true);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        Inbox inbox = new Inbox(MAX_DATA_SIZE);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        RollupEventInbox events = new RollupEventInbox();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        Outbox outbox = new Outbox();
        heavy = _max(heavy, step - gasleft());
        templates = BridgeCreator.BridgeTemplates({
            bridge: bridge,
            sequencerInbox: seq,
            delayBufferableSequencerInbox: seqDelay,
            inbox: inbox,
            rollupEventInbox: events,
            outbox: outbox
        });
    }

    function _ercTemplates(IReader4844 reader)
        private
        returns (BridgeCreator.BridgeTemplates memory templates, uint256 heavy)
    {
        uint256 step = gasleft();
        ERC20Bridge bridge = new ERC20Bridge();
        heavy = step - gasleft();
        step = gasleft();
        SequencerInbox seq = new SequencerInbox(MAX_DATA_SIZE, reader, true, false);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        SequencerInbox seqDelay = new SequencerInbox(MAX_DATA_SIZE, reader, true, true);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        ERC20Inbox inbox = new ERC20Inbox(MAX_DATA_SIZE);
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        ERC20RollupEventInbox events = new ERC20RollupEventInbox();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        ERC20Outbox outbox = new ERC20Outbox();
        heavy = _max(heavy, step - gasleft());
        templates = BridgeCreator.BridgeTemplates({
            bridge: bridge,
            sequencerInbox: seq,
            delayBufferableSequencerInbox: seqDelay,
            inbox: inbox,
            rollupEventInbox: events,
            outbox: outbox
        });
    }

    function _installCreator(
        BridgeCreator.BridgeTemplates memory ethTemplates,
        BridgeCreator.BridgeTemplates memory ercTemplates
    ) private returns (RollupCreator creator, uint256 heavy) {
        uint256 step = gasleft();
        creator = new RollupCreator();
        heavy = step - gasleft();
        step = gasleft();
        BridgeCreator bridgeCreator = new BridgeCreator(ethTemplates, ercTemplates);
        heavy = _max(heavy, step - gasleft());
        (IOneStepProofEntry osp, uint256 ospHeavy) = _osp();
        heavy = _max(heavy, ospHeavy);
        (IEdgeChallengeManager challenge, uint256 challengeHeavy) = _challenge();
        heavy = _max(heavy, challengeHeavy);
        (IRollupAdmin admin, IRollupUser user, uint256 logicHeavy) = _rollupLogic();
        heavy = _max(heavy, logicHeavy);
        (UpgradeExecutorMock executor, ValidatorWalletCreator wallets, DeployHelper helper, uint256 tailHeavy) =
            _tail();
        heavy = _max(heavy, tailHeavy);
        creator.setTemplates(bridgeCreator, osp, challenge, admin, user, executor, address(wallets), helper);
    }

    function _osp() private returns (IOneStepProofEntry osp, uint256 heavy) {
        uint256 step = gasleft();
        OneStepProver0 prover0 = new OneStepProver0();
        heavy = step - gasleft();
        step = gasleft();
        OneStepProverMemory proverMem = new OneStepProverMemory();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        OneStepProverMath proverMath = new OneStepProverMath();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        OneStepProverHostIo proverHost = new OneStepProverHostIo();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        osp = new OneStepProofEntry(prover0, proverMem, proverMath, proverHost);
        heavy = _max(heavy, step - gasleft());
    }

    function _challenge() private returns (IEdgeChallengeManager challenge, uint256 heavy) {
        uint256 step = gasleft();
        challenge = new EdgeChallengeManager();
        heavy = step - gasleft();
    }

    function _rollupLogic() private returns (IRollupAdmin admin, IRollupUser user, uint256 heavy) {
        uint256 step = gasleft();
        admin = new RollupAdminLogic();
        heavy = step - gasleft();
        step = gasleft();
        user = new RollupUserLogic();
        heavy = _max(heavy, step - gasleft());
    }

    function _tail()
        private
        returns (UpgradeExecutorMock executor, ValidatorWalletCreator wallets, DeployHelper helper, uint256 heavy)
    {
        uint256 step = gasleft();
        executor = new UpgradeExecutorMock();
        heavy = step - gasleft();
        step = gasleft();
        wallets = new ValidatorWalletCreator();
        heavy = _max(heavy, step - gasleft());
        step = gasleft();
        helper = new DeployHelper();
        heavy = _max(heavy, step - gasleft());
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }

    function _params(Params memory p) internal pure returns (RollupCreator.RollupDeploymentParams memory) {
        ISequencerInbox.MaxTimeVariation memory timeVars = ISequencerInbox.MaxTimeVariation({
            delayBlocks: (60 * 60 * 24) / 15,
            futureBlocks: 12,
            delaySeconds: 60 * 60 * 24,
            futureSeconds: 60 * 60
        });
        uint256[] memory miniStakeValues = new uint256[](3);
        miniStakeValues[0] = 1;
        miniStakeValues[1] = 2;
        miniStakeValues[2] = 3;
        AssertionState memory genesis = AssertionState({
            globalState: GlobalState({bytes32Vals: [bytes32(0), bytes32(0)], u64Vals: [uint64(0), uint64(0)]}),
            machineStatus: MachineStatus.FINISHED,
            endHistoryRoot: bytes32(0)
        });
        address[] memory validators = new address[](1);
        validators[0] = p.validator;
        address[] memory posters = new address[](1);
        posters[0] = p.batchPoster;

        Config memory config = Config({
            baseStake: 1e15,
            chainId: p.chainId,
            chainConfig: p.chainConfig,
            minimumAssertionPeriod: p.minimumAssertionPeriod,
            validatorAfkBlocks: 201_600,
            confirmPeriodBlocks: p.confirmPeriodBlocks,
            owner: p.owner,
            sequencerInboxMaxTimeVariation: timeVars,
            stakeToken: p.stakeToken,
            wasmModuleRoot: p.wasmModuleRoot,
            loserStakeEscrow: p.loserStakeEscrow,
            genesisAssertionState: genesis,
            genesisInboxCount: 0,
            miniStakeValues: miniStakeValues,
            layerZeroBlockEdgeHeight: 2 ** 5,
            layerZeroBigStepEdgeHeight: 2 ** 5,
            layerZeroSmallStepEdgeHeight: 2 ** 5,
            anyTrustFastConfirmer: address(0),
            numBigStepLevel: 1,
            challengeGracePeriodBlocks: 10,
            bufferConfig: BufferConfig({threshold: 600, max: 14_400, replenishRateInBasis: 500})
        });

        return RollupCreator.RollupDeploymentParams({
            config: config,
            batchPosters: posters,
            validators: validators,
            maxDataSize: MAX_DATA_SIZE,
            nativeToken: address(0),
            deployFactoriesToL2: false,
            maxFeePerGasForRetryables: 0,
            batchPosterManager: p.batchPosterManager,
            feeTokenPricer: IFeeTokenPricer(address(0))
        });
    }
}
