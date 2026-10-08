#!/usr/bin/env node
// Flush only the exact, confirmed 0.01 xMoney canary from the successor sink.
import fs from 'node:fs';
import {
  createPublicClient, createWalletClient, defineChain, formatEther, http,
  parseAbi, parseEther, decodeEventLog,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const sender = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const sink = '0x4ca8826FBb7F69F55B858485313eAC56a1b4F458';
const forwarder = '0x44a0438e85C3947C369B1B8A7D9991741040A7FF';
const value = parseEther('0.01');
const file = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('Signer file permissions are too broad');
const raw = fs.readFileSync(file, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Invalid guarded signer file');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== sender.toLowerCase()) throw new Error('Wrong flush signer');

const client = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const abi = parseAbi([
  'function fanout() view returns (address)',
  'function totalFlushed() view returns (uint256)',
  'function MIN_FLUSH() view returns (uint256)',
  'function flush() returns (uint256 amount, uint256 withdrawalId)',
  'event Flushed(uint256 amount, uint256 withdrawalId)',
]);
const [chainId, code, target, threshold, totalBefore, sinkBefore, latest, pending, senderBalance, fees] = await Promise.all([
  client.getChainId(), client.getCode({ address: sink }),
  client.readContract({ address: sink, abi, functionName: 'fanout' }),
  client.readContract({ address: sink, abi, functionName: 'MIN_FLUSH' }),
  client.readContract({ address: sink, abi, functionName: 'totalFlushed' }),
  client.getBalance({ address: sink }),
  client.getTransactionCount({ address: sender, blockTag: 'latest' }),
  client.getTransactionCount({ address: sender, blockTag: 'pending' }),
  client.getBalance({ address: sender }), client.estimateFeesPerGas(),
]);
if (chainId !== 466302 || !code || code === '0x' || target.toLowerCase() !== forwarder.toLowerCase()
  || threshold !== value || totalBefore !== 0n || sinkBefore !== value) throw new Error('Canary sink state or target changed');
if (latest !== pending) throw new Error('Sender already has a pending L4 transaction');
const simulation = await client.simulateContract({ address: sink, abi, functionName: 'flush', account: sender });
if (simulation.result[0] !== value) throw new Error('Simulated flush amount is not 0.01 xMoney');
const estimatedGas = await client.estimateContractGas({ address: sink, abi, functionName: 'flush', account: sender });
const gas = estimatedGas * 5n / 4n;
const maxGasCost = gas * fees.maxFeePerGas;
if (maxGasCost > parseEther('0.1') || senderBalance < maxGasCost + parseEther('20')) {
  throw new Error('Flush exceeds gas cap or 20 xMoney reserve');
}
console.log(JSON.stringify({ sender, sink, forwarder, amount: formatEther(value), nonce: pending,
  withdrawalId: simulation.result[1].toString(), estimatedGas: estimatedGas.toString(),
  maxGasCost: formatEther(maxGasCost) }));
if (process.env.FIREBALL_CANARY_FLUSH !== 'YES') {
  console.log('Dry run only; FIREBALL_CANARY_FLUSH=YES is required to flush.');
  process.exit(0);
}
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
const hash = await wallet.writeContract({ address: sink, abi, functionName: 'flush', nonce: pending, gas,
  maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
console.log(JSON.stringify({ hash, nonce: pending }));
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') throw new Error(`Flush reverted: ${hash}`);
const events = receipt.logs.filter(log => log.address.toLowerCase() === sink.toLowerCase())
  .map(log => { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; } })
  .filter(event => event?.eventName === 'Flushed');
if (events.length !== 1 || events[0].args.amount !== value) throw new Error(`Flush event mismatch: ${hash}`);
const [sinkAfter, totalAfter] = await Promise.all([
  client.getBalance({ address: sink }), client.readContract({ address: sink, abi, functionName: 'totalFlushed' }),
]);
if (sinkAfter !== 0n || totalAfter !== value) throw new Error(`Unexpected sink state after flush: ${hash}`);
console.log(JSON.stringify({ hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(),
  withdrawalId: events[0].args.withdrawalId.toString(), sinkBalance: formatEther(sinkAfter),
  totalFlushed: formatEther(totalAfter) }));
