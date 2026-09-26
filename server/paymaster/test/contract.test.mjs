// Cross-check against the compiled XgasDevPaymaster (contracts/out) on a throwaway anvil: the server's hash,
// paymasterData layout and signature must be exactly what the contract accepts. Skipped when anvil or the
// artifacts are missing. Starts anvil on a port it has just checked is free and kills only that process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { concat, createPublicClient, createWalletClient, defineChain, getAddress, http, pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash } from 'viem/account-abstraction';
import { parseUserOp, paymasterHash, signSponsorship, initCodeOf, accountGasLimitsOf, gasFeesOf, stubPaymasterData } from '../sign.mjs';
import { SIGNER_KEY, PAYER, SENDER } from './fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ART = (f, c) => path.join(ROOT, 'contracts', 'out', f, `${c}.json`);
const ANVIL = [path.join(os.homedir(), '.foundry', 'bin', 'anvil'), 'anvil'].find((p) => p === 'anvil' || fs.existsSync(p));
const haveArtifacts = fs.existsSync(ART('XgasDevPaymaster.sol', 'XgasDevPaymaster')) && fs.existsSync(ART('EntryPoint.sol', 'EntryPoint'));

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitRpc(url, ms = 15_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('anvil did not start');
}

test('server signature validates in the compiled XgasDevPaymaster (anvil, chain 466302)', { skip: !haveArtifacts && 'contracts/out not built', timeout: 60_000 }, async () => {
  const port = await freePort();
  const proc = spawn(ANVIL, ['--port', String(port), '--chain-id', '466302', '--silent'], { stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitRpc(url);
    const chain = defineChain({ id: 466302, name: 'l4-test', nativeCurrency: { name: 'xMoney', symbol: 'XM', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    const pub = createPublicClient({ chain, transport: http(url) });
    const [deployerAddr] = await pub.request({ method: 'eth_accounts' });   // anvil's unlocked dev account
    const deployer = { address: getAddress(deployerAddr) };
    const wallet = createWalletClient({ chain, account: deployer.address, transport: http(url) });
    const epArt = JSON.parse(fs.readFileSync(ART('EntryPoint.sol', 'EntryPoint'), 'utf8'));
    const pmArt = JSON.parse(fs.readFileSync(ART('XgasDevPaymaster.sol', 'XgasDevPaymaster'), 'utf8'));
    const signer = privateKeyToAccount(SIGNER_KEY);
    const epTx = await wallet.deployContract({ abi: epArt.abi, bytecode: epArt.bytecode.object, args: [] });
    const ep = (await pub.waitForTransactionReceipt({ hash: epTx })).contractAddress;
    const pmTx = await wallet.deployContract({ abi: pmArt.abi, bytecode: pmArt.bytecode.object, args: [ep, deployer.address, signer.address] });
    const pm = (await pub.waitForTransactionReceipt({ hash: pmTx })).contractAddress;

    const op = parseUserOp({
      sender: SENDER, nonce: '0x7', factory: '0x9406Cc6185a346906296840746125a0E44976454', factoryData: '0x5fbfb9cf0000000000000000000000003333333333333333333333333333333333333333' + '0'.repeat(64),
      callData: '0xb61d27f60000', callGasLimit: '0x186a0', verificationGasLimit: '0x30d40', preVerificationGas: '0xc350',
      maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x1',
    });
    const p = { chainId: 466302, paymaster: pm, pmVerificationGasLimit: 75_000n, pmPostOpGasLimit: 40_000n, validUntil: 1_900_000_000, validAfter: 5, maxXgasDevCharge: 987654321987654321987n, robinhoodPayer: PAYER };
    const s = await signSponsorship({ signer, op, entryPoint: ep, ...p });
    const paymasterAndData = concat([pm, pad(toHex(75_000n), { size: 16 }), pad(toHex(40_000n), { size: 16 }), s.paymasterData]);
    const packed = {
      sender: op.sender, nonce: op.nonce, initCode: initCodeOf(op), callData: op.callData, accountGasLimits: accountGasLimitsOf(op),
      preVerificationGas: op.preVerificationGas, gasFees: gasFeesOf(op), paymasterAndData, signature: '0x',
    };

    // 1. getHash
    const onchain = await pub.readContract({ address: pm, abi: pmArt.abi, functionName: 'getHash', args: [packed, p.validUntil, p.validAfter, p.maxXgasDevCharge, p.robinhoodPayer] });
    assert.equal(onchain, paymasterHash({ op, ...p }));
    // 2. parsePaymasterAndData
    const parsed = await pub.readContract({ address: pm, abi: pmArt.abi, functionName: 'parsePaymasterAndData', args: [paymasterAndData] });
    assert.deepEqual([Number(parsed[0]), Number(parsed[1]), parsed[2], getAddress(parsed[3]), parsed[4]], [p.validUntil, p.validAfter, p.maxXgasDevCharge, getAddress(PAYER), s.signature]);
    // 3. userOpHash: EntryPoint.getUserOpHash == ours
    const epHash = await pub.readContract({ address: ep, abi: epArt.abi, functionName: 'getUserOpHash', args: [packed] });
    assert.equal(epHash, s.userOpHash);
    // 4. validatePaymasterUserOp as the EntryPoint: our signature passes (sig bit 0), the stub fails (sig bit 1).
    const validate = async (pad_) => {
      const { result } = await pub.simulateContract({ account: ep, address: pm, abi: pmArt.abi, functionName: 'validatePaymasterUserOp', args: [{ ...packed, paymasterAndData: pad_ }, s.userOpHash, 10n ** 15n] });
      return result[1];
    };
    const vd = await validate(paymasterAndData);
    assert.equal(vd & 1n, 0n, 'sig should pass');
    assert.equal((vd >> 160n) & ((1n << 48n) - 1n), BigInt(p.validUntil));
    assert.equal(vd >> 208n, BigInt(p.validAfter));
    const stub = concat([pm, pad(toHex(75_000n), { size: 16 }), pad(toHex(40_000n), { size: 16 }), stubPaymasterData(p)]);
    assert.equal((await validate(stub)) & 1n, 1n, 'stub sig must fail without reverting');
    // Signed for another chain id: fails.
    const s2 = await signSponsorship({ signer, op, entryPoint: ep, ...p, chainId: 4663 });
    const other = concat([pm, pad(toHex(75_000n), { size: 16 }), pad(toHex(40_000n), { size: 16 }), s2.paymasterData]);
    assert.equal((await validate(other)) & 1n, 1n, 'cross-chain replay must fail');
    assert.ok(getUserOperationHash);
  } finally {
    proc.kill('SIGTERM');
  }
});
