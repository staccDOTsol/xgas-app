// Local end-to-end check of the NGU tools against an anvil chain, since no NguLauncher
// is deployed on xGas yet. Start one first:
//   anvil --port 8599 --chain-id 466302
//   forge create src/NguLauncher.sol:NguLauncher --rpc-url http://127.0.0.1:8599 \
//     --private-key <anvil key 0> --broadcast --constructor-args <fanoutSink> <buybackSink>
//   cast send <launcher> 'launch(string,string,uint256,uint256,uint16,uint16,uint256)' ... --value 0.05ether
// then: XGAS_RPC=http://127.0.0.1:8599 XGAS_NGU_LAUNCHER=<launcher> TOKEN=<token> node scripts/ngu-roundtrip.mjs
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const RPC = 'http://127.0.0.1:8599';
const TOKEN = process.env.TOKEN;
// anvil's well-known account #0 — a public test key, deliberately not a secret
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const chain = { id: 466302, name: 'anvil', nativeCurrency: { name: 'x', symbol: 'x', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const RUN = Date.now().toString(36); // fresh idempotency keys, so a rerun is a real test
const ngu = await import('../src/tools/ngu.mjs');
const call = async (name, args) => { const t = ngu.tools.find((x) => x.name === name); const r = await t.handler(args); return JSON.parse(r.content[0].text.split('```json')[1].split('```')[0]); };

async function signAndSubmit(p, key) {
  const tx = p.transactions[0];
  const signed = await wallet.signTransaction({
    to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId,
    nonce: await pub.getTransactionCount({ address: account.address }),
    gas: 1_500_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1n,
  });
  const res = await call('submit_ngu', { signed_tx: signed, idempotency_key: key });
  const rc = await pub.waitForTransactionReceipt({ hash: res.hash });
  return { hash: res.hash, status: rc.status, gas: rc.gasUsed };
}

const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const bal = () => pub.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [account.address] });

console.log('tokens before:', formatEther(await bal()));
const buy = await call('prepare_ngu_buy', { token_address: TOKEN, qty: 3 });
console.log('buy quote:', buy.quote);
console.log('buy ->', await signAndSubmit(buy, `rt-buy-${RUN}`));
console.log('tokens after buy:', formatEther(await bal()));

// idempotency: the same key must not send a second transaction
const replay = await call('submit_ngu', { signed_tx: buy.transactions[0].data, idempotency_key: `rt-buy-${RUN}` });
console.log('replay returns same hash:', replay.replayed === true);

const sellQ = await call('quote_ngu_sell', { token_address: TOKEN, qty: 2 });
console.log('sell quote:', sellQ.payout_xmoney, 'basis', sellQ.sell_basis, 'minOut', sellQ.suggested_min_out_xmoney);
const sell = await call('prepare_ngu_sell', { token_address: TOKEN, qty: 2 });
console.log('sell ->', await signAndSubmit(sell, `rt-sell-${RUN}`));
console.log('tokens after sell:', formatEther(await bal()));

const donate = await call('prepare_ngu_donate', { token_address: TOKEN, xmoney_amount: '0.1' });
console.log('donate note:', donate.approval.notes[0]);
console.log('donate ->', await signAndSubmit(donate, `rt-donate-${RUN}`));
const after = await call('get_ngu_token', { token_address: TOKEN, holder: account.address });
console.log('floor after donate:', after.floor_xmoney, '| sell basis check:');
console.log((await call('quote_ngu_sell', { token_address: TOKEN, qty: 1 })).sell_basis);
