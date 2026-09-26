// Passkey step-up with a software authenticator, and Plaid Link gated on it: node --test scripts/passkey.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createPasskeys } from '../server/passkey.mjs';
import { createPlaid } from '../server/plaid.mjs';

process.env.PLAID_CLIENT_ID = 'test-client';
process.env.PLAID_SECRET = 'test-secret';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith('https://sandbox.plaid.com')
  ? new Response(JSON.stringify({ link_token: 'link-sandbox-abc' }), { status: 200 })
  : realFetch(url, init);

// Minimal copies of server.js's signed-cookie helpers.
const SECRET = 'test';
const sign = (o) => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); return `${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };
const verify = (t) => {
  if (!t) return null; const [p, m] = t.split('.');
  if (m !== crypto.createHmac('sha256', SECRET).update(p).digest('base64url')) return null;
  const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp && Date.now() > o.exp ? null : o;
};
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))]; }));
const setCookie = (_req, res, n, v, age) => res.append('Set-Cookie', `${n}=${encodeURIComponent(v)}; Path=/; HttpOnly; Max-Age=${age}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-test-'));
const app = express();
app.use(express.json());
const server = app.listen(0);
const origin = `http://localhost:${server.address().port}`;
const passkeys = createPasskeys({ dataDir: dir, origin, sessionSecret: SECRET, currentUser: () => ({ id: '7', handle: 'seller_bob' }), sign, verify, parseCookies, setCookie });
passkeys.mount(app);
createPlaid({ dataDir: dir, sessionSecret: SECRET, currentUser: () => ({ id: '7', handle: 'seller_bob' }), origin, readTrade: async () => ({ status: 404, error: 'none' }), stepUp: passkeys.hasStepUp }).mount(app);
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let jar = '';
async function post(p, body) {
  const r = await realFetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar }, body: JSON.stringify(body) });
  for (const c of r.headers.getSetCookie()) jar = c.split(';')[0];
  return [r.status, await r.json()];
}

// A software authenticator: P-256 key, "none" attestation, user present + verified.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const credId = crypto.randomBytes(16);
const b64u = (b) => Buffer.from(b).toString('base64url');
const rpIdHash = crypto.createHash('sha256').update('localhost').digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

function register(challenge) {
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), u32(0), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
  const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: b64u(clientData('webauthn.create', challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] } };
}
function assert_(challenge, counter, flags = 0x05) {
  const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), u32(counter)]);
  const cd = clientData('webauthn.get', challenge);
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
  return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) } };
}

test('Plaid Link is closed without a passkey', async () => {
  const [s, j] = await post('/api/plaid/link-token', {});
  assert.equal(s, 403); assert.equal(j.needsPasskey, true);
});

test('registering a passkey grants step-up and opens Plaid Link', async () => {
  const [, opts] = await post('/api/passkey/register/options', {});
  assert.equal(opts.rp.id, 'localhost');
  assert.equal(opts.authenticatorSelection.userVerification, 'required');
  const [s, j] = await post('/api/passkey/register/verify', { response: register(opts.challenge) });
  assert.equal(s, 200, JSON.stringify(j));
  const [s2, j2] = await post('/api/plaid/link-token', {});
  assert.equal(s2, 200, JSON.stringify(j2)); assert.equal(j2.link_token, 'link-sandbox-abc');
});

test('a challenge is single use', async () => {
  const [, opts] = await post('/api/passkey/auth/options', {});
  let [s] = await post('/api/passkey/auth/verify', { response: assert_(opts.challenge, 1) });
  assert.equal(s, 200);
  [s] = await post('/api/passkey/auth/verify', { response: assert_(opts.challenge, 2) });
  assert.equal(s, 400);
});

test('without user verification, or with a stale session, it stays closed', async () => {
  jar = '';
  const [, opts] = await post('/api/passkey/auth/options', {});
  const [s, j] = await post('/api/passkey/auth/verify', { response: assert_(opts.challenge, 3, 0x01) });
  assert.equal(s, 400, JSON.stringify(j));
  const [s2] = await post('/api/plaid/link-token', {});
  assert.equal(s2, 403);
});

test('a second passkey needs step-up from the first', async () => {
  jar = '';
  let [s] = await post('/api/passkey/register/options', {});
  assert.equal(s, 403);
  const [, opts] = await post('/api/passkey/auth/options', {});
  [s] = await post('/api/passkey/auth/verify', { response: assert_(opts.challenge, 4) });
  assert.equal(s, 200);
  [s] = await post('/api/passkey/register/options', {});
  assert.equal(s, 200);
});
