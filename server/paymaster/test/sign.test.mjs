import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, encodeFunctionData, getAddress, keccak256, pad, parseAbi, recoverMessageAddress, size, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash } from 'viem/account-abstraction';
import {
  PAYMASTER_DATA_LENGTH, STUB_SIGNATURE, chargeFor, decodePaymasterData, encodePaymasterData, parseUserOp, paymasterHash,
  recoverSponsorSigner, requiredPrefund, signSponsorship, simpleAccountOwnerFromFactoryData, stubPaymasterData, userOpHashOf,
  PaymasterInputError,
} from '../sign.mjs';
import { SIGNER_KEY, PAYMASTER, PAYER, SENDER, FACTORY } from './fakes.mjs';

const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const signer = privateKeyToAccount(SIGNER_KEY);
const rawOp = {
  sender: SENDER, nonce: '0x5', callData: '0xb61d27f6', callGasLimit: '0x186a0', verificationGasLimit: '0x30d40',
  preVerificationGas: '0xc350', maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x0', signature: '0x',
};
const base = { chainId: 466302, paymaster: PAYMASTER, pmVerificationGasLimit: 75_000n, pmPostOpGasLimit: 40_000n, validUntil: 1790000000, validAfter: 0, maxXgasDevCharge: 123456789012345678901n, robinhoodPayer: PAYER };

// Independent re-derivation with raw 32-byte words, not encodeAbiParameters.
const w = (v) => pad(toHex(BigInt(v)), { size: 32 });
const wa = (a) => pad(a.toLowerCase(), { size: 32 });
function manualHash(op, p) {
  const accountGasLimits = concat([pad(toHex(op.verificationGasLimit), { size: 16 }), pad(toHex(op.callGasLimit), { size: 16 })]);
  const gasFees = concat([pad(toHex(op.maxPriorityFeePerGas), { size: 16 }), pad(toHex(op.maxFeePerGas), { size: 16 })]);
  const initCode = op.factory ? concat([op.factory, op.factoryData]) : '0x';
  const opPart = keccak256(concat([
    wa(op.sender), w(op.nonce), keccak256(initCode), keccak256(op.callData), accountGasLimits,
    w((p.pmVerificationGasLimit << 128n) | p.pmPostOpGasLimit), w(op.preVerificationGas), gasFees,
  ]));
  return keccak256(concat([opPart, w(p.chainId), wa(p.paymaster), w(p.validUntil), w(p.validAfter), w(p.maxXgasDevCharge), wa(p.robinhoodPayer)]));
}

test('paymasterHash matches an independent word-by-word derivation (no initCode and with initCode)', () => {
  const op = parseUserOp(rawOp);
  assert.equal(paymasterHash({ op, ...base }), manualHash(op, base));
  const factoryData = encodeFunctionData({ abi: parseAbi(['function createAccount(address,uint256)']), functionName: 'createAccount', args: [PAYER, 0n] });
  const op2 = parseUserOp({ ...rawOp, factory: FACTORY, factoryData });
  assert.equal(paymasterHash({ op: op2, ...base }), manualHash(op2, base));
  assert.notEqual(paymasterHash({ op: op2, ...base }), paymasterHash({ op, ...base }));
});

test('paymasterData is 129 bytes, packed as validUntil|validAfter|uint256 max|payer|sig, and round trips', () => {
  const sig = `0x${'11'.repeat(64)}1b`;
  const d = encodePaymasterData({ ...base, signature: sig });
  assert.equal(size(d), 129); assert.equal(PAYMASTER_DATA_LENGTH, 129);
  assert.equal(d.slice(2, 14), (1790000000).toString(16).padStart(12, '0'));
  assert.equal(d.slice(14, 26), '000000000000');
  assert.equal(BigInt(`0x${d.slice(26, 90)}`), base.maxXgasDevCharge);
  assert.equal(getAddress(`0x${d.slice(90, 130)}`), getAddress(PAYER));
  assert.equal(`0x${d.slice(130)}`, sig);
  const back = decodePaymasterData(d);
  assert.deepEqual({ ...back }, { validUntil: 1790000000, validAfter: 0, maxXgasDevCharge: base.maxXgasDevCharge, robinhoodPayer: getAddress(PAYER), signature: sig });
  assert.throws(() => decodePaymasterData(`0x${'00'.repeat(113)}`), PaymasterInputError);
});

test('signature: EIP-191 over the hash, recovers to the signer; a different key does not', async () => {
  const op = parseUserOp(rawOp);
  const s = await signSponsorship({ signer, op, entryPoint: EP, ...base });
  assert.equal(await recoverMessageAddress({ message: { raw: s.hash }, signature: s.signature }), signer.address);
  assert.equal(await recoverSponsorSigner({ op, ...base, paymasterData: s.paymasterData }), signer.address);
  const other = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const s2 = await signSponsorship({ signer: other, op, entryPoint: EP, ...base });
  assert.notEqual(await recoverSponsorSigner({ op, ...base, paymasterData: s2.paymasterData }), signer.address);
});

