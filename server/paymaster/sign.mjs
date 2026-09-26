// The XgasDevPaymaster wire format: paymasterData layout, the hash the signer signs, and the ERC-7677 user
// operation parsing that feeds it. contracts/src/aa/XgasDevPaymaster.sol is the source of truth; spec.md restates
// it, this file is its only implementation on the server, and test/sign.test.mjs pins it with fixed vectors.
import {
  concat, encodeAbiParameters, encodePacked, getAddress, hexToBigInt, isAddress, isHex, keccak256, numberToHex, pad,
  recoverMessageAddress, size, slice, decodeFunctionData, parseAbi,
} from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';

export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const PAYMASTER_DATA_LENGTH = 129;            // 6 + 6 + 32 + 20 + 65
export const PAYMASTER_AND_DATA_LENGTH = 52 + PAYMASTER_DATA_LENGTH;
// Well formed (low s, v = 28), recovers to an unrelated address. Bundlers estimate with it; the contract returns
// SIG_VALIDATION_FAILED for it instead of reverting.
export const STUB_SIGNATURE = `0x${'f'.repeat(31)}0${'0'.repeat(32)}7${'a'.repeat(63)}1c`; // r | s (low) | v = 28

const U48_MAX = (1n << 48n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

export class PaymasterInputError extends Error {
  constructor(message) { super(message); this.name = 'PaymasterInputError'; }
}

function num(v, name, max = U256_MAX, dflt) {
  if (v === undefined || v === null || v === '') {
    if (dflt !== undefined) return dflt;
    throw new PaymasterInputError(`userOp.${name} is missing`);
  }
  let b;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) b = BigInt(v);
  else if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) b = hexToBigInt(v);
  else if (typeof v === 'string' && /^0x$/.test(v)) b = 0n;
  else if (typeof v === 'string' && /^\d{1,78}$/.test(v)) b = BigInt(v);
  else throw new PaymasterInputError(`userOp.${name} is not a quantity`);
  if (b < 0n || b > max) throw new PaymasterInputError(`userOp.${name} is out of range`);
  return b;
}
function hexBytes(v, name, dflt) {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw new PaymasterInputError(`userOp.${name} is missing`);
  }
  if (typeof v !== 'string' || !isHex(v, { strict: true }) || v.length % 2) throw new PaymasterInputError(`userOp.${name} is not hex bytes`);
  return v.toLowerCase();
}
function addr(v, name) {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new PaymasterInputError(`${name} is not an address`);
  return getAddress(v);
}

/**
 * An ERC-7677 / ERC-4337 v0.7 JSON user operation (hex quantities) -> normalized bigints.
 * Accepts the unpacked RPC shape (factory/factoryData, gas fields, optional paymaster gas limits).
 */
