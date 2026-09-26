#!/usr/bin/env node
// End-to-end check of the bundler config against an anvil fork of chain 466302. Driven by test/fork-e2e.sh.
//
//   node test/fork-e2e.mjs deploy   deploys EntryPoint v0.7, SimpleAccountFactory v0.7, a VerifyingPaymaster
//                                   (v0.7 sample, standing in for XgasDevPaymaster), Alto's simulation helpers,
//                                   and a NodeInterface stand-in at 0x...C8; funds fresh bundler keys;
//                                   writes $STATE (JSON) including the keys (fork-only throwaway keys)
//   node test/fork-e2e.mjs send     builds a SimpleAccount (counterfactual, deployed by the first op), gets a
//                                   paymaster signature, and sends two sponsored UserOps through Alto
//
// Env: FORK_RPC (default http://127.0.0.1:18545), BUNDLER_URL (default http://127.0.0.1:14337),
//      AA_OUT (forge out dir holding EntryPoint/SimpleAccountFactory/VerifyingPaymaster/NodeInterfaceMock),
//      STATE (default ./fork-state.json), PAYMASTER=verifying (default) | xgasdev (contracts/src/aa/XgasDevPaymaster,
//      artifact from XGASDEV_OUT). Refuses to run unless FORK_RPC is chain 466302 AND answers anvil_*.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, encodeFunctionData, encodeAbiParameters,
  concat, numberToHex, hexToBigInt, parseAbi, parseEventLogs,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  createBundlerClient, toSmartAccount, entryPoint07Abi, getUserOperationHash, toPackedUserOperation,
} from 'viem/account-abstraction'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORK_RPC = process.env.FORK_RPC || 'http://127.0.0.1:18545'
const BUNDLER_URL = process.env.BUNDLER_URL || 'http://127.0.0.1:14337'
const AA_OUT = process.env.AA_OUT
const STATE = process.env.STATE || path.join(process.cwd(), 'fork-state.json')
const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8'
// anvil's well-known dev account #0; only exists with a balance on the local fork
const ANVIL0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const chain = {
  id: 466302, name: 'xGas L4 (anvil fork)', nativeCurrency: { name: 'xMoney', symbol: 'xMoney', decimals: 18 },
  rpcUrls: { default: { http: [FORK_RPC] } },
}
const publicClient = createPublicClient({ chain, transport: http(FORK_RPC) })
const log = (...a) => console.log('[fork-e2e]', ...a)

async function guard() {
  const id = await publicClient.getChainId()
  if (id !== 466302) throw new Error(`FORK_RPC is chain ${id}, expected 466302`)
  // anvil_nodeInfo only answers on anvil: never run the deploy phase against the real chain
  await publicClient.request({ method: 'anvil_nodeInfo', params: [] })
}

