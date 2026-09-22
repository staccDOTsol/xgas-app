// Copies the minimal {abi, bytecode} for the Orbit L3 contracts out of forge's `out/`
// into contracts/l3-artifacts so the runtime server (which has no solc/forge libs) can deploy them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'contracts');
const names = ['FanoutSink', 'XMoneyEscrow', 'FomoAttritionL3', 'XGasRouter'];

for (const name of names) {
  const src = path.join(root, 'out', `${name}.sol`, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(src, 'utf8'));
  const out = { contractName: name, abi: json.abi, bytecode: json.bytecode.object };
  const dest = path.join(root, 'l3-artifacts', `${name}.json`);
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`exported ${name} -> ${path.relative(process.cwd(), dest)} (${out.bytecode.length / 2} bytes)`);
}
