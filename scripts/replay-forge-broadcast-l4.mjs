#!/usr/bin/env node
// Replays a forge script's planned transactions on the xGas L4 with the node's own gas estimates.
// forge prices L4 gas as plain EVM gas and misses the parent-chain posting fee (often 10-15x for
// large initcode), so `forge script --broadcast` dies with "intrinsic gas too low".
// Usage: node scripts/replay-forge-broadcast-l4.mjs <run-latest.json> [out.json]
// Every tx is sent at the nonce forge planned and every CREATE address is checked against forge's.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const [file, outFile] = process.argv.slice(2);
if (!file) throw new Error('usage: replay-forge-broadcast-l4.mjs <run-latest.json> [out.json]');
const rpc = process.env.XGAS_RPC || 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('L4 deployer profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong L4 signer');
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 60_000 }) });
if ((await pub.getChainId()) !== 466302) throw new Error('Wrong chain');

const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
if (Number(plan.chain) !== 466302) throw new Error('Plan is not for 466302');
const out = outFile && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
out.fleet ??= {};
const save = () => outFile && fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');

for (const t of plan.transactions) {
  const tx = t.transaction;
  const name = t.contractName + (t.transactionType === 'CALL' ? `.${t.function?.split('(')[0] ?? 'call'}` : '');
  const want = BigInt(tx.nonce);
  const nonce = BigInt(await pub.getTransactionCount({ address: owner, blockTag: 'pending' }));
  if (nonce > want) {
    // Already sent in an earlier run: confirm the CREATE landed where forge said.
    if (t.contractAddress) {
      const code = await pub.getCode({ address: t.contractAddress });
      if (!code || code === '0x') throw new Error(`${name}: nonce ${want} used but no code at ${t.contractAddress}`);
    }
    console.log(`skip ${name} (nonce ${want} already used)`);
    continue;
  }
  if (nonce < want) throw new Error(`${name}: account nonce ${nonce} is behind planned ${want}; plan is stale`);
  const req = { account, data: tx.input, ...(tx.to ? { to: tx.to } : {}), value: BigInt(tx.value ?? '0x0') };
  const est = await pub.estimateGas(req);
  const gas = est * 12n / 10n;
  const hash = await wallet.sendTransaction({ ...req, nonce: Number(want), gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error(`${name} reverted: ${hash}`);
  if (t.transactionType === 'CREATE' && r.contractAddress?.toLowerCase() !== t.contractAddress?.toLowerCase()) {
    throw new Error(`${name}: landed at ${r.contractAddress}, forge planned ${t.contractAddress}`);
  }
  if (t.contractAddress) {
    const code = await pub.getCode({ address: t.contractAddress });
    if (!code || code === '0x') throw new Error(`${name}: no code at ${t.contractAddress}`);
  }
  console.log(`${name} ${t.contractAddress ?? tx.to} gas ${r.gasUsed} block ${r.blockNumber} ${hash}`);
  const entry = { address: t.contractAddress ?? tx.to, tx: hash, block: Number(r.blockNumber), gasUsed: String(r.gasUsed) };
  if (t.transactionType === 'CALL') {
    (out.calls ??= []).push({ name, ...entry });
  } else {
    // A redeploy supersedes the previous generation of the same contract; keep the old one on record.
    const prev = out.fleet[name];
    if (prev && prev.address.toLowerCase() !== entry.address.toLowerCase()) (out.superseded ??= []).push({ name, ...prev });
    out.fleet[name] = entry;
  }
  save();
}
console.log('done');
