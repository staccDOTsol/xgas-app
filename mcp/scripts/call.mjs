// Call one tool directly, without the MCP layer:
//   node scripts/call.mjs ../src/tools/otc.mjs list_orders '{"side":"ask"}'
const [mod, name, args] = [process.argv[2], process.argv[3], process.argv[4] ? JSON.parse(process.argv[4]) : {}];
const m = await import(mod.startsWith('.') ? new URL(mod, import.meta.url).href : mod);
const t = m.tools.find((x) => x.name === name);
if (!t) { console.error('no tool', name); process.exit(1); }
try { const r = await t.handler(args); console.log(r.content[0].text); }
catch (e) { console.error('TOOL ERROR:', e.shortMessage || e.message); process.exit(1); }
