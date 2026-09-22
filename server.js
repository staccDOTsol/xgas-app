import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http as viemHttp, parseAbi, formatEther, encodeFunctionData, decodeFunctionResult, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ALL_TOOLS, TOOLS_BY_NAME, isBrowserSafe, unwrap } from './mcp/src/registry.mjs';
import { createServer as createMcpServer, isHostable, hostableFor, VERSION as MCP_VERSION } from './mcp/src/server.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The single source of truth for every address: written by the Orbit deployment, committed to the repo.
const DEPLOY = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'contracts', 'l4-deployment.json'), 'utf8'));

const app = express();
const PORT = process.env.PORT || 3000;
const ORBIT_L4_CHAIN_ID = DEPLOY.chainId;
const L3_CHAIN_ID = DEPLOY.parentChainId;
const L3_RPC = process.env.VITE_ROBINHOOD_RPC_URL || DEPLOY.parentRpcUrl;
// Nitro sequencer: reach it over Fly's private network when we're on Fly, else the public URL.
const L4_RPC_INTERNAL = process.env.L4_RPC_INTERNAL || (process.env.FLY_APP_NAME ? 'http://xgas-l3.internal:8449' : DEPLOY.sequencerRpcUrl);
const L4_RPC_PUBLIC = DEPLOY.publicRpcUrl; // https://xgas.dev/rpc — the only RPC URL users ever see
// Key allowed to execute Outbox withdrawals on Robinhood on users' behalf (permissionless call; we just pay gas).
// The Fly secret is still named L2_EXECUTOR_KEY from before the L2->L3->L4 rename.
// Accept either, so renaming the code does not silently switch the Outbox executor off.
const L3_EXECUTOR_KEY = process.env.L3_EXECUTOR_KEY || process.env.L2_EXECUTOR_KEY || '';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'l4-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const l3Client = createPublicClient({ transport: viemHttp(L3_RPC) });
const l4Client = createPublicClient({ transport: viemHttp(L4_RPC_INTERNAL, { timeout: 15_000 }) });

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// /rpc -> the Nitro sequencer. Kept so wallets configured with https://xgas.dev/rpc keep working.
// ---------------------------------------------------------------------------
app.post(['/rpc', '/api/rpc'], (req, res) => {
  const body = JSON.stringify(req.body);
  const target = new URL(L4_RPC_INTERNAL);
  const mod = target.protocol === 'https:' ? https : http;
  const proxyReq = mod.request({
    hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname || '/', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 20_000,
  }, (proxyRes) => { res.writeHead(proxyRes.statusCode || 200, { 'content-type': 'application/json' }); proxyRes.pipe(res, { end: true }); });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('timeout')));
  proxyReq.on('error', (err) => {
    console.error('L4 RPC proxy error:', err.message);
    res.status(502).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'xgas Orbit L4 sequencer unreachable' } });
  });
  proxyReq.write(body); proxyReq.end();
});

// /das/* -> the AnyTrust data availability server's REST interface (batch data by hash), for third-party nodes.
app.get('/das/*', (req, res) => {
  const target = new URL(process.env.DAS_REST_INTERNAL || (process.env.FLY_APP_NAME ? 'http://xgas-l3.internal:9877' : DEPLOY.sequencerRpcUrl.replace(/:\d+$/, '') + ':9877'));
  const proxyReq = http.request({ hostname: target.hostname, port: target.port || 80, path: req.originalUrl.replace(/^\/das/, '') || '/', method: 'GET', timeout: 20_000 }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, { 'content-type': proxyRes.headers['content-type'] || 'application/json' });
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', () => res.status(502).json({ error: 'DAS unreachable' }));
  proxyReq.end();
});

// ---------------------------------------------------------------------------
// Chain info
// ---------------------------------------------------------------------------
let l4Head = { block: 0, at: 0 };
async function refreshHead() {
  try { const n = await l4Client.getBlockNumber(); l4Head = { block: Number(n), at: Date.now() }; } catch (e) { /* keep last */ }
}
setInterval(refreshHead, 5000); refreshHead();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, l4Ready: Date.now() - l4Head.at < 60_000, l4Head: l4Head.block, chainId: ORBIT_L4_CHAIN_ID, executor: !!L3_EXECUTOR_KEY });
});

