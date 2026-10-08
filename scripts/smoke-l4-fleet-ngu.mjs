#!/usr/bin/env node
// Live canary for NFT NGU on the xGas L4: launch (curve-only, then with an LP slice on the tolled
// PoolManager), buy 1, sell 1, and check the protocol fee reached the fleet treasury -> FanoutSink.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, formatEther, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const NR = '/Users/stacc/nft-range/out';
const rpc = process.env.XGAS_RPC || 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const FACTORY = process.env.NGU_FACTORY || '0x05A89b11EA80d7985fA9F90103B6AFED87CD6334';
const POSM = '0x398581b1Dfef17373CE461fCc89B0Fa7EaBcdd70';
const posmAbi = [{ type: 'function', name: 'nextTokenId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const TREASURY = '0x141B102941659ECD24A5797c2863D5c5e170f4c5';
const SINK = '0x4ca8826FBb7F69F55B858485313eAC56a1b4F458';
if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong signer');
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 60_000 }) });
const abi = n => JSON.parse(fs.readFileSync(`${NR}/${n}.sol/${n}.json`, 'utf8')).abi;
const FAC = abi('NguFactory'), COL = abi('NguCollection');

async function send(req, label) {
  const gas = (await pub.estimateGas({ account, ...req })) * 12n / 10n;
  const hash = await wallet.sendTransaction({ ...req, gas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted ${hash}`);
  console.log(`${label}: ok block ${r.blockNumber} ${hash}`);
  return r;
}
const call = (address, fn, args = []) => pub.readContract({ address, abi: COL, functionName: fn, args });
import { encodeFunctionData } from 'viem';

async function canary(tag, lpBps, companions) {
  const params = {
    name: `xgas NGU canary ${tag}`, symbol: `XNGU${tag}`, baseURI: 'https://xgas.dev/ngu/canary/',
    maxSupply: 1000n, basePrice: parseEther('0.001'), stepBps: 100, betaBps: 8000, seedQty: 0n, royaltyBps: 500n,
    buyProtocolBps: 100, sellProtocolBps: 300, lpBps, companionsPerMint: companions,
    seaDrop: { enabled: false, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, feeRecipient: '0x0000000000000000000000000000000000000000', dropURI: '' },
    extraPools: [],
  };
  const r = await send({ to: FACTORY, data: encodeFunctionData({ abi: FAC, functionName: 'launch', args: [params] }) }, `launch ${tag}`);
  let col;
  for (const l of r.logs) {
    try { const e = decodeEventLog({ abi: FAC, ...l }); if (e.eventName === 'NguLaunched') col = e.args.collection; } catch {}
  }
  if (!col) throw new Error('no NguLaunched event');
  console.log(`  collection ${col}`);
  const sinkBefore = await pub.getBalance({ address: SINK });
  const posBefore = await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'nextTokenId' });
  const cost = await call(col, 'quoteBuy', [1n]);
  console.log(`  quoteBuy(1) = ${formatEther(cost)} xMoney`);
  const br = await send({ to: col, value: cost, data: encodeFunctionData({ abi: COL, functionName: 'buy', args: [1n, owner] }) }, `  buy 1 ${tag}`);
  let id;
  for (const l of br.logs) {
    if (l.address.toLowerCase() !== col.toLowerCase()) continue; // PositionManager emits the same Transfer topic
    try { const e = decodeEventLog({ abi: COL, ...l }); if (e.eventName === 'Transfer' && e.args.to?.toLowerCase() === owner.toLowerCase()) id = e.args.tokenId; } catch {}
  }
  if (id === undefined) throw new Error('no minted id');
  const posAfter = await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'nextTokenId' });
  console.log(`  LP positions minted by this buy: ${posAfter - posBefore}`);
  if (lpBps > 0 && posAfter <= posBefore) throw new Error('LP slice did not land');
  const floor = await call(col, 'floor');
  const payout = await call(col, 'quoteSell', [1n]);
  console.log(`  minted #${id}; floor ${formatEther(floor)}; quoteSell(1) ${formatEther(payout)}`);
  await send({ to: col, data: encodeFunctionData({ abi: COL, functionName: 'sell', args: [[id], owner, payout * 99n / 100n] }) }, `  sell #${id} ${tag}`);
  const sinkAfter = await pub.getBalance({ address: SINK });
  const tre = await pub.getBalance({ address: TREASURY });
  console.log(`  fees to FanoutSink: +${formatEther(sinkAfter - sinkBefore)} xMoney; treasury residual ${formatEther(tre)}`);
  if (sinkAfter <= sinkBefore) throw new Error('protocol fee did not reach the sink');
  return col;
}

const a = await canary('A', 0, 0);
const b = await canary('B', 1000, 1);
console.log(JSON.stringify({ curveOnly: a, withLp: b }));
