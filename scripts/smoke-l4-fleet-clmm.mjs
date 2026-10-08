#!/usr/bin/env node
// Live canary for the CLMM launchpad + pawn on the xGas L4, through the MCP connector's prepare tools:
// launch → mint 3 → open a pawn pool → lend → pawn one NFT → redeem it.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TOOLS_BY_NAME, unwrap } from '../mcp/src/registry.mjs';

const rpc = 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('profile must be owner');
const f = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(f).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const account = privateKeyToAccount(`0x${fs.readFileSync(f, 'utf8').trim().replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong signer');
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 60_000 }) });

const t = async (name, args) => {
  const out = unwrap(await TOOLS_BY_NAME.get(name).handler(args));
  if (out.isError) throw new Error(`${name}: ${out.summary}`);
  return out;
};
async function sign(prep, label) {
  let last;
  for (const tx of prep.data.transactions) {
    const req = { to: tx.to, data: tx.data, value: BigInt(tx.value) };
    const gas = (await pub.estimateGas({ account, ...req })) * 12n / 10n;
    const hash = await wallet.sendTransaction({ ...req, gas });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${label} reverted ${hash}`);
    console.log(`${label}: ok block ${r.blockNumber}`);
    last = hash;
  }
  return last;
}

import { decodeEventLog, parseAbiItem } from 'viem';
const LAUNCHED = parseAbiItem('event CollectionLaunched(address indexed collection, address indexed creator, address vault, bytes32 poolId, uint16 lpProceedsBps, uint16 lpCompanionPerMint)');
const PAWNED = parseAbiItem('event Pawned(uint256 indexed ticketId, uint256 indexed poolId, address indexed borrower, uint256 tokenId, uint256 floor, uint256 advance)');
const rcpt = (h) => pub.getTransactionReceipt({ hash: h });
const ev = (r, abi, name) => { for (const l of r.logs) { try { const e = decodeEventLog({ abi: [abi], ...l }); if (e.eventName === name) return e.args; } catch {} } return null; };

const h1 = await sign(await t('launch_clmm_collection', { name: 'xgas clmm canary', symbol: 'XCLMM', max_supply: 50, mint_price_xmoney: '0.002', lp_proceeds_bps: 5000, companions_per_mint: 1 }), 'launch');
const col = ev(await rcpt(h1), LAUNCHED, 'CollectionLaunched').collection;
console.log('collection', col);
const h2 = await sign(await t('prepare_clmm_mint', { collection: col, qty: 3 }), 'mint 3');
const s = (await t('get_clmm_collection', { collection: col })).data;
console.log(`minted ${s.minted}, companions in pool ${s.companions_in_pool}, locked position ${s.locked_position}`);
await sign(await t('create_pawn_pool', { collection: col }), 'create pawn pool');
const pools = (await t('list_pawn_pools', {})).data.pools;
const pool = pools[pools.length - 1].pool_id;
await sign(await t('prepare_pawn_lend', { pool_id: pool, amount_xmoney: '0.005', lender: owner }), `lend into pool ${pool}`);
// the buyer ids are 0, 2, 4 (each followed by its companion)
let ticket;
for (const id of ['0', '2', '4']) {
  const prep = await t('prepare_pawn', { pool_id: pool, token_id: id, borrower: owner });
  if (!prep.data?.transactions) { console.log(`#${id}: ${prep.summary.split('\n')[0]}`); continue; }
  console.log(`pawn #${id}: floor ${prep.data.quote.floor_xmoney}, advance ${prep.data.quote.advance_xmoney}`);
  const h = await sign(prep, `pawn #${id}`);
  ticket = ev(await rcpt(h), PAWNED, 'Pawned').ticketId;
  break;
}
if (ticket === undefined) throw new Error('could not pawn any NFT');
await sign(await t('prepare_pawn_redeem', { ticket_id: String(ticket), holder: owner }), `redeem ticket ${ticket}`);
console.log('pool after:', JSON.stringify((await t('list_pawn_pools', {})).data.pools.find((p) => p.pool_id === pool), ['pool_id', 'lendable_xmoney', 'borrowed_xmoney', 'borrow_apr_pct']));
process.exit(0);
