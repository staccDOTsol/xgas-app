#!/usr/bin/env node
// One exact native xMoney canary to the successor sink. No key is printed or passed on the CLI.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const sender = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const sink = '0x4ca8826FBb7F69F55B858485313eAC56a1b4F458';
const forwarder = '0x44a0438e85C3947C369B1B8A7D9991741040A7FF';
const value = parseEther('0.01');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file permissions are too broad');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Invalid guarded signer file');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== sender.toLowerCase()) throw new Error('Wrong canary signer');

const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const abi = parseAbi(['function fanout() view returns (address)', 'function totalFlushed() view returns (uint256)', 'function MIN_FLUSH() view returns (uint256)']);
const [chainId, code, target, threshold, flushed, sinkBefore, latest, pending, balance, fees] = await Promise.all([
  publicClient.getChainId(), publicClient.getCode({ address: sink }),
  publicClient.readContract({ address: sink, abi, functionName: 'fanout' }),
  publicClient.readContract({ address: sink, abi, functionName: 'MIN_FLUSH' }),
  publicClient.readContract({ address: sink, abi, functionName: 'totalFlushed' }),
  publicClient.getBalance({ address: sink }),
  publicClient.getTransactionCount({ address: sender, blockTag: 'latest' }),
  publicClient.getTransactionCount({ address: sender, blockTag: 'pending' }),
  publicClient.getBalance({ address: sender }), publicClient.estimateFeesPerGas(),
]);
if (chainId !== 466302 || !code || code === '0x' || target.toLowerCase() !== forwarder.toLowerCase()
  || threshold !== value || flushed !== 0n || sinkBefore !== 0n) throw new Error('Canary sink is not pristine or is miswired');
if (latest !== pending) throw new Error('Sender already has a pending L4 transaction');
const estimatedGas = await publicClient.estimateGas({ account: sender, to: sink, value });
const gas = estimatedGas * 5n / 4n;
const maxGasCost = gas * fees.maxFeePerGas;
if (maxGasCost > parseEther('0.1') || balance < value + maxGasCost + parseEther('20')) {
  throw new Error('Canary exceeds gas cap or 20 xMoney sender reserve');
}
console.log(JSON.stringify({ sender, sink, valueWei: value.toString(), nonce: pending,
  senderBalance: formatEther(balance), estimatedGas: estimatedGas.toString(), gas: gas.toString(),
  maxGasCost: formatEther(maxGasCost) }));
if (process.env.FIREBALL_CANARY_SEND !== 'YES') {
  console.log('Dry run only; FIREBALL_CANARY_SEND=YES is required to send.');
  process.exit(0);
}

const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
const hash = await wallet.sendTransaction({ to: sink, value, nonce: pending, gas,
  maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
console.log(JSON.stringify({ hash, nonce: pending }));
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') throw new Error(`Canary reverted: ${hash}`);
const [sinkAfter, flushedAfter] = await Promise.all([
  publicClient.getBalance({ address: sink }),
  publicClient.readContract({ address: sink, abi, functionName: 'totalFlushed' }),
]);
if (sinkAfter !== value || flushedAfter !== 0n) throw new Error(`Unexpected sink state after canary: ${hash}`);
console.log(JSON.stringify({ hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(),
  sinkBalance: formatEther(sinkAfter), totalFlushed: flushedAfter.toString() }));