app.get('/api/l4-info', (_req, res) => {
  res.json({
    chainId: ORBIT_L4_CHAIN_ID, rpcPath: '/rpc', rpcUrl: L4_RPC_PUBLIC, wsUrl: DEPLOY.wsUrl,
    l3ChainId: L3_CHAIN_ID, vault: DEPLOY.l3.xMoney, ready: Date.now() - l4Head.at < 60_000, head: l4Head.block,
    contracts: DEPLOY.l4, l3: DEPLOY.l3, deployment: { createRollupTx: DEPLOY.createRollupTx, createdAt: DEPLOY.createdAt, deployedAtBlock: DEPLOY.deployedAtBlock, owner: DEPLOY.owner, batchPoster: DEPLOY.batchPoster, validator: DEPLOY.validator },
  });
});

app.get('/api/l4-balance/:address', async (req, res) => {
  try {
    const address = req.params.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: 'Invalid address' });
    const wei = await l4Client.getBalance({ address });
    res.json({ address, chainId: ORBIT_L4_CHAIN_ID, balanceWei: wei.toString(), balance: formatEther(wei) });
  } catch (e) { res.status(500).json({ error: e.message || 'Failed to read L4 balance' }); }
});

// ---------------------------------------------------------------------------
// Withdrawals (L4 -> L3): ArbSys.withdrawEth on the L4 emits L2ToL1Tx; once the assertion covering it is
// confirmed on Robinhood, anyone can execute it on the Outbox. We track them and execute for users.
// ---------------------------------------------------------------------------
const ARBSYS_ABI = parseAbi([
  'event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)'
]);
const OUTBOX_ABI = parseAbi([
  'function isSpent(uint256 index) view returns (bool)',
  'function roots(bytes32) view returns (bytes32)',
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)'
]);
const ROLLUP_ABI = parseAbi([
  'function latestConfirmed() view returns (bytes32)',
  'event AssertionConfirmed(bytes32 indexed assertionHash, bytes32 blockHash, bytes32 sendRoot)'
]);
const NODE_INTERFACE_ABI = parseAbi([
  'function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)'
]);

const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.json');
let withdrawals = {}; // txHash -> { ...event, status }
try { if (fs.existsSync(WITHDRAWALS_FILE)) withdrawals = JSON.parse(fs.readFileSync(WITHDRAWALS_FILE, 'utf8')); } catch {}
const saveWithdrawals = () => { try { fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(withdrawals)); } catch {} };
let scannedTo = 0n;

async function scanWithdrawals() {
  try {
    const head = await l4Client.getBlockNumber();
    if (head <= scannedTo) return;
    const from = scannedTo === 0n ? 0n : scannedTo + 1n;
    const logs = await l4Client.getLogs({ address: DEPLOY.l4.arbSys, event: ARBSYS_ABI[0], fromBlock: from, toBlock: head });
    for (const log of logs) {
      const a = log.args;
      const key = `${log.transactionHash}:${a.position}`;
      if (withdrawals[key]) continue;
      withdrawals[key] = {
        txHash: log.transactionHash, caller: a.caller, destination: a.destination, position: a.position.toString(),
        arbBlockNum: a.arbBlockNum.toString(), ethBlockNum: a.ethBlockNum.toString(), timestamp: a.timestamp.toString(),
        callvalue: a.callvalue.toString(), data: a.data, status: 'pending', createdAt: Date.now(),
      };
    }
    scannedTo = head;
    if (logs.length) saveWithdrawals();
  } catch (e) { console.warn('[withdrawals] scan error:', e?.message || e); }
}

