// Fake upstream JSON-RPC nodes and a tiny client for the proxy under test. Everything binds 127.0.0.1 on port 0,
// so the OS hands out free ports and nothing collides with a real service.
import http from 'node:http';
import { createProxy } from '../server.mjs';

export const hex = (n) => '0x' + n.toString(16);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// handler(msg, state) may return:
//   { result } | { error } | { status: 429|500|..., body? } (whole HTTP response) | { delay, ...one of the above }
// eth_chainId and eth_blockNumber are answered from state unless the handler returns something for them.
export async function fakeUpstream(name, { head = 1000, chainId = '0x1237', handler } = {}) {
  const state = { name, head, chainId, requests: [] };
  const answer = async (m) => {
    const custom = handler ? await handler(m, state) : undefined;
    if (custom !== undefined) return custom;
    if (m.method === 'eth_chainId') return { result: state.chainId };
    if (m.method === 'eth_blockNumber') return { result: hex(state.head) };
    if (m.method === 'eth_getLogs') return { result: [] };
    if (m.method === 'eth_getTransactionReceipt' || m.method === 'eth_getTransactionByHash') return { result: null };
    return { result: `${name}:${m.method}` };
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.requests.push(body);
      const items = Array.isArray(body) ? body : [body];
      const answers = await Promise.all(items.map(answer));
      const delay = Math.max(0, ...answers.map((a) => a.delay ?? 0));
      if (delay) await sleep(delay);
      const forced = answers.find((a) => a.status);
      if (forced) {
        res.writeHead(forced.status, { 'content-type': 'application/json', ...(forced.headers || {}) });
        return res.end(forced.body ? JSON.stringify(forced.body) : '');
      }
      const wrap = (m, a) => ('error' in a ? { jsonrpc: '2.0', id: m.id, error: a.error } : { jsonrpc: '2.0', id: m.id, result: a.result });
      const out = Array.isArray(body) ? items.map((m, i) => wrap(m, answers[i])) : wrap(body, answers[0]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ignore = new Set(['eth_chainId', 'eth_blockNumber']);
  // the proxy's boot-time clamp probe: eth_getLogs on the zero address
  const isProbe = (m) => m.method === 'eth_getLogs' && m.params?.[0]?.address === '0x0000000000000000000000000000000000000000';
  return {
    name, url, state, server,
    // traffic the proxy forwarded, not its own boot checks / head polls
    calls(method) {
      let n = 0;
      for (const b of state.requests) {
        for (const m of (Array.isArray(b) ? b : [b])) {
          if (isProbe(m)) continue;
          if (method ? m.method === method : !ignore.has(m.method)) n++;
        }
      }
      return n;
    },
    reset() { state.requests.length = 0; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export async function startProxy(fakes, opts = {}) {
  const logs = [];
  const proxy = createProxy({
    upstreams: fakes.map((f) => ({ name: f.name, url: f.url, weight: f.weight ?? 1 })),
    port: 0, host: '127.0.0.1', strategy: 'priority',
    headPollMs: 40, headTimeoutMs: 500, timeoutMs: 1_000, logsTimeoutMs: 2_000, deadlineMs: 10_000,
    statsIntervalMs: 0, verifyRetryMs: 100, capTtlMs: 60_000,
    log: (l) => logs.push(l),
    ...opts,
  });
  await proxy.start();
  const { port } = proxy.address();
  const url = `http://127.0.0.1:${port}/`;
  const send = async (payload) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return r.status === 204 ? undefined : r.json();
  };
  let nextId = 1;
  const rpc = (method, params = []) => send({ jsonrpc: '2.0', id: nextId++, method, params });
  return { proxy, url, send, rpc, logs, get: (path) => fetch(url.replace(/\/$/, '') + path) };
}

export async function waitFor(fn, { timeout = 3_000, step = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(step);
  }
}
