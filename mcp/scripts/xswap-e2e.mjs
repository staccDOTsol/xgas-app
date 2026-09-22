/**
 * The whole X Money swap, start to finish, against a fork — through the connector, the way a host would drive it.
 *
 *   anvil --fork-url https://staccpad.fun/rpc --port 8547 --silent
 *   XGAS_PARENT_RPC=http://127.0.0.1:8547 node scripts/xswap-e2e.mjs
 *
 * Open an intent, let a solver bid, accept, deliver, confirm, and check the money landed where the contract says
 * it should. It refuses to run against anything but a fork: it rewrites token balances to set the scene.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, formatUnits, http, keccak256, pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.XGAS_PARENT_RPC || 'http://127.0.0.1:8547';
const here = path.dirname(fileURLToPath(import.meta.url));

const { XSWAP, PARENT_CHAIN_ID } = await import('../src/config.mjs');
const { XSWAP_INTENTS_ABI } = await import('../src/abis.mjs');
const ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const chain = defineChain({ id: PARENT_CHAIN_ID, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const raw = (method, params) => pub.request({ method, params });

const USER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SOLVER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });

let failures = 0;
const step = (ok, text) => { if (!ok) failures++; console.log(`${ok ? ' ok ' : 'FAIL'} ${text}`); };

// ── the scene: a fork, and two wallets with X Money in them ────────────────────────────────────────────────────
const isFork = await raw('anvil_nodeInfo', []).then(() => true).catch(() => false);
if (!isFork) { console.error(`${RPC} is not an anvil fork. This script writes storage; it will not touch a real chain.`); process.exit(2); }

const XM = 10n ** 18n;
async function deal(who, amount) {
  for (let slot = 0; slot < 24; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, BigInt(slot)]));
    const before = await pub.readContract({ address: XSWAP.xmoney, abi: ERC20, functionName: 'balanceOf', args: [who] });
    await raw('anvil_setStorageAt', [XSWAP.xmoney, key, pad(toHex(amount), { size: 32 })]);
    const after = await pub.readContract({ address: XSWAP.xmoney, abi: ERC20, functionName: 'balanceOf', args: [who] });
    if (after === amount && after !== before) return slot;
    await raw('anvil_setStorageAt', [XSWAP.xmoney, key, pad(toHex(before), { size: 32 })]);
  }
  throw new Error('Could not find the balance slot on the X Money token.');
}
for (const a of [USER.address, SOLVER.address]) await raw('anvil_setBalance', [a, toHex(10n * XM)]);
const slot = await deal(USER.address, 100n * XM);
await deal(SOLVER.address, 100n * XM);
step(true, `fork ready: X Money balances written (slot ${slot}), both wallets hold 100`);

// ── the connector, over real MCP stdio, pointed at the fork ────────────────────────────────────────────────────
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'src', 'index.mjs')], env: { ...process.env, XGAS_PARENT_RPC: RPC } });
const mcp = new Client({ name: 'xswap-e2e', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

const call = async (name, args) => {
  const res = await mcp.callTool({ name, arguments: args });
  const text = res.content[0].text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  return { text, data: m ? JSON.parse(m[1]) : null, isError: !!res.isError };
};
/** Sign every unsigned transaction the connector handed back, in order, and relay them through submit_xswap. */
async function signAndSubmit(account, prep, key) {
  const w = wallet(account);
  const signed = [];
  let nonce = await pub.getTransactionCount({ address: account.address });
  for (const t of prep.data.transactions) {
    const req = await w.prepareTransactionRequest({ to: t.to, data: t.data, value: BigInt(t.value), nonce: nonce++, gas: 1_500_000n });
    signed.push(await w.signTransaction(req));
  }
  const out = await call('submit_xswap', { signed_txs: signed, idempotency_key: key });
  if (out.isError) throw new Error(out.text);
  return out;
}

// ── 1. open: X Money in, 0.01 ETH out on Base ──────────────────────────────────────────────────────────────────
const prep = await call('prepare_xswap_out', {
  from: USER.address, xmoney_amount: '10', chain: 'base', asset: 'native', amount: '0.01',
  to: '0x000000000000000000000000000000000000dEaD', deadline_minutes: 30,
});
step(!prep.isError && prep.data.transactions.length === 2, `prepared: ${prep.data?.transactions?.length} unsigned txs (approve + open), nothing signed`);
const id = prep.data.intent_id;