const PAYMASTER_KIND = process.env.PAYMASTER || 'verifying'
const artifact = (name) => {
  const dir = name === 'XgasDevPaymaster' ? process.env.XGASDEV_OUT : AA_OUT
  if (!dir) throw new Error(`set ${name === 'XgasDevPaymaster' ? 'XGASDEV_OUT' : 'AA_OUT'} to the forge out dir`)
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.sol`, `${name}.json`), 'utf8'))
}
const paymasterArtifactName = () => (PAYMASTER_KIND === 'xgasdev' ? 'XgasDevPaymaster' : 'VerifyingPaymaster')

async function deploy() {
  await guard()
  const deployer = privateKeyToAccount(ANVIL0)
  const wallet = createWalletClient({ account: deployer, chain, transport: http(FORK_RPC) })
  const mine = async (hash) => {
    const r = await publicClient.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`tx reverted ${hash}`)
    return r
  }
  const create = async (name, args = []) => {
    const a = artifact(name)
    const r = await mine(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))
    log(`${name} deployed at ${r.contractAddress} (gas ${r.gasUsed})`)
    return r.contractAddress
  }

  // Nitro's NodeInterface is virtual (no code), so the fork has nothing at 0xC8. Alto's arbitrum mode needs it.
  await publicClient.request({ method: 'anvil_setCode', params: [NODE_INTERFACE, artifact('NodeInterfaceMock').deployedBytecode.object] })
  log('NodeInterface stand-in installed at 0x...C8')

  const entryPoint = await create('EntryPoint')
  const factory = await create('SimpleAccountFactory', [entryPoint])
  const paymasterSignerKey = generatePrivateKey()
  const paymasterSigner = privateKeyToAccount(paymasterSignerKey).address
  const paymaster = PAYMASTER_KIND === 'xgasdev'
    ? await create('XgasDevPaymaster', [entryPoint, deployer.address, paymasterSigner])
    : await create('VerifyingPaymaster', [entryPoint, paymasterSigner])

  const pmAbi = artifact(paymasterArtifactName()).abi
  await mine(await wallet.writeContract({ address: paymaster, abi: pmAbi, functionName: 'deposit', value: parseEther('1') }))
  await mine(await wallet.writeContract({ address: paymaster, abi: pmAbi, functionName: 'addStake', args: [86400], value: parseEther('0.1') }))
  log('paymaster: 1 xMoney deposited in the EntryPoint, 0.1 staked (1 day unstake delay)')

  // Alto's helpers, deployed exactly the way production will do it (plain CREATE, no CREATE2 deployer)
  const simOut = execFileSync('node', [path.join(HERE, '..', 'scripts', 'deploy-simulations.mjs')], {
    env: { ...process.env, RPC_URL: FORK_RPC, DEPLOYER_PRIVATE_KEY: ANVIL0 }, stdio: ['ignore', 'pipe', 'inherit'],
  }).toString()
  const sims = JSON.parse(simOut)

  // Fresh bundler keys with production-sized balances: executor below the refill threshold is topped up by utility
  const executorKey = generatePrivateKey()
  const utilityKey = generatePrivateKey()
  const executor = privateKeyToAccount(executorKey).address
  const utility = privateKeyToAccount(utilityKey).address
  await publicClient.request({ method: 'anvil_setBalance', params: [executor, numberToHex(parseEther('0.05'))] })
  await publicClient.request({ method: 'anvil_setBalance', params: [utility, numberToHex(parseEther('0.5'))] })
  log(`executor ${executor} (0.05 xMoney), utility ${utility} (0.5 xMoney)`)

  const state = {
    chainId: 466302, entryPoint, factory, paymaster, paymasterKind: PAYMASTER_KIND, paymasterSignerKey, paymasterSigner,
    executorKey, utilityKey, executor, utility, ...sims,
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
  log(`state written to ${STATE}`)
}

// SimpleAccount v0.7 (eth-infinitism samples) on viem's toSmartAccount. permissionless' toSimpleSmartAccount is the
// same account; this avoids its ox peer-dependency clash with viem 2.56.
const simpleAccountAbi = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
])
const factoryAbi = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
])
async function toSimpleAccountV07({ client, owner, factory, entryPoint, salt = 0n }) {
  const sender = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'getAddress', args: [owner.address, salt] })
  return toSmartAccount({
    client,
    entryPoint: { abi: entryPoint07Abi, address: entryPoint, version: '0.7' },
    async getAddress() { return sender },
    // nonce key 0, so the op sequence is the account's plain 0, 1, 2...
    async getNonce() {
      return client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [sender, 0n] })
    },
    async getFactoryArgs() {
      return { factory, factoryData: encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owner.address, salt] }) }
    },
    async encodeCalls(calls) {
      if (calls.length === 1) {
        const c = calls[0]
        return encodeFunctionData({ abi: simpleAccountAbi, functionName: 'execute', args: [c.to, c.value ?? 0n, c.data ?? '0x'] })
      }
      return encodeFunctionData({
        abi: simpleAccountAbi, functionName: 'executeBatch',
        args: [calls.map((c) => c.to), calls.map((c) => c.value ?? 0n), calls.map((c) => c.data ?? '0x')],
      })
    },
    async getStubSignature() {
      return '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
    },
    async signMessage({ message }) { return owner.signMessage({ message }) },
    async signTypedData(td) { return owner.signTypedData(td) },
    async signUserOperation(userOperation) {
      const hash = getUserOperationHash({
        chainId: chain.id, entryPointAddress: entryPoint, entryPointVersion: '0.7',
        userOperation: { ...userOperation, sender },
      })
      return owner.signMessage({ message: { raw: hash } })
    },
  })
}

// Paymaster client for the v0.7 VerifyingPaymaster sample: paymasterData = abi.encode(validUntil, validAfter) ++ sig,
// where sig = personal_sign(getHash(packedOp, validUntil, validAfter)) by the paymaster signer.
const PM_VERIFICATION_GAS = 120_000n
const PM_POSTOP_GAS = 1n
function verifyingPaymaster({ paymaster, signerKey, pmAbi }) {
  const signer = privateKeyToAccount(signerKey)
  const sign = async (userOperation, validFor) => {
    const now = Math.floor(Date.now() / 1000)
    const validUntil = now + validFor
    const validAfter = 0
    const op = {
      callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
      ...Object.fromEntries(Object.entries(userOperation).filter(([, v]) => v !== undefined)),
      paymaster, paymasterVerificationGasLimit: PM_VERIFICATION_GAS, paymasterPostOpGasLimit: PM_POSTOP_GAS,
      paymasterData: '0x', signature: userOperation.signature ?? '0x',
    }
    const packed = toPackedUserOperation(op)
    const hash = await publicClient.readContract({ address: paymaster, abi: pmAbi, functionName: 'getHash', args: [packed, validUntil, validAfter] })
    const sig = await signer.signMessage({ message: { raw: hash } })
    return {
      paymaster,
      paymasterData: concat([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, validAfter]), sig]),
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      paymasterPostOpGasLimit: PM_POSTOP_GAS,
    }
  }
  return {
    // stub: a real signature over the not-yet-final op, so ECDSA.recover never reverts during estimation
    async getPaymasterStubData(op) { return { ...(await sign(op, 600)), isFinal: false } },
    async getPaymasterData(op) { return sign(op, 300) },
  }
}

// Paymaster client for contracts/src/aa/XgasDevPaymaster: paymasterData = validUntil(6) | validAfter(6) |
// maxXgasDevCharge(32) | robinhoodPayer(20) | sig(65), sig = personal_sign(getHash(packedOp, ...those four)).
const XGASDEV_POSTOP_GAS = 60_000n
function xgasDevPaymaster({ paymaster, signerKey, pmAbi, robinhoodPayer, maxXgasDevCharge }) {
  const signer = privateKeyToAccount(signerKey)
  const sign = async (userOperation, validFor) => {
    const validUntil = Math.floor(Date.now() / 1000) + validFor
    const validAfter = 0
    const op = {
      callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
      ...Object.fromEntries(Object.entries(userOperation).filter(([, v]) => v !== undefined)),
      paymaster, paymasterVerificationGasLimit: PM_VERIFICATION_GAS, paymasterPostOpGasLimit: XGASDEV_POSTOP_GAS,
      paymasterData: '0x', signature: userOperation.signature ?? '0x',
    }
    const hash = await publicClient.readContract({
      address: paymaster, abi: pmAbi, functionName: 'getHash',
      args: [toPackedUserOperation(op), validUntil, validAfter, maxXgasDevCharge, robinhoodPayer],
    })
    const sig = await signer.signMessage({ message: { raw: hash } })
    return {
      paymaster,
      paymasterData: concat([numberToHex(validUntil, { size: 6 }), numberToHex(validAfter, { size: 6 }), numberToHex(maxXgasDevCharge, { size: 32 }), robinhoodPayer, sig]),
      paymasterVerificationGasLimit: PM_VERIFICATION_GAS,
      paymasterPostOpGasLimit: XGASDEV_POSTOP_GAS,
    }
  }
  return {
    async getPaymasterStubData(op) { return { ...(await sign(op, 600)), isFinal: false } },
    async getPaymasterData(op) { return sign(op, 300) },
  }
}

async function send() {
  await guard()
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const kind = s.paymasterKind || 'verifying'
  const pmAbi = artifact(kind === 'xgasdev' ? 'XgasDevPaymaster' : 'VerifyingPaymaster').abi
  const owner = privateKeyToAccount(generatePrivateKey())
  const account = await toSimpleAccountV07({ client: publicClient, owner, factory: s.factory, entryPoint: s.entryPoint })
  log(`owner EOA ${owner.address}, SimpleAccount ${account.address} (code before: ${(await publicClient.getCode({ address: account.address })) ?? '0x'})`)

  const bundler = createBundlerClient({
    client: publicClient, account, transport: http(BUNDLER_URL),
    // xgasdev: the owner EOA doubles as the Robinhood payer, as in the site's flow; 5 XGAS.DEV max charge
    paymaster: kind === 'xgasdev'
      ? xgasDevPaymaster({ paymaster: s.paymaster, signerKey: s.paymasterSignerKey, pmAbi, robinhoodPayer: owner.address, maxXgasDevCharge: parseEther('5') })
      : verifyingPaymaster({ paymaster: s.paymaster, signerKey: s.paymasterSignerKey, pmAbi }),
    userOperation: {
      // Alto's price for inclusion: on arbitrum mode it is baseFee * arbitrum-base-fee-multiplier
      async estimateFeesPerGas({ bundlerClient }) {
        const p = await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice', params: [] })
        return { maxFeePerGas: hexToBigInt(p.fast.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(p.fast.maxPriorityFeePerGas) }
      },
    },
  })

  const eps = await bundler.request({ method: 'eth_supportedEntryPoints', params: [] })
  log(`bundler ${BUNDLER_URL} chainId ${await bundler.request({ method: 'eth_chainId', params: [] })}, entryPoints ${eps.join(',')}`)

  const depositBefore = await publicClient.readContract({ address: s.entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [s.paymaster] })
  const target = '0x000000000000000000000000000000000000dEaD'
  const results = []
  for (const [i, calls] of [
    [{ to: target, value: 0n, data: '0x' }],
    [{ to: target, value: 0n, data: '0x1234' }, { to: owner.address, value: 0n, data: '0x' }],
  ].entries()) {
    const userOp = await bundler.prepareUserOperation({ calls })
    log(`op ${i}: nonce ${userOp.nonce} factory ${userOp.factory ?? '-'} callGas ${userOp.callGasLimit} verifGas ${userOp.verificationGasLimit} preVerifGas ${userOp.preVerificationGas} pmVerifGas ${userOp.paymasterVerificationGasLimit} maxFee ${userOp.maxFeePerGas}`)
    // prepareUserOperation leaves the stub signature in place; the owner signs the final op here
    const signature = await account.signUserOperation(userOp)
    const hash = await bundler.sendUserOperation({ ...userOp, signature })
    log(`op ${i}: sent, userOpHash ${hash}`)
    const r = await bundler.waitForUserOperationReceipt({ hash, timeout: 60_000 })
    log(`op ${i}: success=${r.success} bundle tx ${r.receipt.transactionHash} block ${r.receipt.blockNumber} actualGasCost ${formatEther(r.actualGasCost)} xMoney actualGasUsed ${r.actualGasUsed} paymaster ${r.paymaster}`)
    if (!r.success) throw new Error(`op ${i} reverted`)
    let charged
    if (kind === 'xgasdev') {
      const ev = parseEventLogs({ abi: pmAbi, logs: r.receipt.logs, eventName: 'XgasDevGasCharged' })[0]
      if (!ev) throw new Error(`op ${i}: no XgasDevGasCharged event`)
      if (ev.args.userOpHash !== hash || ev.args.robinhoodPayer !== owner.address) throw new Error(`op ${i}: event fields mismatch`)
      charged = { actualGasCost: ev.args.actualGasCost.toString(), actualUserOpFeePerGas: ev.args.actualUserOpFeePerGas.toString(), maxXgasDevCharge: ev.args.maxXgasDevCharge.toString(), robinhoodPayer: ev.args.robinhoodPayer, succeeded: ev.args.succeeded }
      log(`op ${i}: XgasDevGasCharged userOpHash ok, payer ${ev.args.robinhoodPayer}, actualGasCost ${formatEther(ev.args.actualGasCost)} xMoney, feePerGas ${ev.args.actualUserOpFeePerGas}, maxXgasDevCharge ${formatEther(ev.args.maxXgasDevCharge)}, succeeded ${ev.args.succeeded}`)
    }
    results.push({ charged, userOpHash: hash, txHash: r.receipt.transactionHash, block: Number(r.receipt.blockNumber), actualGasCost: r.actualGasCost.toString(), actualGasUsed: r.actualGasUsed.toString(), paymaster: r.paymaster, sender: r.sender })
  }
  const code = await publicClient.getCode({ address: account.address })
  const depositAfter = await publicClient.readContract({ address: s.entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [s.paymaster] })
  const nonce = await publicClient.readContract({ address: s.entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [account.address, 0n] })
  log(`SimpleAccount deployed: ${code && code !== '0x'} (${(code?.length ?? 2) / 2 - 1} bytes), EntryPoint nonce now ${nonce}`)
  log(`paymaster deposit ${formatEther(depositBefore)} -> ${formatEther(depositAfter)} xMoney (paid ${formatEther(depositBefore - depositAfter)})`)
  log(`executor ${s.executor} balance ${formatEther(await publicClient.getBalance({ address: s.executor }))}, utility ${formatEther(await publicClient.getBalance({ address: s.utility }))}`)
  console.log(JSON.stringify({ ok: true, paymasterKind: kind, account: account.address, owner: owner.address, results }, null, 2))
}

const cmd = process.argv[2]
if (cmd === 'deploy') await deploy()
else if (cmd === 'send') await send()
else { console.error('usage: fork-e2e.mjs deploy|send'); process.exit(1) }
