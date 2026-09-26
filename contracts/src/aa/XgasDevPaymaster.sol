// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "@account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title  XgasDevPaymaster
 * @notice ERC-4337 v0.7 verifying paymaster for the xGas L4 (chain 466302). The paymaster pays the L4 gas in
 *         xMoney out of its EntryPoint deposit; the user pays for it in XGAS.DEV on Robinhood Chain (4663), which the
 *         xgas.dev server pulls with transferFrom and burns after the op lands.
 *
 *         A UserOp is sponsored only with a fresh signature from `signer` (the server's PAYMASTER_SIGNER_KEY) over
 *         the op's gas-relevant fields, this chain id, this paymaster's address, a validity window, the maximum
 *         XGAS.DEV the server may debit (`maxXgasDevCharge`) and the Robinhood address that pays (`robinhoodPayer`).
 *         postOp emits {XgasDevGasCharged} with the actual xMoney cost so the server can debit
 *         min(quote(actualCost), maxXgasDevCharge) from `robinhoodPayer`. postOp never reverts, so reverted user
 *         calls are still charged.
 *
 * paymasterAndData layout (v0.7):
 *   [  0: 20] paymaster address
 *   [ 20: 36] uint128 paymasterVerificationGasLimit
 *   [ 36: 52] uint128 paymasterPostOpGasLimit             (must be >= MIN_POSTOP_GAS)
 *   [ 52: 58] uint48  validUntil                           (0 = no expiry, discouraged)
 *   [ 58: 64] uint48  validAfter
 *   [ 64: 96] uint256 maxXgasDevCharge                     (XGAS.DEV wei, 18 dp)
 *   [ 96:116] address robinhoodPayer
 *   [116:181] bytes   signature (65 bytes, r || s || v)    = paymasterData is 129 bytes
 *
 * Signature: personal_sign (EIP-191) by `signer` over getHash(...), i.e. ecrecover(toEthSignedMessageHash(getHash)).
 *
 * ERC-7562 note: validation reads this contract's own storage (signer, paused), so bundlers running the full
 * validation rules require the paymaster to be staked in the EntryPoint (addStake).
 */
contract XgasDevPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    uint256 private constant VALID_UNTIL_OFFSET = PAYMASTER_DATA_OFFSET; // 52
    uint256 private constant VALID_AFTER_OFFSET = VALID_UNTIL_OFFSET + 6; // 58
    uint256 private constant MAX_CHARGE_OFFSET = VALID_AFTER_OFFSET + 6; // 64
    uint256 private constant PAYER_OFFSET = MAX_CHARGE_OFFSET + 32; // 96
    uint256 private constant SIGNATURE_OFFSET = PAYER_OFFSET + 20; // 116
    uint256 private constant SIGNATURE_LENGTH = 65;

    /// @notice Minimum paymasterPostOpGasLimit, so postOp (and its debit event) cannot run out of gas.
    uint256 public constant MIN_POSTOP_GAS = 25_000;

    /// @notice Address whose signature authorizes sponsorship. Packed with `paused` in one slot.
    address public signer;
    /// @notice When true, no new UserOp validates. Ops already validated still run postOp and emit their debit.
    bool public paused;

    /// @notice The debit record. `actualGasCost` is the xMoney (wei) cost measured by the EntryPoint before postOp;
    ///         the final amount taken from the deposit (postOp gas and the unused-gas penalty included) is
    ///         `actualGasCost` of the EntryPoint's UserOperationEvent in the same transaction.
    event XgasDevGasCharged(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed robinhoodPayer,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas,
        uint256 maxXgasDevCharge,
        bool succeeded
    );
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event PausedSet(bool paused, address indexed by);

    error ZeroAddress();
    error PaymasterPaused();
    error NotOwnerOrSigner();
    error InvalidPaymasterDataLength(uint256 length);
    error InvalidSignatureLength(uint256 length);
    error PostOpGasLimitTooLow(uint256 given, uint256 minimum);
    error RenounceDisabled();

    /// @param _entryPoint EntryPoint v0.7.
    /// @param _owner      Owner (deposit withdrawal, stake, signer rotation, unpause). Passed explicitly so a
    ///                    CREATE2 factory deployment does not end up owned by the factory.
    /// @param _signer     Initial sponsorship signer.
    constructor(IEntryPoint _entryPoint, address _owner, address _signer) BasePaymaster(_entryPoint) {
        if (_owner == address(0) || _signer == address(0)) revert ZeroAddress();
        if (_owner != msg.sender) _transferOwnership(_owner);
        signer = _signer;
        emit SignerChanged(address(0), _signer);
        // xMoney sent to this address before it was deployed is already here: move it into the deposit.
        if (address(this).balance > 0) _entryPoint.depositTo{value: address(this).balance}(address(this));
    }

    /// @notice Plain transfers of native xMoney are added to this paymaster's EntryPoint deposit.
    receive() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice Moves any native xMoney held by the contract itself (e.g. forced in by selfdestruct) into the deposit.
    function sweepToDeposit() external {
        uint256 bal = address(this).balance;
        if (bal > 0) entryPoint.depositTo{value: bal}(address(this));
    }

    // ----------------------------------------------------------------------------------------------------- admin

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, newSigner);
        signer = newSigner;
    }

    /// @notice Disabled: an ownerless paymaster could never withdraw its deposit or rotate its signer.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Owner or the signer (the server's hot key) can pause; only the owner can unpause.
    function pause() external {
        if (msg.sender != owner() && msg.sender != signer) revert NotOwnerOrSigner();
        paused = true;
        emit PausedSet(true, msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false, msg.sender);
    }

    // ------------------------------------------------------------------------------------------------ signing

    /**
     * @notice The hash the signer signs (with the EIP-191 prefix). Covers every UserOp field except the account
     *         signature and the paymasterData itself:
     *         opPart = keccak256(abi.encode(
     *             sender, nonce, keccak256(initCode), keccak256(callData), accountGasLimits,
     *             uint256(bytes32(paymasterAndData[20:52])),  // pmVerificationGasLimit << 128 | pmPostOpGasLimit
     *             preVerificationGas, gasFees))
     *         hash   = keccak256(abi.encode(
     *             opPart, block.chainid, address(this), validUntil, validAfter, maxXgasDevCharge, robinhoodPayer))
     *         (every value is one 32-byte word: uint48 and address are left-padded, as abi.encode does)
     */
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter,
        uint256 maxXgasDevCharge,
        address robinhoodPayer
    ) public view returns (bytes32) {
        bytes32 opPart = keccak256(
            abi.encode(
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees
            )
        );
        return keccak256(
            abi.encode(opPart, block.chainid, address(this), validUntil, validAfter, maxXgasDevCharge, robinhoodPayer)
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (
            uint48 validUntil,
            uint48 validAfter,
            uint256 maxXgasDevCharge,
            address robinhoodPayer,
            bytes calldata signature
        )
    {
        if (paymasterAndData.length < SIGNATURE_OFFSET) revert InvalidPaymasterDataLength(paymasterAndData.length);
        validUntil = uint48(bytes6(paymasterAndData[VALID_UNTIL_OFFSET:VALID_AFTER_OFFSET]));
        validAfter = uint48(bytes6(paymasterAndData[VALID_AFTER_OFFSET:MAX_CHARGE_OFFSET]));
        maxXgasDevCharge = uint256(bytes32(paymasterAndData[MAX_CHARGE_OFFSET:PAYER_OFFSET]));
        robinhoodPayer = address(bytes20(paymasterAndData[PAYER_OFFSET:SIGNATURE_OFFSET]));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    // --------------------------------------------------------------------------------------------- 4337 hooks

    /// @dev A bad signature does not revert: it returns SIG_VALIDATION_FAILED (as ERC-4337 requires for
    ///      simulation), so stub data with a dummy 65-byte signature estimates gas like the real one.
    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (paused) revert PaymasterPaused();
        uint256 postOpGas = userOp.unpackPostOpGasLimit();
        if (postOpGas < MIN_POSTOP_GAS) revert PostOpGasLimitTooLow(postOpGas, MIN_POSTOP_GAS);

        (
            uint48 validUntil,
            uint48 validAfter,
            uint256 maxXgasDevCharge,
            address robinhoodPayer,
            bytes calldata signature
        ) = parsePaymasterAndData(userOp.paymasterAndData);
        if (signature.length != SIGNATURE_LENGTH) revert InvalidSignatureLength(signature.length);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            getHash(userOp, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer)
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != signer;

        context = abi.encode(userOp.sender, userOpHash, robinhoodPayer, maxXgasDevCharge);
        validationData = _packValidationData(sigFailed, validUntil, validAfter);
    }

    /// @dev Must never revert: a reverting postOp would leave the op charged to the deposit with no debit event.
    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        // context = abi.encode(sender, userOpHash, robinhoodPayer, maxXgasDevCharge), written by validation above
        emit XgasDevGasCharged(
            _word(context, 1),
            address(uint160(uint256(_word(context, 0)))),
            address(uint160(uint256(_word(context, 2)))),
            actualGasCost,
            actualUserOpFeePerGas,
            uint256(_word(context, 3)),
            mode == PostOpMode.opSucceeded
        );
    }

    function _word(bytes calldata data, uint256 i) private pure returns (bytes32) {
        return bytes32(data[i * 32:(i + 1) * 32]);
    }
}