const sent = await signAndSubmit(USER, prep, `e2e-open-${id}`);
step(sent.data.hashes?.length === 2, `opened: ${sent.data.hashes?.length} txs relayed`);
const replay = await call('submit_xswap', { signed_txs: ['0xdeadbeef'], idempotency_key: `e2e-open-${id}` });
step(replay.data?.replayed === true, 'idempotency key replayed instead of sending again');

let st = await call('xswap_status', { id });
step(st.data?.state_code === 0 && st.data.escrowed === '10', `status: ${st.data?.state}, ${st.data?.escrowed} X Money escrowed`);

// ── 2. a solver bids 8, then the user accepts ──────────────────────────────────────────────────────────────────
const bond = 10n * XM; // bondBps 100% of the escrow
const bidPrep = await call('prepare_xswap_action', { id, action: 'bid', from: SOLVER.address, ask: '8' });
step(!bidPrep.isError && bidPrep.data.transactions.length === 2, `solver prepared a bid: ${bidPrep.data?.transactions?.length} txs (approve the bond, then bid)`);
await signAndSubmit(SOLVER, bidPrep, `e2e-bid-${id}`);
st = await call('xswap_status', { id });
step(st.data?.solver?.toLowerCase() === SOLVER.address.toLowerCase() && st.data.back_to_you === '2', `bid in: ask ${st.data?.solver_ask}, ${st.data?.back_to_you} comes back to the payer`);

const acc = await call('prepare_xswap_action', { id, action: 'accept' });
await signAndSubmit(USER, acc, `e2e-accept-${id}`);
st = await call('xswap_status', { id });
step(st.data?.state_code === 1, `accepted: ${st.data?.state}`);

// ── 3. the solver delivers over there and claims here; the user confirms ───────────────────────────────────────
const claimPrep = await call('prepare_xswap_action', { id, action: 'claim', from: SOLVER.address, proof: keccak256('0x1234') });
await signAndSubmit(SOLVER, claimPrep, `e2e-claim-${id}`);
st = await call('xswap_status', { id });
step(st.data?.state_code === 2, `claimed: ${st.data?.state}`);

const before = await pub.readContract({ address: XSWAP.xmoney, abi: ERC20, functionName: 'balanceOf', args: [USER.address] });
const conf = await call('prepare_xswap_action', { id, action: 'confirm' });
await signAndSubmit(USER, conf, `e2e-confirm-${id}`);
const after = await pub.readContract({ address: XSWAP.xmoney, abi: ERC20, functionName: 'balanceOf', args: [USER.address] });
st = await call('xswap_status', { id });
step(st.data?.state_code === 3, `confirmed: ${st.data?.state}`);
step(after - before === 2n * XM, `bidding handed back ${formatUnits(after - before, 18)} X Money to the payer (expected 2)`);

const credit = await pub.readContract({ address: XSWAP.intents, abi: XSWAP_INTENTS_ABI, functionName: 'credit', args: [SOLVER.address] });
step(credit === 8n * XM - (8n * XM * 50n) / 10_000n + bond, `solver credited ${formatUnits(credit, 18)} X Money (ask less fee, plus bond back)`);

const rep = await call('xswap_reputation', { address: SOLVER.address });
step(rep.data?.filled === 1, `reputation: ${rep.text.split('\n')[0]}`);

// ── 4. the other direction: an ask is a price, not an escrow ───────────────────────────────────────────────────
const askPrep = await call('prepare_xswap_in', { from: USER.address, want_xmoney: '5', chain: 'apechain', asset: '0x0000000000000000000000000000000000000001', token_id: '42', deadline_minutes: 60 });
await signAndSubmit(USER, askPrep, `e2e-ask-${askPrep.data.ask_id}`);
const askSt = await call('xswap_status', { id: askPrep.data.ask_id });
step(askSt.data?.side === 'in' && askSt.data.floor === '5', `ask posted: ${askSt.data?.state}, floor ${askSt.data?.floor} X Money`);

const mine = await call('list_my_xswaps', { address: USER.address, lookback_blocks: 5000 });
step(mine.data?.swaps?.length === 2, `list_my_xswaps sees ${mine.data?.swaps?.length} swaps for the payer`);

await mcp.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall good: the whole swap ran through the connector');
process.exit(failures ? 1 : 0);
