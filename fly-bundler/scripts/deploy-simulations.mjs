#!/usr/bin/env node
// Deploys Alto's two helper contracts (PimlicoSimulations and EntryPointSimulations07) with a plain CREATE.
//
// Why: Alto normally deploys them itself at startup through the CREATE2 deployer 0x4e59b448...956C, and chain
// 466302 has no code there (checked 2026-09-26). So we deploy them once, then run Alto with
// --deploy-simulations-contract=false and the two addresses this prints.
//
// The bytecode comes from the installed @pimlico/alto package, so the helpers always match the Alto version
// the image runs. Re-run after bumping @pimlico/alto.
//
//   RPC_URL=https://xgas.dev/rpc DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-simulations.mjs
//
// Refuses to run unless the RPC's chain id is EXPECTED_CHAIN_ID (default 466302). Prints JSON with both addresses.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const require = createRequire(import.meta.url)
// @pimlico/alto does not export ./package.json, so locate it next to this script (ALTO_DIR overrides)
const altoDir = (process.env.ALTO_DIR || fileURLToPath(new URL('../node_modules/@pimlico/alto/', import.meta.url))).replace(/\/?$/, '/')
const pimlicoSimulations = require(`${altoDir}esm/contracts/PimlicoSimulations.sol/PimlicoSimulations.json`)
const epSimulations07 = require(`${altoDir}esm/contracts/EntryPointSimulations.sol/EntryPointSimulations07.json`)
const altoVersion = require(`${altoDir}package.json`).version

const RPC_URL = process.env.RPC_URL || 'https://xgas.dev/rpc'
const EXPECTED = Number(process.env.EXPECTED_CHAIN_ID || 466302)
const KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.UTILITY_PRIVATE_KEY
if (!KEY) { console.error('set DEPLOYER_PRIVATE_KEY (any funded key; the utility key is fine)'); process.exit(1) }

const account = privateKeyToAccount(KEY)
const publicClient = createPublicClient({ transport: http(RPC_URL) })
const chainId = await publicClient.getChainId()
if (chainId !== EXPECTED) { console.error(`RPC ${RPC_URL} is chain ${chainId}, expected ${EXPECTED}; refusing`); process.exit(1) }
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } }
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })

console.error(`deployer ${account.address} balance ${formatEther(await publicClient.getBalance({ address: account.address }))} on chain ${chainId}, alto ${altoVersion}`)

async function deploy(name, artifact) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deploy failed: ${hash}`)
  console.error(`${name} ${receipt.contractAddress} (tx ${hash}, gas ${receipt.gasUsed})`)
  return receipt.contractAddress
}

const out = {
  chainId,
  altoVersion,
  pimlicoSimulationContract: await deploy('PimlicoSimulations', pimlicoSimulations),
  entrypointSimulationContractV7: await deploy('EntryPointSimulations07', epSimulations07),
}
console.log(JSON.stringify(out, null, 2))
