// Tool output must never name the host's private RPC (fly.toml reads the parent chain through xgas-rpc.internal).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.XGAS_PARENT_RPC = 'http://xgas-rpc.internal:8545';
delete process.env.XGAS_PARENT_PUBLIC_RPC;
const cfg = await import('../src/config.mjs');

test('private hosts are recognised', () => {
  for (const u of ['http://xgas-rpc.internal:8545', 'http://localhost:8545', 'http://10.0.0.4', 'http://192.168.1.2:8545', 'http://172.20.0.1', 'http://nitro:8547'])
    assert.equal(cfg.isPrivateRpc(u), true, u);
  for (const u of ['https://rpc.mainnet.chain.robinhood.com', 'https://xgas.dev/rpc'])
    assert.equal(cfg.isPrivateRpc(u), false, u);
});

test('the chain objects and rpcFor name public endpoints only', () => {
  const shown = cfg.parentChain.rpcUrls.default.http[0];
  assert.equal(cfg.isPrivateRpc(shown), false, shown);
  assert.equal(shown, cfg.DEPLOY.parentRpcUrl);
  assert.equal(cfg.rpcFor(cfg.PARENT_CHAIN_ID), shown);
  assert.equal(cfg.isPrivateRpc(cfg.rpcFor(cfg.XGAS_CHAIN_ID)), false);
});

test('error text is scrubbed of the private URL', () => {
  const t = cfg.scrubRpc('HTTP request failed. URL: http://xgas-rpc.internal:8545 Request body: {}');
  assert.equal(t.includes('xgas-rpc.internal'), false, t);
});

test('get_chain_info output contains no private host', async () => {
  const { tools } = await import('../src/tools/chain.mjs');
  const t = tools.find((x) => x.name === 'get_chain_info');
  const r = await t.handler({}).catch((e) => ({ content: [{ text: String(e.message) }] }));
  const text = r.content.map((c) => c.text).join('\n');
  assert.equal(text.includes('.internal'), false);
});
