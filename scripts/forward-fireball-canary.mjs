#!/usr/bin/env node
// Forward a single executed bridge canary from the RH forwarder into the Fireball product fanout.
import fs from 'node:fs';
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, formatEther, http, parseAbi, parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = 'https://rpc.mainnet.chain.robinhood.com';
const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const sender = '0x3CacEA9579D61e6BE8C4c75C0537564761A6f8ea';
const file = '/Users/stacc/hoodagents.eth';
const forwarder = '0x44a0438e85C3947C369B1B8A7D9991741040A7FF';
const fanout = '0x0a87Da84277232720e0908CC7470e3A7f925748f';
const xMoney = '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E';
if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('Signer file permissions are too broad');
const raw = fs.readFileSync(file, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Invalid guarded signer file');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== sender.toLowerCase()) throw new Error('Wrong forward signer');

const client = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const forwardAbi = parseAbi([
  'function xMoney() view returns (address)', 'function fanout() view returns (address)',
  'function totalForwarded() view returns (uint256)', 'function totalCredited() view returns (uint256)',
  'function forward() returns (uint256 sent, uint256 credited)',
  'event Forwarded(uint256 sent, uint256 credited)',
]);
const fanoutAbi = parseAbi([
  'function registeredCount() view returns (uint64)', 'function isAssetActive(address) view returns (bool)',
  'function totalDeposited(address) view returns (uint256)',
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const [chainId, code, token, target, forwardedBefore, creditedBefore, count, active, depositedBefore,
  forwarderBalance, fanoutBalanceBefore, latest, pending, senderBalance, fees] = await Promise.all([
  client.getChainId(), client.getCode({ address: forwarder }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'xMoney' }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'fanout' }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'totalForwarded' }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'totalCredited' }),
  client.readContract({ address: fanout, abi: fanoutAbi, functionName: 'registeredCount' }),
  client.readContract({ address: fanout, abi: fanoutAbi, functionName: 'isAssetActive', args: [xMoney] }),
  client.readContract({ address: fanout, abi: fanoutAbi, functionName: 'totalDeposited', args: [xMoney] }),
  client.readContract({ address: xMoney, abi: tokenAbi, functionName: 'balanceOf', args: [forwarder] }),
  client.readContract({ address: xMoney, abi: tokenAbi, functionName: 'balanceOf', args: [fanout] }),
  client.getTransactionCount({ address: sender, blockTag: 'latest' }),
  client.getTransactionCount({ address: sender, blockTag: 'pending' }),
  client.getBalance({ address: sender }), client.estimateFeesPerGas(),
]);
if (chainId !== 4663 || !code || code === '0x' || token.toLowerCase() !== xMoney.toLowerCase()
  || target.toLowerCase() !== fanout.toLowerCase() || count === 0n || !active
  || forwardedBefore !== 0n || creditedBefore !== 0n || depositedBefore !== 0n
  || forwarderBalance <= 0n || forwarderBalance > parseEther('0.01')) {
  throw new Error('Canary forwarder or fanout state does not match preflight');
}
if (latest !== pending) throw new Error('Forward signer has a pending RH transaction');
const simulation = await client.simulateContract({ address: forwarder, abi: forwardAbi, functionName: 'forward', account: sender });
const [sent, credited] = simulation.result;
if (sent !== forwarderBalance || credited <= 0n || credited > sent) throw new Error('Unexpected simulated forward amount');
const estimatedGas = await client.estimateContractGas({ address: forwarder, abi: forwardAbi, functionName: 'forward', account: sender });
const gas = estimatedGas * 5n / 4n;
const maxGasCost = gas * fees.maxFeePerGas;
if (maxGasCost > parseEther('0.0001') || senderBalance < maxGasCost + parseEther('0.002')) {
  throw new Error('Forward exceeds gas cap or 0.002 ETH signer reserve');
}
console.log(JSON.stringify({ sender, forwarder, fanout, xMoney, nonce: pending,
  outputs: count.toString(), sent: formatEther(sent), credited: formatEther(credited),
  estimatedGas: estimatedGas.toString(), maxGasCostEth: formatEther(maxGasCost) }));
if (process.env.FIREBALL_CANARY_FORWARD !== 'YES') {
  console.log('Dry run only; FIREBALL_CANARY_FORWARD=YES is required to forward.');
  process.exit(0);
}
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
const hash = await wallet.writeContract({ address: forwarder, abi: forwardAbi, functionName: 'forward',
  nonce: pending, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
console.log(JSON.stringify({ hash, nonce: pending }));
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') throw new Error(`Forward reverted: ${hash}`);
const events = receipt.logs.filter(log => log.address.toLowerCase() === forwarder.toLowerCase())
  .map(log => { try { return decodeEventLog({ abi: forwardAbi, data: log.data, topics: log.topics }); } catch { return null; } })
  .filter(event => event?.eventName === 'Forwarded');
if (events.length !== 1 || events[0].args.sent !== sent || events[0].args.credited !== credited) {
  throw new Error(`Forward event mismatch: ${hash}`);
}
const [balanceAfter, forwardedAfter, creditedAfter, depositedAfter, fanoutBalanceAfter] = await Promise.all([
  client.readContract({ address: xMoney, abi: tokenAbi, functionName: 'balanceOf', args: [forwarder] }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'totalForwarded' }),
  client.readContract({ address: forwarder, abi: forwardAbi, functionName: 'totalCredited' }),
  client.readContract({ address: fanout, abi: fanoutAbi, functionName: 'totalDeposited', args: [xMoney] }),
  client.readContract({ address: xMoney, abi: tokenAbi, functionName: 'balanceOf', args: [fanout] }),
]);
if (balanceAfter !== 0n || forwardedAfter !== sent || creditedAfter !== credited
  || depositedAfter !== credited || fanoutBalanceAfter - fanoutBalanceBefore !== credited) {
  throw new Error(`Fanout accounting mismatch after forward: ${hash}`);
}
console.log(JSON.stringify({ hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(),
  sent: formatEther(sent), credited: formatEther(credited), deposited: formatEther(depositedAfter) }));