/** sendCount of the latest confirmed assertion on Robinhood = how many L4->L3 sends are executable. */
let confirmedSendCount = { count: 0n, at: 0 };
async function refreshConfirmedSendCount() {
  try {
    const hash = await l3Client.readContract({ address: DEPLOY.l3.rollup, abi: ROLLUP_ABI, functionName: 'latestConfirmed' });
    if (confirmedSendCount.hash === hash) { confirmedSendCount.at = Date.now(); return; }
    const logs = await l3Client.getLogs({ address: DEPLOY.l3.rollup, event: ROLLUP_ABI[1], args: { assertionHash: hash }, fromBlock: BigInt(DEPLOY.deployedAtBlock), toBlock: 'latest' });
    if (logs.length === 0) { confirmedSendCount = { count: 0n, at: Date.now(), hash, l4Block: 0 }; return; } // still at genesis
    const blockHash = logs[logs.length - 1].args.blockHash;
    const block = await l4Client.request({ method: 'eth_getBlockByHash', params: [blockHash, false] });
    confirmedSendCount = { count: BigInt(block?.sendCount ?? '0x0'), at: Date.now(), hash, blockHash, l4Block: block ? parseInt(block.number, 16) : null };
    console.log(`[withdrawals] latest confirmed assertion ${hash.slice(0, 10)} -> L4 block ${confirmedSendCount.l4Block}, sendCount ${confirmedSendCount.count}`);
  } catch (e) { console.warn('[withdrawals] confirmed send count error:', e?.message || e); }
}

async function withdrawalStatus(w) {
  if (w.status === 'executed') return w;
  try {
    const spent = await l3Client.readContract({ address: DEPLOY.l3.outbox, abi: OUTBOX_ABI, functionName: 'isSpent', args: [BigInt(w.position)] });
    if (spent) { w.status = 'executed'; return w; }
  } catch {}
  w.status = BigInt(w.position) < confirmedSendCount.count ? 'claimable' : 'pending';
  return w;
}

