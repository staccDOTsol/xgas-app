// Run by prepublishOnly after the app's deployment file is copied in, so a release can't ship
// addresses for the wrong chain or without the keys the tools read. Exits non-zero on any miss.
//   node scripts/check-deployment.mjs [path]   (default: ./deployment.json)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, '..', 'deployment.json');
const EXPECT_CHAIN = Number(process.env.XGAS_EXPECT_CHAIN_ID || 466302);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));

const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a) && !/^0x0{40}$/.test(a);
const errs = [];
const warns = [];
const need = (ok, msg) => { if (!ok) errs.push(msg); };

need(d.chainId === EXPECT_CHAIN, `chainId is ${d.chainId}, expected ${EXPECT_CHAIN}`);
need(d.parentChainId === 4663, `parentChainId is ${d.parentChainId}, expected 4663`);
need(typeof d.parentRpcUrl === 'string' && d.parentRpcUrl, 'parentRpcUrl missing');
need(d.publicRpcUrl || d.rpcUrl || d.sequencerRpcUrl, 'no xGas RPC (publicRpcUrl, rpcUrl or sequencerRpcUrl)');
for (const k of ['xMoney', 'usdg', 'fanout', 'rollup', 'inbox', 'outbox', 'bridge', 'sequencerInbox']) {
  need(isAddr(d.l3?.[k]), `l3.${k} missing or not an address`);
}
need(isAddr(d.fastConfirmSafe || d.l3?.fastConfirmSafe), 'fastConfirmSafe missing');
need(Array.isArray(d.validators) && d.validators.length > 0 && d.validators.every(isAddr), 'validators[] missing or malformed');
if (d.validator && !d.validators) errs.push('still the 466301 shape (single `validator`)');
if (!d.legacy466301) warns.push('no legacy466301 block: old-chain exits will not be described');
// A release must not ship a half-filled deployment: every l4.* app address, the EarlyDepositor deposits go through
// until the vault switch, and no leftover _placeholders marker. ALLOW_PLACEHOLDERS=1 downgrades these to warnings
// (for a local check of a chain that is still being deployed, never for a publish).
const ALLOW_PLACEHOLDERS = process.env.ALLOW_PLACEHOLDERS === '1';
const placeholder = (msg) => (ALLOW_PLACEHOLDERS ? warns : errs).push(msg);
if (!d.l4 || typeof d.l4 !== 'object' || !Object.keys(d.l4).length) placeholder('l4 block missing or empty');
for (const [k, v] of Object.entries(d.l4 || {})) {
  if (v === null || v === undefined || v === '') placeholder(`l4.${k} is ${v === '' ? 'empty' : 'null'}`);
  else if (typeof v === 'string' && !isAddr(v)) placeholder(`l4.${k} is not a non-zero address: ${v}`);
}
if (!isAddr(d.l4?.arbSys)) errs.push('l4.arbSys missing (exits need it)');
if (!isAddr(d.l3?.earlyDepositor)) placeholder('l3.earlyDepositor missing or not an address (deposits go through it until the vault switch)');
const placeholderPaths = [];
(function walk(o, at) {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (k === '_placeholders') placeholderPaths.push(at ? `${at}.${k}` : k);
    walk(v, at ? `${at}.${k}` : k);
  }
})(d, '');
for (const p of placeholderPaths) placeholder(`${p} is present: the deployment still marks placeholder addresses`);

for (const w of warns) console.warn(`warn: ${w}`);
if (errs.length) {
  console.error(`${file} is not publishable:\n  ${errs.join('\n  ')}`);
  process.exit(1);
}
console.log(`${file}: chain ${d.chainId}, rollup ${d.l3.rollup}, fast-confirm Safe ${d.fastConfirmSafe || d.l3.fastConfirmSafe}, ${d.validators.length} validators, ${Object.keys(d.l4).length} l4 addresses, EarlyDepositor ${d.l3.earlyDepositor}${ALLOW_PLACEHOLDERS && warns.length ? ' (ALLOW_PLACEHOLDERS=1: placeholder checks were warnings only)' : ''}. OK.`);