export function parseUserOp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaymasterInputError('userOp must be an object');
  if (raw.initCode !== undefined && raw.factory === undefined) throw new PaymasterInputError('userOp looks like EntryPoint v0.6 (initCode); this paymaster is v0.7');
  const factory = raw.factory == null || raw.factory === '0x' ? null : addr(raw.factory, 'userOp.factory');
  const factoryData = factory ? hexBytes(raw.factoryData, 'factoryData', '0x') : '0x';
  return {
    sender: addr(raw.sender, 'userOp.sender'),
    nonce: num(raw.nonce, 'nonce'),
    factory,
    factoryData,
    callData: hexBytes(raw.callData, 'callData'),
    callGasLimit: num(raw.callGasLimit, 'callGasLimit', U128_MAX, 0n),
    verificationGasLimit: num(raw.verificationGasLimit, 'verificationGasLimit', U128_MAX, 0n),
    preVerificationGas: num(raw.preVerificationGas, 'preVerificationGas', U256_MAX, 0n),
    maxFeePerGas: num(raw.maxFeePerGas, 'maxFeePerGas', U128_MAX, 0n),
    maxPriorityFeePerGas: num(raw.maxPriorityFeePerGas, 'maxPriorityFeePerGas', U128_MAX, 0n),
    paymasterVerificationGasLimit: raw.paymasterVerificationGasLimit == null ? null : num(raw.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', U128_MAX),
    paymasterPostOpGasLimit: raw.paymasterPostOpGasLimit == null ? null : num(raw.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', U128_MAX),
    signature: typeof raw.signature === 'string' && isHex(raw.signature) ? raw.signature : '0x',
  };
}

export function initCodeOf(op) {
  return op.factory ? concat([op.factory, op.factoryData || '0x']) : '0x';
}
export function accountGasLimitsOf(op) {
  return concat([pad(numberToHex(op.verificationGasLimit), { size: 16 }), pad(numberToHex(op.callGasLimit), { size: 16 })]);
}
export function gasFeesOf(op) {
  return concat([pad(numberToHex(op.maxPriorityFeePerGas), { size: 16 }), pad(numberToHex(op.maxFeePerGas), { size: 16 })]);
}
/** uint256(bytes32(paymasterAndData[20:52])) */
export function paymasterGasWord(pmVerificationGasLimit, pmPostOpGasLimit) {
  return (BigInt(pmVerificationGasLimit) << 128n) | BigInt(pmPostOpGasLimit);
}

/** EntryPoint v0.7 requiredPrefund: every gas limit times maxFeePerGas. Equals the maxCost postOp context carries. */
export function requiredPrefund(op, pmVerificationGasLimit, pmPostOpGasLimit) {
  const gas = op.verificationGasLimit + op.callGasLimit + BigInt(pmVerificationGasLimit) + BigInt(pmPostOpGasLimit) + op.preVerificationGas;
  return gas * op.maxFeePerGas;
}

/** XgasDevPaymaster.getHash(userOp, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer):
 *  opPart = keccak256(abi.encode(sender, nonce, keccak256(initCode), keccak256(callData), accountGasLimits,
 *                                uint256(bytes32(paymasterAndData[20:52])), preVerificationGas, gasFees))
 *  hash   = keccak256(abi.encode(opPart, chainid, paymaster, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer)) */
export function paymasterHash({ op, chainId, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer }) {
  if (BigInt(validUntil) > U48_MAX || BigInt(validAfter) > U48_MAX) throw new PaymasterInputError('validity window out of uint48 range');
  if (BigInt(maxXgasDevCharge) > U256_MAX || BigInt(maxXgasDevCharge) < 0n) throw new PaymasterInputError('maxXgasDevCharge out of uint256 range');
  const opPart = keccak256(encodeAbiParameters(
    [
      { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' },
    ],
    [
      op.sender, op.nonce, keccak256(initCodeOf(op)), keccak256(op.callData), accountGasLimitsOf(op),
      paymasterGasWord(pmVerificationGasLimit, pmPostOpGasLimit), op.preVerificationGas, gasFeesOf(op),
    ],
  ));
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint48' }, { type: 'uint48' }, { type: 'uint256' }, { type: 'address' }],
    [opPart, BigInt(chainId), getAddress(paymaster), Number(validUntil), Number(validAfter), BigInt(maxXgasDevCharge), getAddress(robinhoodPayer)],
  ));
}

export function encodePaymasterData({ validUntil, validAfter, maxXgasDevCharge, robinhoodPayer, signature }) {
  if (size(signature) !== 65) throw new PaymasterInputError('signature must be 65 bytes');
  return encodePacked(
    ['uint48', 'uint48', 'uint256', 'address', 'bytes'],
    [Number(validUntil), Number(validAfter), BigInt(maxXgasDevCharge), getAddress(robinhoodPayer), signature],
  );
}

