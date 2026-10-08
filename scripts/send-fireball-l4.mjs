#!/usr/bin/env node
// One guarded Orbit L4 deployment per invocation, with L4's full intrinsic gas estimate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, formatEther, getContractAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rpc = 'https://xgas.dev/rpc';
const rhRpc = 'https://rpc.mainnet.chain.robinhood.com';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const forwarder = '0x44a0438e85C3947C369B1B8A7D9991741040A7FF';
const fanout = '0x0a87Da84277232720e0908CC7470e3A7f925748f';
const xMoney = '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E';
const buyback = '0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B';
const step = process.argv[2];
const sources = {
  sink: ['FanoutSink.sol', 'FanoutSink'],
  escrow: ['XMoneyEscrow.sol', 'XMoneyEscrow'],
  fomo: ['FomoAttritionL4.sol', 'FomoAttritionL4'],
  router: ['XGasRouter.sol', 'XGasRouter'],
  ngu: ['NguLauncher.sol', 'NguLauncher'],
};
if (!sources[step] || process.argv.length !== 3) throw new Error('Choose one step: sink, escrow, fomo, router, ngu');
if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('L4 deployer profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong L4 signer');

const rh = createPublicClient({ transport: http(rhRpc, { timeout: 15_000 }) });
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }) });
const forwarderAbi = parseAbi(['function fanout() view returns (address)', 'function xMoney() view returns (address)']);
const sinkAbi = parseAbi(['function fanout() view returns (address)']);
const [rhChain, l4Chain, code, targetFanout, token, buybackCode] = await Promise.all([
  rh.getChainId(), pub.getChainId(), rh.getCode({ address: forwarder }),
  rh.readContract({ address: forwarder, abi: forwarderAbi, functionName: 'fanout' }),
  rh.readContract({ address: forwarder, abi: forwarderAbi, functionName: 'xMoney' }),
  pub.getCode({ address: buyback }),
]);
if (rhChain !== 4663 || l4Chain !== 466302 || !code || code === '0x' || !buybackCode || buybackCode === '0x'
  || targetFanout.toLowerCase() !== fanout.toLowerCase() || token.toLowerCase() !== xMoney.toLowerCase()) {
  throw new Error('Wrong chain or parent fee route wiring');
}
let sink = null;
if (step !== 'sink') {
  sink = process.env.FIREBALL_L4_SINK;
  if (!/^0x[0-9a-fA-F]{40}$/.test(sink || '')) throw new Error('Set FIREBALL_L4_SINK to the verified new sink');
  const [sinkCode, sinkParent] = await Promise.all([
    pub.getCode({ address: sink }), pub.readContract({ address: sink, abi: sinkAbi, functionName: 'fanout' }),
  ]);
  if (!sinkCode || sinkCode === '0x' || sinkParent.toLowerCase() !== forwarder.toLowerCase()) throw new Error('New sink wiring invalid');
}
const [source, contract] = sources[step];
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts/out', source, `${contract}.json`), 'utf8'));
const args = step === 'sink' ? [forwarder] : [sink, buyback];
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
const [estimate, fees] = await Promise.all([
  pub.estimateGas({ account: owner, data }), pub.estimateFeesPerGas(),
]);
// Nitro charges a large parent-data component as intrinsic gas. Forge's script
// output underestimates it; use the RPC estimate with a 25% cushion.
const gas = estimate * 5n / 4n;
const maxCost = gas * fees.maxFeePerGas;
if (maxCost > 5n * 10n ** 17n) throw new Error('L4 deploy exceeds 0.5 xMoney gas budget');
const [latest, pending, balance] = await Promise.all([
  pub.getTransactionCount({ address: owner, blockTag: 'latest' }),
  pub.getTransactionCount({ address: owner, blockTag: 'pending' }),
  pub.getBalance({ address: owner }),
]);
if (latest !== pending) throw new Error('Owner L4 nonce has a pending transaction');
if (balance < maxCost + 5n * 10n ** 18n) throw new Error('L4 owner would fall below 5 xMoney reserve');
const predicted = getContractAddress({ from: owner, nonce: BigInt(pending) });
console.log(JSON.stringify({ step, nonce: pending, ownerBalance: formatEther(balance), estimatedGas: String(estimate), sendGas: String(gas), maxCostXMoney: formatEther(maxCost), predicted }));
if (process.env.FIREBALL_RUN_BROADCAST !== 'YES') {
  console.log('Dry run only; FIREBALL_RUN_BROADCAST=YES is required to send.');
  process.exit(0);
}

const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
const hash = await wallet.sendTransaction({ data, nonce: pending, gas,
  maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
console.log(JSON.stringify({ step, hash, nonce: pending }));
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== predicted.toLowerCase()) {
  throw new Error(`${step} receipt failed or address unexpected: ${hash}`);
}
const createdCode = await pub.getCode({ address: receipt.contractAddress });
if (!createdCode || createdCode === '0x') throw new Error(`${step} has no deployed code: ${hash}`);
const immutableAbi = step === 'sink' ? sinkAbi : parseAbi(step === 'ngu'
  ? ['function fanoutSink() view returns (address)', 'function buybackSink() view returns (address)']
  : ['function FANOUT() view returns (address)', 'function BUYBACK() view returns (address)']);
const firstName = step === 'sink' ? 'fanout' : step === 'ngu' ? 'fanoutSink' : 'FANOUT';
const secondName = step === 'ngu' ? 'buybackSink' : 'BUYBACK';
const [first, second] = await Promise.all([
  pub.readContract({ address: receipt.contractAddress, abi: immutableAbi, functionName: firstName }),
  step === 'sink' ? Promise.resolve(null) : pub.readContract({ address: receipt.contractAddress, abi: immutableAbi, functionName: secondName }),
]);
if (first.toLowerCase() !== (step === 'sink' ? forwarder : sink).toLowerCase()
  || (second && second.toLowerCase() !== buyback.toLowerCase())) {
  throw new Error(`${step} deployed but immutable wiring invalid: ${hash}`);
}
console.log(JSON.stringify({ step, hash, status: receipt.status, blockNumber: String(receipt.blockNumber), address: receipt.contractAddress }));
