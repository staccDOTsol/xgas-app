#!/usr/bin/env node
// Live canary for PumpDrop on the xGas L4, driven entirely through the MCP connector's prepare tools:
// launch → mint 2 → sell 1 back → mint the rest (graduates) → check the locked pool exists.
// This is the path that bricked on the first DropFactory (graduation re-minted a sold-back id).
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

const launch = await t('launch_pump_drop', { name: 'xgas pump canary', symbol: 'XPUMP', supply: 4, base_price_xmoney: '0.0005', final_price_xmoney: '0.001', creator_fee_bps: 100, protocol_fee_bps: 100 });
const h = await sign(launch, 'launch');
const found = await t('find_drop_launch', { tx_hash: h });
const col = found.data.collection;
console.log('collection', col);
await sign(await t('prepare_pump_buy', { collection: col, qty: 2, to: owner }), 'mint 2');
const held = (await t('get_drop', { collection: col, holder: owner })).data.holder.ids;
console.log('holding', held.join(','));
await sign(await t('prepare_pump_sell', { collection: col, token_ids: [held[held.length - 1]], seller: owner }), `sell back #${held[held.length - 1]}`);
const before = (await t('get_drop', { collection: col })).data;
console.log(`minted ${before.minted}/${before.supply}; minting the rest graduates it`);
await sign(await t('prepare_pump_buy', { collection: col, qty: before.remaining, to: owner }), `mint ${before.remaining} (graduation)`);
const after = (await t('get_drop', { collection: col })).data;
if (!after.graduated || !after.vault) throw new Error('did not graduate');
console.log(`graduated: vault ${after.vault}, pool ${after.pool_id}`);
const m = (await t('get_peg_market', { vault: after.vault })).data.markets[0];
console.log(`peg market: ${m.nfts_in_vault} NFTs in vault; buy floor ${m.buy_floor_xmoney ?? 'n/a'}, sell one ${m.sell_one_xmoney ?? 'n/a'}`);
process.exit(0);
