// ---------------------------------------------------------------------------
// Passkeys (WebAuthn) as a step-up on top of Sign in with X, required before Plaid Link opens.
//
// X OAuth is the first factor; a passkey (Face ID, Touch ID, Windows Hello, a security key) with user
// verification is the second, and it is phishing-resistant: the browser only signs for this origin.
// A good assertion sets a signed 15-minute cookie tied to the X id; routes that need step-up check it.
// The first passkey on an X account needs only the X session (trust on first use); adding another needs a
// fresh step-up from an existing one, so a stolen X session alone can not enrol an attacker's passkey.
//
//   GET  /api/passkey                        { rpID, registered, count, stepUp }
//   POST /api/passkey/register/options       WebAuthn creation options
//   POST /api/passkey/register/verify        { response } from navigator.credentials.create; grants step-up
//   POST /api/passkey/auth/options           WebAuthn request options for this X account's passkeys
//   POST /api/passkey/auth/verify            { response } from navigator.credentials.get; grants step-up
//
// PASSKEY_RP_ID overrides the relying-party id (default: the host of PUBLIC_ORIGIN).
// ---------------------------------------------------------------------------
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const STEP_UP_COOKIE = 'xgas_mfa';
const STEP_UP_TTL_S = 15 * 60;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 5;

export function createPasskeys({ dataDir, origin, sessionSecret, currentUser, sign, verify, parseCookies, setCookie }) {
  const expectedOrigin = String(origin).replace(/\/+$/, '');
  const rpID = String(process.env.PASSKEY_RP_ID || new URL(expectedOrigin).hostname);
  // WebAuthn's user handle: stable per X account, never the X id itself.
  const userHandle = (xId) => new Uint8Array(crypto.createHmac('sha256', String(sessionSecret)).update(`passkey-user:${xId}`).digest());

  const FILE = path.join(dataDir, 'passkeys.json');
  let store = { version: 1, users: {} };
  // An unreadable store is never overwritten (it is the only copy of everyone's public keys); step-up is refused
  // until it is repaired, which keeps Plaid Link closed rather than open.
  let broken = false;
  try { if (fs.existsSync(FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { broken = true; console.error(`[passkey] ${FILE} is unreadable; passkeys are off until it is fixed:`, e.message); }
  function save(next) {
    const tmp = `${FILE}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, FILE);
    store = next;
  }
  const credsOf = (xId) => store.users[String(xId)]?.creds || [];
  const putCreds = (xId, creds) => save({ ...store, users: { ...store.users, [String(xId)]: { creds } } });

  // One outstanding challenge per X account and ceremony, single use.
  const challenges = new Map();
  const setChallenge = (xId, kind, challenge) => challenges.set(`${kind}:${xId}`, { challenge, exp: Date.now() + CHALLENGE_TTL_MS });
  function takeChallenge(xId, kind) {
    const k = `${kind}:${xId}`, c = challenges.get(k);
    challenges.delete(k);
    return c && c.exp > Date.now() ? c.challenge : null;
  }

  function hasStepUp(req, user) {
    if (!user) return false;
    const c = verify(parseCookies(req)[STEP_UP_COOKIE]);
    return !!(c && c.k === 'mfa' && String(c.id) === String(user.id));
  }
  const grant = (req, res, user) => setCookie(req, res, STEP_UP_COOKIE, sign({ k: 'mfa', id: String(user.id), exp: Date.now() + STEP_UP_TTL_S * 1000 }), STEP_UP_TTL_S);

  function gate(req, res) {
    if (broken) { res.status(503).json({ error: 'Passkeys are paused on this host while their store is repaired.' }); return null; }
    const user = currentUser(req);
    if (!user || !user.id) { res.status(401).json({ error: 'Sign in with X first.' }); return null; }
    return user;
  }
  const fail = (res, e, what) => res.status(400).json({ error: `The passkey ${what} did not verify: ${e?.message || e}` });

  function mount(app) {
    app.get('/api/passkey', (req, res) => {
      const user = currentUser(req);
      const n = user ? credsOf(user.id).length : 0;
      res.json({ rpID, signedIn: !!user, registered: n > 0, count: n, stepUp: hasStepUp(req, user), available: !broken });
    });

    app.post('/api/passkey/register/options', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const creds = credsOf(user.id);
      if (creds.length >= MAX_PASSKEYS) return res.status(409).json({ error: `This X account already has ${MAX_PASSKEYS} passkeys.` });
      if (creds.length && !hasStepUp(req, user)) return res.status(403).json({ error: 'Confirm with one of your existing passkeys before adding another.', needsPasskey: true });
      const options = await generateRegistrationOptions({
        rpName: 'xgas.dev',
        rpID,
        userName: `@${user.handle}`,
        userDisplayName: user.name || `@${user.handle}`,
        userID: userHandle(user.id),
        attestationType: 'none',
        excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257],
      });
      setChallenge(user.id, 'reg', options.challenge);
      res.json(options);
    });

    app.post('/api/passkey/register/verify', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const expectedChallenge = takeChallenge(user.id, 'reg');
      if (!expectedChallenge) return res.status(400).json({ error: 'That passkey prompt expired. Start again.' });
      let v;
      try {
        v = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true });
      } catch (e) { return fail(res, e, 'registration'); }
      if (!v.verified || !v.registrationInfo) return fail(res, 'not verified', 'registration');
      const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
      const creds = credsOf(user.id);
      // Re-check under the same rules as the options call: the store may have changed in between.
      if (creds.length >= MAX_PASSKEYS) return res.status(409).json({ error: `This X account already has ${MAX_PASSKEYS} passkeys.` });
      if (creds.length && !hasStepUp(req, user)) return res.status(403).json({ error: 'Confirm with one of your existing passkeys before adding another.', needsPasskey: true });
      if (creds.some((c) => c.id === credential.id)) return res.status(409).json({ error: 'That passkey is already on this X account.' });
      putCreds(user.id, [...creds, {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: Date.now(),
      }]);
      grant(req, res, user);
      console.log(`[passkey] @${user.handle} added a passkey (${creds.length + 1} total)`);
      res.json({ ok: true, count: creds.length + 1, stepUp: true });
    });

    app.post('/api/passkey/auth/options', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const creds = credsOf(user.id);
      if (!creds.length) return res.status(409).json({ error: 'This X account has no passkey yet.', needsRegistration: true });
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
      });
      setChallenge(user.id, 'auth', options.challenge);
      res.json(options);
    });

    app.post('/api/passkey/auth/verify', async (req, res) => {
      const user = gate(req, res); if (!user) return;
      const expectedChallenge = takeChallenge(user.id, 'auth');
      if (!expectedChallenge) return res.status(400).json({ error: 'That passkey prompt expired. Start again.' });
      const creds = credsOf(user.id);
      const cred = creds.find((c) => c.id === req.body?.response?.id);
      if (!cred) return res.status(400).json({ error: 'That passkey is not on this X account.' });
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response: req.body.response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')), counter: cred.counter, transports: cred.transports },
        });
      } catch (e) { return fail(res, e, 'check'); }
      if (!v.verified) return fail(res, 'not verified', 'check');
      putCreds(user.id, creds.map((c) => c.id === cred.id ? { ...c, counter: v.authenticationInfo.newCounter, lastUsedAt: Date.now() } : c));
      grant(req, res, user);
      res.json({ ok: true, stepUp: true });
    });
  }

  return { mount, hasStepUp, rpID };
}
