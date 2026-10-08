#!/usr/bin/env node
// Shared infra for the staccpad fleet on the xGas L4 (466302), deployed from three compiled projects:
//   WrappedXMoney, Multicall3, ERC6551Registry, XgasFleetTreasury   nft-range/out
//   Permit2                                                        nft-range/lib/permit2/out
//   PositionManager (v4-periphery)                                 nft-range/lib/v4-periphery/foundry-out
//   PoolManager (xGas JitToll fork)                                contracts/out
// Rerunnable: steps already in contracts/relaunch/fleet-466302-deployed.json are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NFT_RANGE = '/Users/stacc/nft-range';
const rpc = process.env.XGAS_RPC || 'https://xgas.dev/rpc';
const chain = defineChain({ id: 466302, name: 'xGas Orbit L4', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const owner = '0x26E8134eCC3af5cCE32f34B03E7BD2f318B25158';
const SINK = '0x4ca8826FBb7F69F55B858485313eAC56a1b4F458'; // Fireball L4 FanoutSink
const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const outFile = path.join(root, 'contracts/relaunch/fleet-466302-deployed.json');

if (process.env.FIREBALL_SIGNER_PROFILE !== 'owner') throw new Error('L4 deployer profile must be owner');
const signerFile = '/Users/stacc/staccoverflow.eth';
if ((fs.statSync(signerFile).mode & 0o077) !== 0) throw new Error('Signer file must be owner-only');
const raw = fs.readFileSync(signerFile, 'utf8').trim();
if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(raw)) throw new Error('Signer file must contain one key');
const account = privateKeyToAccount(`0x${raw.replace(/^0x/, '')}`);
if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error('Wrong L4 signer');

const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 30_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 30_000 }) });
if ((await pub.getChainId()) !== 466302) throw new Error('Wrong chain');
const proxyCode = await pub.getCode({ address: CREATE2_PROXY });
if (!proxyCode || proxyCode === '0x') throw new Error('CREATE2 proxy missing; run scripts/force-include-l4-create2.mjs');

const art = (p, name) => {
  const a = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object, name };
};
const A = {
  wxm: art(`${NFT_RANGE}/out/WrappedXMoney.sol/WrappedXMoney.json`, 'WrappedXMoney'),
  multicall3: art(`${NFT_RANGE}/out/Multicall3.sol/Multicall3.json`, 'Multicall3'),
  erc6551: art(`${NFT_RANGE}/out/ERC6551Registry.sol/ERC6551Registry.json`, 'ERC6551Registry'),
  treasury: art(`${NFT_RANGE}/out/XgasFleetTreasury.sol/XgasFleetTreasury.json`, 'XgasFleetTreasury'),
  permit2: art(`${NFT_RANGE}/lib/permit2/out/Permit2.sol/Permit2.json`, 'Permit2'),
  posm: art(`${NFT_RANGE}/lib/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json`, 'PositionManager'),
  poolManager: art(`${root}/contracts/out/PoolManager.sol/PoolManager.json`, 'PoolManager'),
};

const state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { chainId: 466302, parentChainId: 4663, sink: SINK, infra: {} };
const save = () => fs.writeFileSync(outFile, JSON.stringify(state, null, 2) + '\n');

async function deploy(key, a, args) {
  const have = state.infra[key]?.address;
  if (have) {
    const c = await pub.getCode({ address: have });
    if (c && c !== '0x') { console.log(`${a.name} already at ${have}`); return have; }
  }
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  console.log(`${a.name} deploying`, hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`${a.name} deploy failed`);
  state.infra[key] = { address: r.contractAddress, tx: hash, block: Number(r.blockNumber), args: args.map(String) };
  save();
  console.log(`${a.name} at ${r.contractAddress} (block ${r.blockNumber})`);
  return r.contractAddress;
}

const wxm = await deploy('wrappedXMoney', A.wxm, []);
await deploy('multicall3', A.multicall3, []);
await deploy('erc6551Registry', A.erc6551, []);
const permit2 = await deploy('permit2', A.permit2, []);
const pm = await deploy('poolManager', A.poolManager, [owner]);
const posm = await deploy('positionManager', A.posm, [pm, permit2, 300_000n, '0x0000000000000000000000000000000000000000', wxm]);
const treasury = await deploy('fleetTreasury', A.treasury, [wxm, SINK, owner]);

// The toll collector: only this address can collectProtocolFees. The owner EOA for now; a keeper can
// sweep accrued tolls to the sink later.
const pmAbi = parseAbi(['function protocolFeeController() view returns (address)', 'function setProtocolFeeController(address)']);
const ctrl = await pub.readContract({ address: pm, abi: pmAbi, functionName: 'protocolFeeController' });
if (ctrl.toLowerCase() !== owner.toLowerCase()) {
  const h = await wallet.writeContract({ address: pm, abi: pmAbi, functionName: 'setProtocolFeeController', args: [owner] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('protocolFeeController set to owner', h);
}
state.infra.protocolFeeController = owner;
save();
console.log('\nfleet infra recorded in', path.relative(root, outFile));
console.log({ wxm, permit2, pm, posm, treasury });
