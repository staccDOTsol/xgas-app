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
for (const [k, v] of Object.entries(d.l4 || {})) {
  if (typeof v === 'string' && !isAddr(v)) warns.push(`l4.${k} is empty: tools that need it will refuse`);
  if (v === null) warns.push(`l4.${k} is null: tools that need it will refuse`);
}
if (!isAddr(d.l4?.arbSys)) errs.push('l4.arbSys missing (exits need it)');

for (const w of warns) console.warn(`warn: ${w}`);
if (errs.length) {
  console.error(`${file} is not publishable:\n  ${errs.join('\n  ')}`);
  process.exit(1);
}
console.log(`${file}: chain ${d.chainId}, rollup ${d.l3.rollup}, fast-confirm Safe ${d.fastConfirmSafe || d.l3.fastConfirmSafe}, ${d.validators.length} validators. OK.`);