test('replay: the hash binds chainId, paymaster, window, max charge, payer, and every gas field', () => {
  const op = parseUserOp(rawOp);
  const h = paymasterHash({ op, ...base });
  const variants = [
    { chainId: 4663 }, { paymaster: '0x9999999999999999999999999999999999999999' }, { validUntil: base.validUntil + 1 },
    { validAfter: 1 }, { maxXgasDevCharge: base.maxXgasDevCharge + 1n }, { robinhoodPayer: SENDER },
    { pmVerificationGasLimit: 75_001n }, { pmPostOpGasLimit: 40_001n },
  ];
  for (const v of variants) assert.notEqual(paymasterHash({ op, ...base, ...v }), h, JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x));
  for (const f of ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    assert.notEqual(paymasterHash({ op: { ...op, [f]: op[f] + 1n }, ...base }), h, f);
  }
  assert.notEqual(paymasterHash({ op: { ...op, callData: '0xb61d27f7' }, ...base }), h);
  // The account signature is not covered (the account signs after the paymaster).
  assert.equal(paymasterHash({ op: { ...op, signature: '0xdead' }, ...base }), h);
});

test('userOpHashOf equals viem getUserOperationHash of the op with the full paymasterAndData', async () => {
  const op = parseUserOp(rawOp);
  const s = await signSponsorship({ signer, op, entryPoint: EP, ...base });
  const viemHash = getUserOperationHash({
    chainId: 466302, entryPointAddress: EP, entryPointVersion: '0.7',
    userOperation: { ...op, factory: undefined, factoryData: undefined, paymaster: PAYMASTER, paymasterVerificationGasLimit: 75_000n, paymasterPostOpGasLimit: 40_000n, paymasterData: s.paymasterData, signature: '0x1234' },
  });
  assert.equal(s.userOpHash, viemHash);
  assert.equal(userOpHashOf({ op, chainId: 466302, entryPoint: EP, paymaster: PAYMASTER, pmVerificationGasLimit: 75_000n, pmPostOpGasLimit: 40_000n, paymasterData: s.paymasterData }), viemHash);
});

test('stub data carries the well-formed dummy signature', () => {
  const d = stubPaymasterData(base);
  assert.equal(size(d), 129);
  assert.equal(decodePaymasterData(d).signature, STUB_SIGNATURE);
});

test('requiredPrefund = all five gas limits x maxFeePerGas', () => {
  const op = parseUserOp(rawOp);
  assert.equal(requiredPrefund(op, 75_000n, 40_000n), (200_000n + 100_000n + 75_000n + 40_000n + 50_000n) * 100_000_000n);
});

test('chargeFor: ceil at the quoted rate, capped at the signed max, zero-safe', () => {
  const WAD = 10n ** 18n;
  assert.equal(chargeFor({ actualGasCost: 10n ** 14n, rateWad: 3575n * WAD, maxXgasDevCharge: 10n ** 30n }), 3575n * 10n ** 14n);
  assert.equal(chargeFor({ actualGasCost: 3n, rateWad: WAD / 2n, maxXgasDevCharge: 100n }), 2n); // 1.5 -> 2
  assert.equal(chargeFor({ actualGasCost: 10n ** 18n, rateWad: 5000n * WAD, maxXgasDevCharge: 7n }), 7n);
  assert.equal(chargeFor({ actualGasCost: 0n, rateWad: WAD, maxXgasDevCharge: 7n }), 0n);
  assert.equal(chargeFor({ actualGasCost: 5n, rateWad: WAD, maxXgasDevCharge: 0n }), 0n);
});

test('SimpleAccountFactory initCode owner decode', () => {
  const fd = encodeFunctionData({ abi: parseAbi(['function createAccount(address,uint256)']), functionName: 'createAccount', args: [PAYER, 7n] });
  assert.equal(simpleAccountOwnerFromFactoryData(fd), getAddress(PAYER));
  assert.equal(simpleAccountOwnerFromFactoryData('0xdeadbeef'), null);
});

test('parseUserOp rejects junk and v0.6 shapes', () => {
  assert.throws(() => parseUserOp(null), PaymasterInputError);
  assert.throws(() => parseUserOp({ ...rawOp, sender: '0x12' }), PaymasterInputError);
  assert.throws(() => parseUserOp({ ...rawOp, nonce: 'abc' }), PaymasterInputError);
  assert.throws(() => parseUserOp({ ...rawOp, callData: '0x123' }), PaymasterInputError);
  assert.throws(() => parseUserOp({ ...rawOp, callGasLimit: `0x1${'0'.repeat(32)}` }), PaymasterInputError); // > uint128
  assert.throws(() => parseUserOp({ ...rawOp, initCode: '0x' }), PaymasterInputError);
  const op = parseUserOp({ ...rawOp, nonce: 5 });
  assert.equal(op.nonce, 5n); assert.equal(op.factory, null);
});
