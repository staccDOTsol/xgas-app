#!/usr/bin/env node
// Bootstrap Arachnid's deterministic-deployment proxy (0x4e59b44847b379578588920cA78FbF26c0B4956C) on the L4.
// Funds the one-shot signer with 0.01 xMoney, then publishes the presigned pre-EIP-155 transaction. Rerunnable.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = process.env.XGAS_RPC || 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const SIGNER = '0x3fab184622dc19b6109349b94811493bf2a45362';
const NEED = parseEther('0.01'); // 100000 gas * 100 gwei
const PRESIGNED = '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';

if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('L4 deployer profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong L4 signer');

const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
if ((await pub.getChainId()) !== 466302) throw new Error('Wrong chain');
const code = await pub.getCode({ address: PROXY });
if (code && code !== '0x') { console.log('CREATE2 proxy already live at', PROXY); process.exit(0); }
const gasPrice = await pub.getGasPrice();
if (gasPrice > 100n * 10n ** 9n) throw new Error(`Base fee ${gasPrice} > 100 gwei; presigned tx would not be included`);
const bal = await pub.getBalance({ address: SIGNER });
console.log('one-shot signer balance', formatEther(bal), 'xMoney');
if (bal < NEED) {
  const h = await wallet.sendTransaction({ to: SIGNER, value: NEED - bal });
  console.log('funding tx', h);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error('funding failed');
}
const h2 = await pub.request({ method: 'eth_sendRawTransaction', params: [PRESIGNED] });
console.log('presigned tx', h2);
const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
console.log('status', r2.status, 'contract', r2.contractAddress);
const after = await pub.getCode({ address: PROXY });
if (!after || after === '0x') throw new Error('proxy code missing after publish');
console.log('CREATE2 proxy live at', PROXY, 'codeBytes', (after.length - 2) / 2);