app.get('/api/withdrawals/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return res.status(400).json({ error: 'Invalid address' });
    await scanWithdrawals();
    const mine = Object.values(withdrawals).filter(w => w.caller.toLowerCase() === addr || w.destination.toLowerCase() === addr);
    for (const w of mine) await withdrawalStatus(w);
    saveWithdrawals();
    res.json({ confirmedSendCount: confirmedSendCount.count.toString(), confirmedL4Block: confirmedSendCount.l4Block ?? null, executorEnabled: !!L3_EXECUTOR_KEY,
      withdrawals: mine.sort((a, b) => Number(b.position) - Number(a.position)).map(w => ({ ...w, amount: formatEther(BigInt(w.callvalue)) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdrawals/execute', async (req, res) => {
  try {
    if (!L3_EXECUTOR_KEY) return res.status(503).json({ error: 'Executor not configured on host; execute the Outbox claim from your own wallet.' });
    const { txHash, position } = req.body || {};
    const key = Object.keys(withdrawals).find(k => k.startsWith(String(txHash).toLowerCase()) || k.endsWith(`:${position}`));
    const w = key && withdrawals[key];
    if (!w) return res.status(404).json({ error: 'Unknown withdrawal' });
    await refreshConfirmedSendCount();
    await withdrawalStatus(w);
    if (w.status === 'executed') return res.json({ ok: true, alreadyExecuted: true });
    if (w.status !== 'claimable') return res.status(409).json({ error: 'Not yet confirmed on Robinhood Chain', status: w.status });

    const size = confirmedSendCount.count;
    const proofRes = await l4Client.readContract({ address: DEPLOY.l4.nodeInterface, abi: NODE_INTERFACE_ABI, functionName: 'constructOutboxProof', args: [size, BigInt(w.position)] });
    const [, , proof] = proofRes;
    const account = privateKeyToAccount(L3_EXECUTOR_KEY);
    const wallet = createWalletClient({ account, transport: viemHttp(L3_RPC) });
    const hash = await wallet.writeContract({
      address: DEPLOY.l3.outbox, abi: OUTBOX_ABI, functionName: 'executeTransaction', chain: null,
      args: [proof, BigInt(w.position), w.caller, w.destination, BigInt(w.arbBlockNum), BigInt(w.ethBlockNum), BigInt(w.timestamp), BigInt(w.callvalue), w.data],
    });
    const rc = await l3Client.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') return res.status(500).json({ error: 'Outbox execution reverted', txHash: hash });
    w.status = 'executed'; w.executedTx = hash; saveWithdrawals();
    res.json({ ok: true, txHash: hash });
  } catch (e) { console.error('[withdrawals/execute]', e); res.status(500).json({ error: e.shortMessage || e.message }); }
});

setInterval(refreshConfirmedSendCount, 15_000); refreshConfirmedSendCount();
setInterval(scanWithdrawals, 10_000);

// ---------------------------------------------------------------------------
// Sign in with X (OAuth 2.0 + PKCE). Configure with Fly secrets:
//   X_CLIENT_ID (required), X_CLIENT_SECRET (confidential clients), X_CALLBACK_URL (default https://xgas.dev/auth/x/callback)
// Sessions are HMAC-signed cookies; the signing key persists in DATA_DIR so logins survive restarts.
// ---------------------------------------------------------------------------
const X_CLIENT_ID = process.env.X_CLIENT_ID || '';
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
const X_CALLBACK_URL = process.env.X_CALLBACK_URL || 'https://xgas.dev/auth/x/callback';
const X_AUTH_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me?user.fields=profile_image_url,name,username';
const SESSION_COOKIE = 'xgas_sess';
const OAUTH_COOKIE = 'xgas_oauth';
const SESSION_TTL_S = 30 * 24 * 3600;

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'session-secret');
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}
const SESSION_SECRET = loadSessionSecret();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function sign(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isSecure(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
}
function setCookie(req, res, name, value, maxAgeS) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(req, res, name) {
  setCookie(req, res, name, '', 0);
}
function safeReturnTo(v) {
  return typeof v === 'string' && /^\/[a-z0-9_-]*$/i.test(v) ? v : '/';
}
function currentUser(req) {
  const sess = verify(parseCookies(req)[SESSION_COOKIE]);
  return sess && sess.handle ? { id: sess.id, handle: sess.handle, name: sess.name, avatar: sess.avatar } : null;
}

app.get('/api/me', (req, res) => {
  res.json({ configured: !!X_CLIENT_ID, user: currentUser(req) });
});

app.get('/auth/x/login', (req, res) => {
  if (!X_CLIENT_ID) return res.status(503).send('Sign in with X is not configured (X_CLIENT_ID missing).');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const returnTo = safeReturnTo(req.query.returnTo);
  setCookie(req, res, OAUTH_COOKIE, sign({ state, verifier, returnTo, exp: Date.now() + 10 * 60 * 1000 }), 600);
  const url = new URL(X_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', X_CLIENT_ID);
  url.searchParams.set('redirect_uri', X_CALLBACK_URL);
  url.searchParams.set('scope', 'users.read tweet.read');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

app.get('/auth/x/callback', async (req, res) => {
  try {
    const pending = verify(parseCookies(req)[OAUTH_COOKIE]);
    clearCookie(req, res, OAUTH_COOKIE);
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/?xauth=denied&reason=${encodeURIComponent(String(error_description || error))}`);
    if (!pending || !code || state !== pending.state) return res.status(400).send('Invalid OAuth state. Start again from the site.');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: X_CALLBACK_URL,
      code_verifier: pending.verifier,
      client_id: X_CLIENT_ID,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (X_CLIENT_SECRET) headers.Authorization = 'Basic ' + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(X_TOKEN_URL, { method: 'POST', headers, body: form });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) {
      console.error('[X AUTH] token exchange failed:', token);
      return res.status(502).send(`X token exchange failed: ${token.error_description || token.error || tokenRes.status}`);
    }
    const meRes = await fetch(X_ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const me = await meRes.json();
    if (!meRes.ok || !me.data?.username) {
      console.error('[X AUTH] users/me failed:', me);
      return res.status(502).send('Could not read your X profile.');
    }
    const sess = { id: me.data.id, handle: me.data.username, name: me.data.name, avatar: me.data.profile_image_url, exp: Date.now() + SESSION_TTL_S * 1000 };
    setCookie(req, res, SESSION_COOKIE, sign(sess), SESSION_TTL_S);
    console.log(`[X AUTH] @${me.data.username} signed in`);
    res.redirect(pending.returnTo || '/');
  } catch (e) {
    console.error('[X AUTH] callback error:', e);
    res.status(500).send('Sign in with X failed.');
  }
});

app.post('/auth/x/logout', (req, res) => {
  clearCookie(req, res, SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Connector API: the same quote/prepare tools the MCP serves, over HTTP for the site.
// Reads and prepares only — a prepared transaction is inert until the user's wallet
// signs it, and the browser sends through the wallet, so the submit relays stay off.
// ---------------------------------------------------------------------------
app.get('/api/connector', (req, res) => {
  // Anonymous callers (the site in someone's browser) get reads and prepares. A caller holding the
  // connector's token is the operator, not a visitor, and gets the same surface as the hosted MCP:
  // the submit relays and the agent wallet included.
  const operator = authed(req);
  const allow = operator ? hostableFor(true) : isBrowserSafe;
  res.json({
    authenticated: operator,
    tools: ALL_TOOLS.filter((t) => allow(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
});

app.post('/api/connector/:tool', async (req, res) => {
  const name = req.params.tool;
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return res.status(404).json({ error: `No such tool: ${name}` });
  const operator = authed(req);
  const allow = operator ? hostableFor(true) : isBrowserSafe;
  if (!allow(name)) {
    return res.status(403).json({
      error: name.startsWith('wallet_') || name.startsWith('submit_')
        ? `${name} needs the connector's token: send Authorization: Bearer <MCP_AUTH_TOKEN>. Without it this endpoint only reads and prepares, and your own wallet signs.`
        : `${name} is not exposed over HTTP at all; it spends this host's own gas.`,
    });
  }
  try {
    const out = unwrap(await tool.handler(req.body || {}));
    if (out.isError) return res.status(400).json({ error: out.summary });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.shortMessage || e.message || 'connector call failed' });
  }
});

// ---------------------------------------------------------------------------
// The connector itself, hosted: POST /mcp speaks MCP over Streamable HTTP, so a host can
// add https://xgas.dev/mcp as a remote server instead of running node locally. Stateless —
// one server per request, no session to lose — and claim_exit stays off it, because that one
// spends this host's gas. Everything else here is reads, prepares, and relaying transactions
// the user has already signed.
// ---------------------------------------------------------------------------
const MCP_TOOL_COUNT = ALL_TOOLS.filter((t) => isHostable(t.name)).length;
// The agent's Privy wallet reaches the hosted connector only behind this token. No token set on the host
// means no wallet tools over HTTP at all, which is the safe default for a public URL.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const authed = (req) => {
  if (!MCP_AUTH_TOKEN) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-mcp-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(MCP_AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

app.all('/mcp', async (req, res) => {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream and no session to end: say so in MCP's own shape.
    return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'This endpoint is stateless: POST JSON-RPC to it.' }, id: null });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const { server } = createMcpServer({ allow: hostableFor(authed(req)) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[MCP]', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message || 'internal error' }, id: null });
  }
});

// What a person (or a host's "add server" screen) needs to wire it up, and what it can do.
app.get('/api/mcp', (_req, res) => {
  res.json({
    name: 'xgas-mcp',
    version: MCP_VERSION,
    transport: { http: `${PUBLIC_ORIGIN}/mcp`, stdio: 'npx -y xgas-mcp' },
    npm: 'https://www.npmjs.com/package/xgas-mcp',
    tool_count: MCP_TOOL_COUNT,
    custodial: false,
    // The wallet tools exist, and the hosted endpoint serves them only to a caller with the token.
    wallet_tools: ALL_TOOLS.filter((t) => t.name.startsWith('wallet_')).map((t) => t.name),
    wallet_tools_over_http: MCP_AUTH_TOKEN ? 'with an Authorization: Bearer token' : 'disabled on this host',
    tools: ALL_TOOLS.filter((t) => isHostable(t.name)).map(({ name, description }) => ({
      name,
      description,
      kind: name.startsWith('prepare_') || ['post_ask', 'post_bid', 'take_ask', 'take_bid', 'release_trade', 'reclaim_timeout', 'cancel_order', 'launch_ngu_token', 'ramp_start'].includes(name)
        ? 'prepare'
        : name.startsWith('submit_') ? 'submit' : 'read',
    })),
  });
});

// ---------------------------------------------------------------------------
// Frontend + per-order / per-trade link previews.
// /order/:id and /trade/:id are client routes; for crawlers (X, Discord, iMessage) we
// rewrite the OG/Twitter tags from live escrow state so the card describes that offer.
// ---------------------------------------------------------------------------
const ESCROW_VIEW_ABI = parseAbi([
  'function orders(uint256) view returns (address maker, string makerXHandle, uint8 side, uint256 availableXMoney, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount, bool active)',
  'function trades(uint256) view returns (uint256 orderId, uint8 side, address seller, string sellerXHandle, address buyer, string buyerXHandle, uint256 xMoneyAmount, uint256 expectedCents, uint256 deadline, bool completed, bool cancelled)'
]);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://xgas.dev';

async function l4Call(to, data) {
  return l4Client.call({ to, data }).then(r => r.data);
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let indexHtmlCache = null;
function indexHtml() {
  if (!indexHtmlCache || process.env.NODE_ENV !== 'production') {
    indexHtmlCache = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  }
  return indexHtmlCache;
}

function withMeta(html, { title, description, url }) {
  const t = escapeHtml(title), d = escapeHtml(description), u = escapeHtml(url);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${d}$2`);
}

const fmtX = (wei) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 });

app.get(['/order/:id', '/offer/:id', '/bid/:id', '/ask/:id'], async (req, res) => {
  let html = indexHtml();
  try {
    const id = BigInt(req.params.id);
    if (DEPLOY.l4.escrow) {
      const data = encodeFunctionData({ abi: ESCROW_VIEW_ABI, functionName: 'orders', args: [id] });
      const raw = await l4Call(DEPLOY.l4.escrow, data);
      const o = decodeFunctionResult({ abi: ESCROW_VIEW_ABI, functionName: 'orders', data: raw });
      const [maker, handle, side, available, rateBps, minAmt, maxAmt, active] = o;
      if (maker !== '0x0000000000000000000000000000000000000000') {
        const kind = Number(side) === 0 ? 'Sell Ask' : 'Buy Bid';
        const verb = Number(side) === 0 ? 'Buy' : 'Sell';
        const price = (Number(rateBps) / 10000).toFixed(3);
        const title = `${kind} #${id}: ${verb} ${fmtX(available)} $xMoney @ $${price} · @${handle} · xgas Orbit L4`;
        const description = active
          ? `${verb} ${fmtX(minAmt)}–${fmtX(maxAmt)} $xMoney per trade at $${price} USD on X Money, escrowed on xgas Orbit L4 #466301. 0.01% burn · 0.01% Stacc Fanout.`
          : `This ${kind.toLowerCase()} by @${handle} is closed. Browse live offers and bids on the xgas Orbit L4 desk.`;
        html = withMeta(html, { title, description, url: `${PUBLIC_ORIGIN}/order/${id}` });
      }
    }
  } catch (e) {
    console.warn('[OG] order preview failed:', e?.message || e);
  }
  res.type('html').send(html);
});

