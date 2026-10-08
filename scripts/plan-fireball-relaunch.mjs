#!/usr/bin/env node
/** Read-only by default. This cannot migrate existing immutable L4 fee producers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, parseAbi, zeroAddress } from 'viem';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'mcp/deployment.json');
const OLD = ['0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e', '0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8'];
const FANOUT = parseAbi([
  'function fireball() view returns (address)',
  'function weth() view returns (address)',
  'function registeredCount() view returns (uint64)',
  'function isAssetActive(address token) view returns (bool)',
]);
const CORE = parseAbi(['function fanout() view returns (address)']);
const SINK = parseAbi(['function fanout() view returns (address)']);
const FORWARDER = parseAbi([
  'function fanout() view returns (address)',
  'function xMoney() view returns (address)',
]);

export function relaunchTarget(env = process.env) {
  if (!env.FIREBALL_FANOUT_PARENT) throw new Error('Set FIREBALL_FANOUT_PARENT to the deployed Robinhood fanout.');
  const parent = getAddress(env.FIREBALL_FANOUT_PARENT);
  if (parent === zeroAddress || OLD.some(x => x.toLowerCase() === parent.toLowerCase())) {
    throw new Error('FIREBALL_FANOUT_PARENT must be the new fanout, not an old fixed-denominator fanout.');
  }
  const output = path.resolve(env.FIREBALL_PLAN_OUT || path.join(ROOT, 'contracts/relaunch/fireball-466302-plan.json'));
  if (output === MANIFEST || output === path.join(ROOT, 'src/contracts/l4-deployment.json')) {
    throw new Error('Relaunch plan path must not replace a live deployment manifest.');
  }
  return { parent, output };
}

async function verifyLive(plan, manifest, env) {
  const rh = createPublicClient({ transport: http(env.FIREBALL_PARENT_RPC || manifest.parentRpcUrl) });
  const l4 = createPublicClient({ transport: http(env.FIREBALL_L4_RPC || manifest.sequencerRpcUrl) });
  const [rhChain, l4Chain, code] = await Promise.all([
    rh.getChainId(), l4.getChainId(), rh.getCode({ address: plan.newParent }),
  ]);
  if (rhChain !== 4663 || l4Chain !== 466302 || !code || code === '0x') {
    throw new Error('Wrong chain or new fanout code absent.');
  }
  const [fireball, weth, registeredCount, xMoneyAssetActive, oldSinkParent] = await Promise.all([
    rh.readContract({ address: plan.newParent, abi: FANOUT, functionName: 'fireball' }),
    rh.readContract({ address: plan.newParent, abi: FANOUT, functionName: 'weth' }),
    rh.readContract({ address: plan.newParent, abi: FANOUT, functionName: 'registeredCount' }),
    rh.readContract({ address: plan.newParent, abi: FANOUT, functionName: 'isAssetActive', args: [manifest.l3.xMoney] }),
    l4.readContract({ address: plan.oldL4Sink, abi: SINK, functionName: 'fanout' }),
  ]);
  const bound = await rh.readContract({ address: fireball, abi: CORE, functionName: 'fanout' });
  if (bound.toLowerCase() !== plan.newParent.toLowerCase()
    || weth.toLowerCase() !== manifest.l3.weth.toLowerCase()) {
    throw new Error('New fanout is not bound to its Fireball core or has wrong WETH.');
  }
  // The live 466302 sink points to the historical 8010-share fanout, while the
  // xMoney vault's own USDG rake points to the older 10000-share fanout.
  // Both are legacy routes and must remain available for historical claims.
  if (!OLD.some(x => x.toLowerCase() === oldSinkParent.toLowerCase())) {
    throw new Error('Current L4 sink parent is neither known historical fanout; reconcile first.');
  }
  let forwarder = null;
  if (env.FIREBALL_BRIDGE_FORWARDER) {
    const address = getAddress(env.FIREBALL_BRIDGE_FORWARDER);
    const [forwarderCode, forwarderFanout, forwarderToken] = await Promise.all([
      rh.getCode({ address }),
      rh.readContract({ address, abi: FORWARDER, functionName: 'fanout' }),
      rh.readContract({ address, abi: FORWARDER, functionName: 'xMoney' }),
    ]);
    if (!forwarderCode || forwarderCode === '0x'
      || forwarderFanout.toLowerCase() !== plan.newParent.toLowerCase()
      || forwarderToken.toLowerCase() !== manifest.l3.xMoney.toLowerCase()) {
      throw new Error('Fireball bridge forwarder code or wiring is wrong.');
    }
    forwarder = address;
  }
  return {
    checkedAt: new Date().toISOString(), rhChain, l4Chain, fireball, weth, oldSinkParent,
    registeredCount: registeredCount.toString(), xMoneyAssetActive, forwarder,
    readyForL4Sink: registeredCount > 0n && xMoneyAssetActive && !!forwarder,
  };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || (args[0] && !['--plan', '--verify', '--verify-and-write'].includes(args[0]))) {
    throw new Error('Use --plan (default), --verify, or --verify-and-write.');
  }
  const mode = args[0] || '--plan';
  const cfg = relaunchTarget(env);
  const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  if (manifest.chainId !== 466302 || !manifest.l4?.fanoutSink || !manifest.l3?.outbox) {
    throw new Error('Current L4 deployment manifest identity is missing or unexpected.');
  }
  const plan = {
    status: 'staged-only', chainId: 466302, parentChainId: 4663,
    newParent: cfg.parent, oldL4Sink: manifest.l4.fanoutSink,
    oldParentManifest: manifest.l3.fanout, parentOutbox: manifest.l3.outbox,
    currentProducers: Object.fromEntries(['escrow', 'fomo', 'router', 'nguLauncher']
      .map(k => [k, manifest.l4[k]]).filter(([, v]) => Boolean(v))),
    parentForwarderScript: 'contracts/script/DeployFireballBridgeForwarder.s.sol:DeployFireballBridgeForwarder',
    sinkDeployScript: 'contracts/script/DeployOrbitL4Fireball.s.sol:DeployOrbitL4Fireball (FIREBALL_L4_STEP=sink)',
    successorScript: 'contracts/script/DeployOrbitL4Fireball.s.sol:DeployOrbitL4Fireball (one step per tx)',
    proposedSink: null,
    routing: {
      legacyReadAndClaimAddresses: manifest.l4,
      newCreateAddresses: null,
      activation: 'off until parent xMoney is active, forwarder/sink verified, all new producers deployed and version-aware app routes published',
    },
    blockers: [
      'Existing L4 FanoutSink has immutable parent; its in-flight withdrawals still land at old parent.',
      'Existing escrow, FOMO, router, NGU launcher and launched tokens have immutable sink references.',
      'The live XMoney bridge vault hardcodes the old fanout for USDG entry/exit fees; full bridge/backing migration is separate.',
      'The new sink must target a parent FireballBridgeFeeForwarder; flush, Outbox execution, then permissionless forward() books only delivered xMoney.',
      'Old escrows and FOMO rounds must stay readable and claimable after new creation routes activate.',
    ],
  };
  if (mode !== '--plan') plan.liveVerification = await verifyLive(plan, manifest, env);
  if (mode === '--verify-and-write') {
    await fs.mkdir(path.dirname(cfg.output), { recursive: true });
    await fs.writeFile(cfg.output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ ...plan, ...(mode === '--verify-and-write' ? { planFile: cfg.output } : {}) }, null, 2));
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`xGas Fireball plan: ${error.shortMessage || error.message}`); process.exitCode = 1; });
}
