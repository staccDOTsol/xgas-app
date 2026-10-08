#!/usr/bin/env node
// The L4 RPC refuses the presigned CREATE2-proxy tx (100k gas is under Nitro's intrinsic cost with the parent
// data fee). Delayed-inbox messages are not charged that fee, so submit the same raw tx through the Orbit Inbox
// on Robinhood (L2MessageType_signedTx = 4), exactly as Orbit's DeployHelper does.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, concatHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rhRpc = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const l4Rpc = process.env.XGAS_RPC || 'https://xgas.dev/rpc';
const rh = defineChain({ id: 4663, name: 'Robinhood', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rhRpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const INBOX = '0xa7087693676F2Ca8e5e9563A6859952258688146';
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const PRESIGNED = '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';

if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('L4 deployer profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong signer');

const rhPub = createPublicClient({ chain: rh, transport: http(rhRpc, { timeout: 20_000 }) });
const rhWallet = createWalletClient({ account, chain: rh, transport: http(rhRpc, { timeout: 20_000 }) });
const l4 = createPublicClient({ transport: http(l4Rpc, { timeout: 20_000 }) });
if ((await rhPub.getChainId()) !== 4663 || (await l4.getChainId()) !== 466302) throw new Error('Wrong chain');
const inboxAbi = parseAbi(['function sendL2Message(bytes messageData) returns (uint256)', 'function bridge() view returns (address)']);
const bridge = await rhPub.readContract({ address: INBOX, abi: inboxAbi, functionName: 'bridge' });
console.log('inbox bridge', bridge);
if (bridge.toLowerCase() !== '0x2290f4505484f055b710e7df37e2482c90b8b6fb') throw new Error('Inbox is not the 466302 inbox');
const existing = await l4.getCode({ address: PROXY });
if (existing && existing !== '0x') { console.log('proxy already live'); process.exit(0); }
const messageData = concatHex(['0x04', PRESIGNED]);
const hash = await rhWallet.writeContract({ address: INBOX, abi: inboxAbi, functionName: 'sendL2Message', args: [messageData] });
console.log('Robinhood tx', hash);
const rcpt = await rhPub.waitForTransactionReceipt({ hash });
console.log('status', rcpt.status, 'block', rcpt.blockNumber);
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 10_000));
  const code = await l4.getCode({ address: PROXY });
  if (code && code !== '0x') { console.log('CREATE2 proxy live at', PROXY, 'after', (i + 1) * 10, 's'); process.exit(0); }
  if (i % 6 === 5) console.log('waiting for delayed-inbox inclusion…', (i + 1) * 10, 's');
}
throw new Error('proxy not live after 20 min; check sequencer delayed-message handling');