app.get(['/trade/:id', '/settlement/:id'], async (req, res) => {
  let html = indexHtml();
  try {
    const id = BigInt(req.params.id);
    if (DEPLOY.l4.escrow) {
      const data = encodeFunctionData({ abi: ESCROW_VIEW_ABI, functionName: 'trades', args: [id] });
      const raw = await l4Call(DEPLOY.l4.escrow, data);
      const t = decodeFunctionResult({ abi: ESCROW_VIEW_ABI, functionName: 'trades', data: raw });
      const [orderId, , seller, sellerHandle, , buyerHandle, amount, cents, , completed, cancelled] = t;
      if (seller !== '0x0000000000000000000000000000000000000000') {
        const state = completed ? 'Released' : cancelled ? 'Cancelled' : 'In escrow';
        const title = `Trade #${id} (${state}): @${buyerHandle} ← ${fmtX(amount)} $xMoney ← @${sellerHandle} · xgas Orbit L4`;
        const description = `${fmtX(amount)} $xMoney against $${(Number(cents) / 100).toFixed(2)} USD on X Money, from order #${orderId}. Escrowed on xgas Orbit L4 #466301.`;
        html = withMeta(html, { title, description, url: `${PUBLIC_ORIGIN}/trade/${id}` });
      }
    }
  } catch (e) {
    console.warn('[OG] trade preview failed:', e?.message || e);
  }
  res.type('html').send(html);
});

// Serve frontend build
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`xgas Orbit app listening on port ${PORT}; L4 sequencer at ${L4_RPC_INTERNAL} (public ${L4_RPC_PUBLIC})`);
});