export function decodePaymasterData(data) {
  if (!isHex(data) || size(data) !== PAYMASTER_DATA_LENGTH) throw new PaymasterInputError(`paymasterData must be ${PAYMASTER_DATA_LENGTH} bytes`);
  return {
    validUntil: Number(hexToBigInt(slice(data, 0, 6))),
    validAfter: Number(hexToBigInt(slice(data, 6, 12))),
    maxXgasDevCharge: hexToBigInt(slice(data, 12, 44)),
    robinhoodPayer: getAddress(slice(data, 44, 64)),
    signature: slice(data, 64, 129),
  };
}

/** Sign a sponsorship. `signer` is a viem LocalAccount. Returns everything the RPC response and the ledger need. */
export async function signSponsorship({ signer, op, chainId, entryPoint, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer }) {
  const hash = paymasterHash({ op, chainId, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, validUntil, validAfter, maxXgasDevCharge, robinhoodPayer });
  const signature = await signer.signMessage({ message: { raw: hash } });
  const paymasterData = encodePaymasterData({ validUntil, validAfter, maxXgasDevCharge, robinhoodPayer, signature });
  const userOpHash = userOpHashOf({ op, chainId, entryPoint, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, paymasterData });
  return { hash, signature, paymasterData, userOpHash };
}

export function stubPaymasterData({ validUntil, validAfter, maxXgasDevCharge, robinhoodPayer }) {
  return encodePaymasterData({ validUntil, validAfter, maxXgasDevCharge, robinhoodPayer, signature: STUB_SIGNATURE });
}

export async function recoverSponsorSigner({ op, chainId, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, paymasterData }) {
  const d = decodePaymasterData(paymasterData);
  const hash = paymasterHash({ op, chainId, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, ...d });
  return recoverMessageAddress({ message: { raw: hash }, signature: d.signature });
}

/** The EntryPoint v0.7 userOpHash of the op once this paymasterData is attached (the account signature is not hashed). */
export function userOpHashOf({ op, chainId, entryPoint, paymaster, pmVerificationGasLimit, pmPostOpGasLimit, paymasterData }) {
  return getUserOperationHash({
    chainId: Number(chainId),
    entryPointAddress: getAddress(entryPoint),
    entryPointVersion: '0.7',
    userOperation: {
      sender: op.sender, nonce: op.nonce, factory: op.factory || undefined, factoryData: op.factory ? op.factoryData : undefined,
      callData: op.callData, callGasLimit: op.callGasLimit, verificationGasLimit: op.verificationGasLimit,
      preVerificationGas: op.preVerificationGas, maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas,
      paymaster: getAddress(paymaster), paymasterVerificationGasLimit: BigInt(pmVerificationGasLimit), paymasterPostOpGasLimit: BigInt(pmPostOpGasLimit),
      paymasterData, signature: '0x',
    },
  });
}

// SimpleAccountFactory v0.7 (and every factory that copies its entry point).
const FACTORY_ABI = parseAbi(['function createAccount(address owner, uint256 salt) returns (address)']);
/** The owner a SimpleAccountFactory initCode creates the account for, or null when factoryData is something else. */
export function simpleAccountOwnerFromFactoryData(factoryData) {
  try {
    const { functionName, args } = decodeFunctionData({ abi: FACTORY_ABI, data: factoryData });
    return functionName === 'createAccount' ? getAddress(args[0]) : null;
  } catch { return null; }
}

/** The whole debit rule: ceil(actualGasCost * rateWad / 1e18) at the rate quoted when the op was signed (buffer
 *  included), never above the maxXgasDevCharge the payer signed over. */
export function chargeFor({ actualGasCost, rateWad, maxXgasDevCharge }) {
  const a = BigInt(actualGasCost), r = BigInt(rateWad), c = BigInt(maxXgasDevCharge);
  if (c <= 0n || a <= 0n || r <= 0n) return 0n;
  const WAD = 10n ** 18n;
  const v = (a * r + WAD - 1n) / WAD;
  return v > c ? c : v;
}
