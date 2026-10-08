#!/usr/bin/env node
// One guarded Robinhood transaction per invocation. No private key enters argv or output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rpc = 'https://rpc.mainnet.chain.robinhood.com';
const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const profiles = {
  owner: { file: '/Users/stacc/staccoverflow.eth', address: '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158' },
  isolated: { file: '/Users/stacc/hoodagents.eth', address: '0x3CacEA9579D61e6BE8C4c75C0537564761A6f8ea' },
};
const profile = profiles[process.env.FIREBALL_SIGNER_PROFILE];
const step = process.argv[2];
if (!profile || !['register', 'forwarder'].includes(step) || process.argv.length !== 3) {
  throw new Error('Use FIREBALL_SIGNER_PROFILE=owner|isolated send-fireball-rh.mjs register|forwarder');
}
const stat = fs.statSync(profile.file);
if ((stat.mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(profile.file, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== profile.address.toLowerCase()) throw new Error('Wrong guarded signer');

const fanout = '0x0a87Da84277232720e0908CC7470e3A7f925748f';
const xMoney = '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E';
const fanoutAbi = parseAbi([
  'function registeredCount() view returns (uint64)',
  'function isAssetActive(address) view returns (bool)',
  'function totalDeposited(address) view returns (uint256)',
  'function ensureAsset(address)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }) });
if (await pub.getChainId() !== chain.id) throw new Error('Wrong Robinhood chain');
const [count, active, total, held, fanoutCode, tokenCode] = await Promise.all([
  pub.readContract({ address: fanout, abi: fanoutAbi, functionName: 'registeredCount' }),
  pub.readContract({ address: fanout, abi: fanoutAbi, functionName: 'isAssetActive', args: [xMoney] }),
  pub.readContract({ address: fanout, abi: fanoutAbi, functionName: 'totalDeposited', args: [xMoney] }),
  pub.readContract({ address: xMoney, abi: tokenAbi, functionName: 'balanceOf', args: [fanout] }),
  pub.getCode({ address: fanout }), pub.getCode({ address: xMoney }),
]);
if (count === 0n || !fanoutCode || fanoutCode === '0x' || !tokenCode || tokenCode === '0x') {
  throw new Error('Fireball fanout or xMoney is missing');
}
let tx;
if (step === 'register') {
  if (active || total !== 0n || held !== 0n) throw new Error('xMoney already active or needs history/balance reconciliation');
  tx = { to: fanout, data: encodeFunctionData({ abi: fanoutAbi, functionName: 'ensureAsset', args: [xMoney] }) };
} else {
  if (!active) throw new Error('Register xMoney before deploying the forwarder');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts/out/FireballBridgeFeeForwarder.sol/FireballBridgeFeeForwarder.json'), 'utf8'));
  tx = { data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [xMoney, fanout] }) };
}

const [gasEstimate, fees] = await Promise.all([
  pub.estimateGas({ account: account.address, ...tx }), pub.estimateFeesPerGas(),
]);
const gas = gasEstimate * 5n / 4n;
const maxCost = gas * fees.maxFeePerGas;
if (maxCost > 10n ** 14n) throw new Error('RH transaction exceeds 0.0001 ETH gas budget');
const [latest, pending, balance] = await Promise.all([
  pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
  pub.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  pub.getBalance({ address: account.address }),
]);
if (latest !== pending) throw new Error('Signer has an outstanding pending transaction');
if (balance < maxCost + 2n * 10n ** 15n) throw new Error('RH signer would fall below 0.002 ETH reserve');
const predicted = step === 'forwarder' ? getContractAddress({ from: account.address, nonce: BigInt(pending) }) : null;
console.log(JSON.stringify({ step, signer: account.address, nonce: pending, balanceEth: formatEther(balance), outputs: String(count), gasEstimate: String(gasEstimate), maxGasCostEth: formatEther(maxCost), predicted }));
if (process.env.FIREBALL_RUN_BROADCAST !== 'YES') {
  console.log('Dry run only; FIREBALL_RUN_BROADCAST=YES is required to send.');
  process.exit(0);
}

const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
const hash = await wallet.sendTransaction({
  ...tx, nonce: pending, gas, maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
});
console.log(JSON.stringify({ step, hash, nonce: pending }));
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') throw new Error(`${step} reverted: ${hash}`);
if (step === 'register') {
  if (!await pub.readContract({ address: fanout, abi: fanoutAbi, functionName: 'isAssetActive', args: [xMoney] })) {
    throw new Error(`Registration receipt succeeded but xMoney inactive: ${hash}`);
  }
} else {
  if (receipt.contractAddress?.toLowerCase() !== predicted.toLowerCase()) throw new Error('Unexpected forwarder address');
  const abi = parseAbi(['function fanout() view returns (address)', 'function xMoney() view returns (address)']);
  const [forwarderCode, targetFanout, token] = await Promise.all([
    pub.getCode({ address: receipt.contractAddress }),
    pub.readContract({ address: receipt.contractAddress, abi, functionName: 'fanout' }),
    pub.readContract({ address: receipt.contractAddress, abi, functionName: 'xMoney' }),
  ]);
  if (!forwarderCode || forwarderCode === '0x' || targetFanout.toLowerCase() !== fanout.toLowerCase() || token.toLowerCase() !== xMoney.toLowerCase()) {
    throw new Error(`Forwarder receipt succeeded but wiring invalid: ${hash}`);
  }
}
console.log(JSON.stringify({ step, hash, status: receipt.status, blockNumber: String(receipt.blockNumber), contractAddress: receipt.contractAddress }));
