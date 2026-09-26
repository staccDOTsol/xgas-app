// Gas on the xGas L4 (chain 466302) paid in XGAS.DEV on Robinhood.
//
//   POST /api/paymaster/466302          ERC-7677 JSON-RPC: pm_getPaymasterStubData, pm_getPaymasterData
//                                       (+ pm_supportedEntryPoints, eth_chainId). Wallets with the paymasterService
//                                       capability and viem's createPaymasterClient point straight at it.
//   GET  /api/paymaster/466302/status   config, live rate, worker health; ?payer=0x... adds that payer's balance,
//                                       allowance, exposure and recent debits.
//   POST /api/bundler/466302            thin allowlisted proxy to the Alto bundler (BUNDLER_URL), so the browser
//                                       needs one origin only.
//
// Sponsorship policy (all of it must hold, per user operation):
//   - robinhoodPayer is the sender itself (EOA / EIP-7702 / same-address smart wallet), or the owner a
//     SimpleAccountFactory initCode creates the sender for, or an owner for which factory.getAddress(owner, salt)
//     == sender. The user operation is signed by that owner, and it signs over paymasterAndData, which carries
//     robinhoodPayer and maxXgasDevCharge: landing the op on chain is the payer's consent to the charge.
//   - quote: maxCost (EntryPoint requiredPrefund, xMoney wei) -> USD at the vault NAV -> XGAS.DEV at the
//     graduation pool price (the higher of spot and 10 minute EMA in XGAS.DEV per ETH; refused when they diverge
//     by more than 5%) and the median ETH/USD, times 1.10.
//   - caps: per op, per payer per UTC day, everyone per UTC day, per payer credit (outstanding quotes plus unpaid
//     debits), a few outstanding signatures per payer, and any failed (unpaid) debit blocks the payer.
//   - a payer with no settled charge yet (new) gets a small credit line and few signatures until one XGAS.DEV
//     charge of theirs has been burned on Robinhood; everyone together may have at most inFlightTotalWei of gas
//     signed or landed but not collected yet; once dailyLossWei of today's charges are unpaid, sponsorship stops
//     until 00:00 UTC. These bound what a payer who revokes the allowance after landing ops can take.
//   - maxPriorityFeePerGas at most maxPriorityFeeWei (the L4 sequencer keeps no priority fee, but the EntryPoint
//     charges it) and maxFeePerGas at most maxFeeMultiple x the L4 gas price.
//   - on Robinhood the payer holds and has approved to the debit wallet enough XGAS.DEV for everything owed.
//
// Concurrency: every network read (payer, rate, signature, balance, allowance, deposit) happens BEFORE the
// decision. The decision (exposure, every cap, the cumulative balance and allowance check) and the ledger write
// that reserves the quote run with no await in between, so two requests can never both see the state from before
// the other's reservation. Keep it that way: an await between checkPolicy() and ledger.upsertQuote() reopens the race.
import express from 'express';
import path from 'path';
import { getAddress, isAddress, parseAbi, parseEther, parseGwei, formatEther, formatGwei, numberToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ENTRYPOINT_V07, PaymasterInputError, parseUserOp, requiredPrefund, signSponsorship, stubPaymasterData,
  simpleAccountOwnerFromFactoryData,
} from './sign.mjs';
import { PriceTracker, decodeSlot0, floatToWad, maxChargeFor, navWadFromVault, priceWadFromSqrtX96, rateWad, v4PoolId, v4Slot0StorageSlot, wadToDec, WAD } from './quote.mjs';
import { Ledger } from './ledger.mjs';
import { BURN_ADDRESS, ERC20_ABI, createDebitWorker } from './debit.mjs';

export const XGAS_DEV_POOL = {
  currency0: '0x0000000000000000000000000000000000000000',   // native ETH
  currency1: '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3',   // XGAS.DEV
  fee: 0, tickSpacing: 200,
  hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
};
export const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const EXTSLOAD_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const VAULT_ABI = parseAbi(['function getReserveNAV() view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney)']);
const ENTRYPOINT_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const ACCOUNT_ABI = parseAbi(['function owner() view returns (address)']);
const FACTORY_VIEW_ABI = parseAbi(['function getAddress(address owner, uint256 salt) view returns (address)']);

export const DEFAULT_PM_VERIFICATION_GAS = 75_000n;
export const DEFAULT_PM_POSTOP_GAS = 40_000n;
export const MIN_PM_POSTOP_GAS = 30_000n;          // postOp must never run out of gas: its event is the only debit trigger
export const MAX_PM_VERIFICATION_GAS = 300_000n;
export const MAX_PM_POSTOP_GAS = 150_000n;
const BUNDLER_METHODS = new Set([
  'eth_chainId', 'eth_supportedEntryPoints', 'eth_estimateUserOperationGas', 'eth_sendUserOperation',
  'eth_getUserOperationByHash', 'eth_getUserOperationReceipt', 'pimlico_getUserOperationGasPrice', 'pimlico_getUserOperationStatus',
]);

export class PolicyError extends Error {
  constructor(message, data) { super(message); this.name = 'PolicyError'; this.data = data; }
}

function keyFromEnv(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const k = s.startsWith('0x') || s.startsWith('0X') ? `0x${s.slice(2)}` : `0x${s}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return { error: 'not a 32-byte hex key' };
  try { return { account: privateKeyToAccount(k) }; } catch { return { error: 'could not be loaded' }; }
}
function envAddr(v) { const s = String(v || '').trim(); return s && isAddress(s, { strict: false }) ? getAddress(s) : null; }
function envXmoney(env, name, dflt) {
  const s = String(env[name] ?? '').trim();
  if (!s) return parseEther(dflt);
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(s)) { console.warn(`[paymaster] ${name} must be a decimal amount of xMoney; using ${dflt}`); return parseEther(dflt); }
  return parseEther(s);
}
function envGwei(env, name, dflt) {
  const s = String(env[name] ?? '').trim();
  if (!s) return parseGwei(dflt);
  if (!/^\d{1,6}(\.\d{1,9})?$/.test(s)) { console.warn(`[paymaster] ${name} must be a decimal amount of gwei; using ${dflt}`); return parseGwei(dflt); }
  return parseGwei(s);
}
function envInt(env, name, dflt, min, max) {
  const n = Number(env[name] ?? dflt);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}

/** Resolve configuration from env + the committed deployment file. Pure, so it is unit tested. */
export function resolveConfig({ env = process.env, deploy = {} } = {}) {
  const missing = []; const warnings = [];
  const chainId = Number(deploy.chainId || 466302);
  const paymaster = envAddr(env.PAYMASTER_ADDRESS) || envAddr(deploy.l4?.xgasDevPaymaster);
  const entryPoint = envAddr(env.AA_ENTRYPOINT) || envAddr(deploy.l4?.entryPoint) || getAddress(ENTRYPOINT_V07);
  const factory = envAddr(env.AA_SIMPLE_ACCOUNT_FACTORY) || envAddr(deploy.l4?.simpleAccountFactory);
  const xgasDev = envAddr(deploy.l3?.xgasDev) || getAddress(XGAS_DEV_POOL.currency1);
  const signerK = keyFromEnv(env.PAYMASTER_SIGNER_KEY);
  const debitK = keyFromEnv(env.PAYMASTER_DEBIT_KEY) || keyFromEnv(env.DESK_RELAYER_KEY);
  if (!paymaster) missing.push('PAYMASTER_ADDRESS (or l4.xgasDevPaymaster in l4-deployment.json)');
  if (!signerK) missing.push('PAYMASTER_SIGNER_KEY');
  else if (signerK.error) missing.push(`PAYMASTER_SIGNER_KEY (${signerK.error})`);
  if (!debitK) missing.push('DESK_RELAYER_KEY or PAYMASTER_DEBIT_KEY (the wallet that burns the XGAS.DEV)');
  else if (debitK.error) missing.push(`debit key (${debitK.error})`);
  const signer = signerK?.account || null; const debit = debitK?.account || null;
  const privileged = [deploy.owner, ...(deploy.l3?.timelockProposers || [])].filter(Boolean).map((a) => String(a).toLowerCase());
  if (signer && privileged.includes(signer.address.toLowerCase())) { missing.push('PAYMASTER_SIGNER_KEY (a privileged key; use a dedicated one)'); }
  if (debit && privileged.includes(debit.address.toLowerCase())) { missing.push('debit key (a privileged key; use a dedicated one)'); }
  if (signer && debit && signer.address === debit.address) warnings.push('the paymaster signer and the debit wallet are the same key; keep them apart');
  if (!factory) warnings.push('no SimpleAccountFactory configured (AA_SIMPLE_ACCOUNT_FACTORY): only sender == payer accounts can be sponsored');
  const bundlerUpstream = String(env.BUNDLER_URL || '').trim() || null;
  const publicOrigin = String(env.PUBLIC_ORIGIN || 'https://xgas.dev').replace(/\/+$/, '');
  return {
    enabled: missing.length === 0, missing, warnings,
    chainId, paymaster, entryPoint, factory, xgasDev, signer, debit,
    bundlerUpstream,
    bundlerUrl: String(env.BUNDLER_PUBLIC_URL || '').trim() || (bundlerUpstream ? `${publicOrigin}/api/bundler/${chainId}` : null),
    paymasterUrl: `${publicOrigin}/api/paymaster/${chainId}`,
    bufferBps: envInt(env, 'PAYMASTER_BUFFER_BPS', 1000, 0, 10_000),
    maxDivergenceBps: envInt(env, 'PAYMASTER_MAX_DIVERGENCE_BPS', 500, 1, 5_000),
    emaWarmupS: envInt(env, 'PAYMASTER_EMA_WARMUP_S', 60, 0, 3600),
    validityS: envInt(env, 'PAYMASTER_VALIDITY_S', 300, 60, 3600),
    // Worst case the deposit can lose to payers who revoke after landing ops: about dailyLossWei + inFlightTotalWei
    // per UTC day. A typical L4 op costs ~0.0002 xMoney at the 0.1 gwei base fee, so these are generous for use.
    maxOutstanding: envInt(env, 'PAYMASTER_MAX_OUTSTANDING', 8, 1, 1000),
    newPayerMaxOutstanding: envInt(env, 'PAYMASTER_NEW_PAYER_MAX_OUTSTANDING', 2, 1, 1000),
    maxOpWei: envXmoney(env, 'PAYMASTER_MAX_OP_XMONEY', '0.02'),
    creditWei: envXmoney(env, 'PAYMASTER_CREDIT_XMONEY', '0.1'),
    newPayerCreditWei: envXmoney(env, 'PAYMASTER_NEW_PAYER_CREDIT_XMONEY', '0.01'),
    dailyPerPayerWei: envXmoney(env, 'PAYMASTER_DAILY_XMONEY_PER_PAYER', '0.5'),
    dailyTotalWei: envXmoney(env, 'PAYMASTER_DAILY_XMONEY_TOTAL', '5'),
    inFlightTotalWei: envXmoney(env, 'PAYMASTER_INFLIGHT_XMONEY_TOTAL', '1'),
    dailyLossWei: envXmoney(env, 'PAYMASTER_DAILY_LOSS_XMONEY', '0.25'),
    maxPriorityFeeWei: envGwei(env, 'PAYMASTER_MAX_PRIORITY_FEE_GWEI', '0.001'),
    maxFeeMultiple: envInt(env, 'PAYMASTER_MAX_FEE_MULTIPLE', 10, 1, 1000),
    startBlock: BigInt(envInt(env, 'PAYMASTER_START_BLOCK', Number(deploy.l4?.xgasDevPaymasterBlock || 0), 0, Number.MAX_SAFE_INTEGER)),
  };
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
function jsonSafe(v) { return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))); }
const fmt = (wei) => formatEther(BigInt(wei));

/**
 * @param deps.config   resolveConfig() output
 * @param deps.l4       viem public client for chain 466302
 * @param deps.rh       viem public client for Robinhood 4663
 * @param deps.ethFairPrice  async () => ({ cents }) | null   (server.js median of Coinbase, Kraken, Bitstamp)
 */
export function createPaymasterService({ config, l4, rh, ethFairPrice, dataDir, now = () => Date.now(), log = console, ledger: injectedLedger, fetchImpl = fetch, ipOf = (req) => req.ip || 'unknown' }) {
  const cfg = config;
  const ledger = injectedLedger || (cfg.enabled ? new Ledger({ file: path.join(dataDir, 'paymaster-ledger.json'), now }) : null);
  const tracker = new PriceTracker({ warmupS: cfg.emaWarmupS, maxDivergenceBps: cfg.maxDivergenceBps, now });
  const poolId = v4PoolId(XGAS_DEV_POOL);
  const slot0Slot = v4Slot0StorageSlot(poolId);
  const worker = cfg.enabled ? createDebitWorker({
    ledger, l4, rh, account: cfg.debit, paymaster: cfg.paymaster, entryPoint: cfg.entryPoint, xgasDev: cfg.xgasDev,
    startBlock: cfg.startBlock, rateFallback: async () => (await currentRate()).rateWad, log, now,
  }) : null;
  const cache = new Map();
  async function cached(key, ttlMs, fn) {
    const c = cache.get(key);
    if (c && now() - c.at < ttlMs) return c.v;
    const v = await fn(); cache.set(key, { at: now(), v }); return v;
  }

  // --- prices ---------------------------------------------------------------------------------------------
  let lastPoolError = null;
  async function samplePool() {
    try {
      const word = await rh.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [slot0Slot] });
      const { sqrtPriceX96 } = decodeSlot0(word);
      const spot = Number(priceWadFromSqrtX96(sqrtPriceX96)) / 1e18;
      tracker.sample(spot); lastPoolError = null;
    } catch (e) { lastPoolError = String(e?.shortMessage || e?.message || e).slice(0, 200); }
  }
  async function navWad() {
    return cached('nav', 300_000, async () => {
      const r = await rh.readContract({ address: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E', abi: VAULT_ABI, functionName: 'getReserveNAV' }).catch(() => null);
      return navWadFromVault(r ? r[0] : null);
    });
  }
  async function currentRate() {
    if (tracker.lastAt == null || now() - tracker.lastAt > 15_000) await samplePool();
    const chk = tracker.check();
    if (!chk.ok) throw new PolicyError(`XGAS.DEV price check failed: ${chk.reason}. Try again in a minute.`, { reason: 'price' });
    const eth = await ethFairPrice().catch(() => null);
    if (!eth || !/^\d+$/.test(String(eth.cents)) || BigInt(eth.cents) <= 0n) throw new PolicyError('No ETH/USD price source answered. Try again in a minute.', { reason: 'price' });
    const ethUsdWad = BigInt(eth.cents) * 10n ** 16n;
    const nav = await navWad();
    const xgasPerEthWad = floatToWad(chk.conservative);
    const rate = rateWad({ navWad: nav.navWad, xgasPerEthWad, ethUsdWad, bufferBps: cfg.bufferBps });
    return { rateWad: rate, ethUsdWad, navWad: nav.navWad, navSource: nav.source, xgasPerEthWad, divergenceBps: chk.divergenceBps };
  }

  // --- who pays ---------------------------------------------------------------------------------------------
  async function resolvePayer(op, ctx) {
    const claimed = ctx.robinhoodPayer ?? ctx.payer;
    let claim = null;
    if (claimed != null) {
      if (typeof claimed !== 'string' || !isAddress(claimed, { strict: false })) throw new PaymasterInputError('context.robinhoodPayer is not an address');
      claim = getAddress(claimed);
    }
    let salt = 0n;
    if (ctx.accountSalt != null) {
      try { salt = BigInt(ctx.accountSalt); } catch { throw new PaymasterInputError('context.accountSalt is not a number'); }
      if (salt < 0n || salt >= 1n << 256n) throw new PaymasterInputError('context.accountSalt is out of range');
    }
    if (claim && claim === op.sender) return { payer: claim, how: 'sender' };
    if (op.factory) {
      if (!cfg.factory || op.factory !== cfg.factory) throw new PolicyError('This account is created by an unknown factory. Pay with the account itself as robinhoodPayer, or use the xGas SimpleAccountFactory.', { reason: 'payer' });
      const owner = simpleAccountOwnerFromFactoryData(op.factoryData);
      if (!owner) throw new PolicyError('factoryData is not SimpleAccountFactory.createAccount(owner, salt).', { reason: 'payer' });
      if (claim && claim !== owner) throw new PolicyError('robinhoodPayer must be the owner of the account being created.', { reason: 'payer' });
      return { payer: owner, how: 'factory-initcode' };
    }
    let hint = claim;
    if (!hint && cfg.factory) hint = await l4.readContract({ address: op.sender, abi: ACCOUNT_ABI, functionName: 'owner' }).then(getAddress).catch(() => null);
    if (hint && cfg.factory) {
      const computed = await l4.readContract({ address: cfg.factory, abi: FACTORY_VIEW_ABI, functionName: 'getAddress', args: [hint, salt] }).catch(() => null);
      if (computed && getAddress(computed) === op.sender) return { payer: hint, how: 'factory-address' };
    }
    if (claim) throw new PolicyError('robinhoodPayer must be the account itself or the owner of an xGas SimpleAccount at this address (check context.accountSalt).', { reason: 'payer' });
    return { payer: op.sender, how: 'sender' };
  }

  // --- the sponsorship --------------------------------------------------------------------------------------
  async function paymasterDeposit() {
    return cached('deposit', 15_000, async () => {
      const code = await l4.getCode({ address: cfg.paymaster }).catch(() => null);
      if (!code || code === '0x') return { deployed: false, wei: 0n };
      const at = now();
      const wei = await l4.readContract({ address: cfg.entryPoint, abi: ENTRYPOINT_ABI, functionName: 'balanceOf', args: [cfg.paymaster] });
      return { deployed: true, wei, at };
    });
  }
  async function l4GasPrice() { return cached('l4gp', 30_000, () => l4.getGasPrice()); }

  async function prepare(params, { final }) {
    if (!Array.isArray(params) || params.length < 3) throw new PaymasterInputError('params must be [userOp, entryPoint, chainId, context?]');
    const [rawOp, ep, chainIdRaw, context] = params;
    if (typeof ep !== 'string' || !isAddress(ep, { strict: false }) || getAddress(ep) !== cfg.entryPoint) {
      throw new PaymasterInputError(`unsupported EntryPoint; this paymaster serves ${cfg.entryPoint} (v0.7)`);
    }
    let cid; try { cid = typeof chainIdRaw === 'number' ? chainIdRaw : Number(BigInt(chainIdRaw)); } catch { cid = NaN; }
    if (cid !== cfg.chainId) throw new PaymasterInputError(`unsupported chainId; this paymaster serves ${numberToHex(cfg.chainId)} (${cfg.chainId})`);
    const op = parseUserOp(rawOp);
    const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};

    const pmV = op.paymasterVerificationGasLimit ?? DEFAULT_PM_VERIFICATION_GAS;
    const pmP = op.paymasterPostOpGasLimit ?? DEFAULT_PM_POSTOP_GAS;
    if (pmP < MIN_PM_POSTOP_GAS) throw new PolicyError(`paymasterPostOpGasLimit must be at least ${MIN_PM_POSTOP_GAS}`, { reason: 'gas' });
    if (pmP > MAX_PM_POSTOP_GAS || pmV > MAX_PM_VERIFICATION_GAS) throw new PolicyError('paymaster gas limits are too high', { reason: 'gas' });
    // The L4 sequencer keeps no priority fee, but the EntryPoint charges min(maxFee, baseFee + priority) to the deposit.
    if (op.maxPriorityFeePerGas > cfg.maxPriorityFeeWei) {
      throw new PolicyError(`maxPriorityFeePerGas is ${formatGwei(op.maxPriorityFeePerGas)} gwei; the XGAS.DEV paymaster signs at most ${formatGwei(cfg.maxPriorityFeeWei)} gwei (the xGas L4 pays no priority fee to anyone). Use the bundler's pimlico_getUserOperationGasPrice.`, { reason: 'priority-fee', maxPriorityFeePerGas: cfg.maxPriorityFeeWei.toString() });
    }
    if (op.maxFeePerGas > 0n) {
      const gp = await l4GasPrice();
      const ceiling = gp * BigInt(cfg.maxFeeMultiple);
      if (op.maxFeePerGas > ceiling) throw new PolicyError(`maxFeePerGas is ${formatGwei(op.maxFeePerGas)} gwei; the XGAS.DEV paymaster signs at most ${formatGwei(ceiling)} gwei (${cfg.maxFeeMultiple}x the L4 gas price)`, { reason: 'max-fee', maxFeePerGas: ceiling.toString() });
    }

    let maxCost = requiredPrefund(op, pmV, pmP);
    let estimated = false;
    if (final) {
      if (op.verificationGasLimit === 0n || op.maxFeePerGas === 0n || op.preVerificationGas === 0n) {
        throw new PaymasterInputError('fill the gas fields (estimate with the stub first) before pm_getPaymasterData');
      }
    } else if (maxCost === 0n || op.verificationGasLimit === 0n) {
      // Stub time: gas is not estimated yet. Quote a typical ceiling so the wallet can show a number.
      const fee = op.maxFeePerGas > 0n ? op.maxFeePerGas : (await l4GasPrice()) * 2n;
      maxCost = (600_000n + 400_000n + 300_000n + pmV + pmP) * fee;
      estimated = true;
    }
    if (maxCost > cfg.maxOpWei) throw new PolicyError(`this operation could cost up to ${fmt(maxCost)} xMoney in gas; the XGAS.DEV paymaster covers up to ${fmt(cfg.maxOpWei)} per operation`, { reason: 'cap-op' });

    const { payer, how } = await resolvePayer(op, ctx);
    const rate = await currentRate();
    const maxCharge = maxChargeFor(maxCost, rate.rateWad);
    const nowS = Math.floor(now() / 1000);
    const validUntil = Math.ceil((nowS + cfg.validityS) / 60) * 60;   // 60 s buckets: a retried request signs the same bytes
    const validAfter = 0;

    const info = {
      robinhoodPayer: payer, payerCheck: how, spender: cfg.debit.address, xgasDev: cfg.xgasDev, burnAddress: BURN_ADDRESS,
      maxCostWei: maxCost.toString(), maxCostXmoney: fmt(maxCost), maxXgasDevCharge: maxCharge.toString(), maxXgasDevChargeFormatted: fmt(maxCharge),
      xgasDevPerXmoney: wadToDec(rate.rateWad, 6), bufferBps: cfg.bufferBps, validUntil, estimated,
      note: 'XGAS.DEV spent on gas is burned. You are charged for the gas actually used, at this rate, never more than maxXgasDevCharge.',
    };

    let signed = null;
    if (final) {
      signed = await signSponsorship({
        signer: cfg.signer, op, chainId: cfg.chainId, entryPoint: cfg.entryPoint, paymaster: cfg.paymaster,
        pmVerificationGasLimit: pmV, pmPostOpGasLimit: pmP, validUntil, validAfter, maxXgasDevCharge: maxCharge, robinhoodPayer: payer,
      });
    }

    // Every network read the decision needs, BEFORE the decision (see "Concurrency" at the top of this file).
    const [bal, allowance, dep] = await Promise.all([
      rh.readContract({ address: cfg.xgasDev, abi: ERC20_ABI, functionName: 'balanceOf', args: [payer] }),
      rh.readContract({ address: cfg.xgasDev, abi: ERC20_ABI, functionName: 'allowance', args: [payer, cfg.debit.address] }),
      paymasterDeposit(),
    ]);

    // ---- no await from here to the end of prepare(): decide and reserve atomically ----
    // Same op, same minute: hand back the same signature without counting it twice (it is already reserved).
    if (final && ledger.quote(signed.userOpHash)) return { paymaster: cfg.paymaster, paymasterData: signed.paymasterData, xgas: { ...info, userOpHash: signed.userOpHash } };
    // The stub runs the same checks, so a wallet learns before gas estimation that it will be refused.
    const tier = checkPolicy({ payer, maxCost, maxCharge, bal, allowance, dep });
    info.payerTier = tier.proven ? 'proven' : 'new';
    info.creditXmoney = fmt(tier.credit);

    if (!final) {
      return {
        paymaster: cfg.paymaster,
        paymasterData: stubPaymasterData({ validUntil, validAfter, maxXgasDevCharge: maxCharge, robinhoodPayer: payer }),
        paymasterVerificationGasLimit: numberToHex(pmV),
        paymasterPostOpGasLimit: numberToHex(pmP),
        sponsor: { name: 'xGas: gas paid in XGAS.DEV (burned)' },
        isFinal: false,
        xgas: info,
      };
    }
    ledger.upsertQuote({ userOpHash: signed.userOpHash, payer, sender: op.sender, maxCost, maxCharge, rateWad: rate.rateWad, validUntil });
    try { ledger.save(); } catch (e) {
      // Not persisted: keep the reservation in memory (it still counts against every cap) but hand out nothing.
      log.error?.(`[paymaster] ledger save failed: ${e?.message || e}`);
      throw e;
    }
    return { paymaster: cfg.paymaster, paymasterData: signed.paymasterData, xgas: { ...info, userOpHash: signed.userOpHash } };
  }

  /**
   * Every limit, against the ledger as it is right now. Synchronous on purpose: the caller reserves the quote right
   * after it returns, with no await in between, so concurrent requests see each other's reservations.
   */
  function checkPolicy({ payer, maxCost, maxCharge, bal, allowance, dep }) {
    const t = now();
    const ex = ledger.payerExposure(payer, t);
    const proven = ex.provenCount > 0;
    const credit = proven ? cfg.creditWei : (cfg.newPayerCreditWei < cfg.creditWei ? cfg.newPayerCreditWei : cfg.creditWei);
    const maxOut = proven ? cfg.maxOutstanding : Math.min(cfg.maxOutstanding, cfg.newPayerMaxOutstanding);
    if (ex.unpaidCount > 0) throw new PolicyError(`${payer} has ${ex.unpaidCount} unpaid gas charge(s) (${fmt(ex.unpaidXgas)} XGAS.DEV). Restore the XGAS.DEV balance and allowance to settle them first.`, { reason: 'unpaid', unpaidXgasDev: ex.unpaidXgas.toString() });
    if (ledger.dailyLossWei(t) >= cfg.dailyLossWei) throw new PolicyError('XGAS.DEV gas is paused until 00:00 UTC: too many of today\'s gas charges went unpaid. Pay gas in xMoney meanwhile.', { reason: 'cap-loss' });
    if (ex.quotes >= maxOut) throw new PolicyError(proven ? 'too many sponsored operations in flight for this payer; wait for them to land or expire' : `a new payer can have ${maxOut} sponsored operation(s) in flight until its first XGAS.DEV gas charge settles on Robinhood; wait for it to land`, { reason: 'outstanding', proven });
    if (ex.owedWei + maxCost > credit) {
      if (!proven) throw new PolicyError(`new payers get ${fmt(credit)} xMoney of gas on credit until their first XGAS.DEV gas charge settles on Robinhood (a few seconds after the first operation lands); ${fmt(ex.owedWei)} is in use and this operation could cost up to ${fmt(maxCost)}`, { reason: 'warmup', creditXmoney: fmt(credit) });
      throw new PolicyError(`credit limit: ${fmt(ex.owedWei)} xMoney of gas is still being settled for this payer (limit ${fmt(credit)})`, { reason: 'credit' });
    }
    if (ex.dailyWei + maxCost > cfg.dailyPerPayerWei) throw new PolicyError(`daily limit reached for this payer (${fmt(cfg.dailyPerPayerWei)} xMoney of gas per UTC day)`, { reason: 'cap-payer-day' });
    if (ledger.dailyTotalWei(t) + maxCost > cfg.dailyTotalWei) throw new PolicyError('the XGAS.DEV paymaster reached its daily limit; try again after 00:00 UTC or pay gas in xMoney', { reason: 'cap-day' });
    if (ledger.inFlightWei(t) + maxCost > cfg.inFlightTotalWei) throw new PolicyError('the XGAS.DEV paymaster has too much gas waiting to be settled right now; try again in a minute or pay gas in xMoney', { reason: 'cap-inflight' });

    // Cumulative: everything this payer may owe, including this op, must be held and approved right now.
    const need = ex.owedXgas + maxCharge;
    if (allowance < need) throw new PolicyError(`approve XGAS.DEV to ${cfg.debit.address} on Robinhood first (needs ${fmt(need)}, allowed ${fmt(allowance)})`, { reason: 'allowance', spender: cfg.debit.address, xgasDev: cfg.xgasDev, needed: need.toString(), allowance: allowance.toString() });
    if (bal < need) throw new PolicyError(`not enough XGAS.DEV on Robinhood (needs ${fmt(need)}, holds ${fmt(bal)})`, { reason: 'balance', needed: need.toString(), balance: bal.toString() });

    if (!dep.deployed) throw new PolicyError(`the paymaster contract ${cfg.paymaster} is not deployed on chain ${cfg.chainId}`, { reason: 'paymaster' });
    // The deposit reading may be up to 15 s old: take off what landed since and everything signed but not landed.
    const free = dep.wei - ledger.debitsWeiSince(dep.at) - ledger.outstandingWei(t);
    if (free < maxCost * 2n) throw new PolicyError('the paymaster deposit is too low right now; pay gas in xMoney or try later', { reason: 'deposit' });
    return { proven, credit, exposure: ex };
  }

  async function call(method, params) {
    switch (method) {
      case 'pm_getPaymasterStubData': return prepare(params, { final: false });
      case 'pm_getPaymasterData': return prepare(params, { final: true });
      case 'pm_supportedEntryPoints': return [cfg.entryPoint];
      case 'eth_chainId': return numberToHex(cfg.chainId);
      default: { const e = new Error('method not found'); e.code = -32601; throw e; }
    }
  }
  async function one(msg) {
    const id = msg && typeof msg === 'object' ? msg.id : null;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(id, -32600, 'invalid request');
    try {
      return rpcResult(id, jsonSafe(await call(msg.method, msg.params ?? [])));
    } catch (e) {
      if (e.code === -32601) return rpcError(id, -32601, `method not found: ${msg.method}`);
      if (e instanceof PaymasterInputError) return rpcError(id, -32602, e.message);
      if (e instanceof PolicyError) return rpcError(id, -32001, e.message, jsonSafe(e.data));
      log.error?.(`[paymaster] ${msg.method} failed: ${e?.shortMessage || e?.message || e}`);
      return rpcError(id, -32603, 'paymaster internal error; try again or pay gas in xMoney');
    }
  }

  // --- HTTP -------------------------------------------------------------------------------------------------
  const hits = new Map();
  function rateLimited(ip, n = 1) {
    const t = now(); const w = 60_000; const max = 120;
    let h = hits.get(ip); if (!h || t - h.at > w) { h = { at: t, n: 0 }; hits.set(ip, h); }
    h.n += n;
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.at > w) hits.delete(k);
    return h.n > max;
  }

  async function rpcHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    const body = req.body;
    const firstId = Array.isArray(body) ? null : body?.id;
    if (!cfg.enabled) return res.status(503).json(rpcError(firstId, -32003, 'The XGAS.DEV paymaster is not configured on this host yet. Pay gas in xMoney.', { missing: cfg.missing }));
    if (Array.isArray(body) && (!body.length || body.length > 10)) return res.status(400).json(rpcError(null, -32600, 'batch must hold 1 to 10 requests'));
    // Every request in a batch counts against the rate limit, and a batch runs one request at a time.
    if (rateLimited(ipOf(req), Array.isArray(body) ? body.length : 1)) return res.status(429).json(rpcError(firstId, -32005, 'too many requests; slow down'));
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) out.push(await one(m));
      return res.json(out);
    }
    if (!body || typeof body !== 'object') return res.status(400).json(rpcError(null, -32700, 'parse error'));
    res.json(await one(body));
  }

  async function status(payerQ) {
    const base = {
      enabled: cfg.enabled, missing: cfg.missing, warnings: cfg.warnings,
      chainId: cfg.chainId, chainIdHex: numberToHex(cfg.chainId), entryPoint: cfg.entryPoint, entryPointVersion: '0.7',
      paymaster: cfg.paymaster, simpleAccountFactory: cfg.factory, paymasterUrl: cfg.paymasterUrl, bundlerUrl: cfg.bundlerUrl,
      signer: cfg.signer?.address || null, spender: cfg.debit?.address || null,
      xgasDev: cfg.xgasDev, xgasDevChainId: 4663, burnAddress: BURN_ADDRESS, burned: true,
      limits: {
        maxOpXmoney: fmt(cfg.maxOpWei), creditXmoneyPerPayer: fmt(cfg.creditWei), dailyXmoneyPerPayer: fmt(cfg.dailyPerPayerWei),
        newPayerCreditXmoney: fmt(cfg.newPayerCreditWei), newPayerMaxOutstanding: cfg.newPayerMaxOutstanding,
        inFlightXmoneyTotal: fmt(cfg.inFlightTotalWei), dailyLossXmoney: fmt(cfg.dailyLossWei),
        maxPriorityFeeGwei: formatGwei(cfg.maxPriorityFeeWei), maxFeeMultiple: cfg.maxFeeMultiple,
        dailyXmoneyTotal: fmt(cfg.dailyTotalWei), maxOutstandingPerPayer: cfg.maxOutstanding, validityS: cfg.validityS,
        bufferBps: cfg.bufferBps, maxDivergenceBps: cfg.maxDivergenceBps,
        paymasterVerificationGasLimit: DEFAULT_PM_VERIFICATION_GAS.toString(), paymasterPostOpGasLimit: DEFAULT_PM_POSTOP_GAS.toString(),
      },
    };
    if (!cfg.enabled) return base;
    const t = tracker.state();
    let rate = null, rateError = null;
    try {
      const r = await currentRate();
      rate = {
        xgasDevPerXmoney: wadToDec(r.rateWad, 6), rateWad: r.rateWad.toString(), bufferIncluded: true,
        ethUsd: wadToDec(r.ethUsdWad, 2), xmoneyNavUsd: wadToDec(r.navWad, 6), navSource: r.navSource,
        xgasDevPerEth: wadToDec(r.xgasPerEthWad, 2), xgasDevUsd: wadToDec((r.ethUsdWad * WAD) / r.xgasPerEthWad, 8),
      };
    } catch (e) { rateError = e.message; }
    const dep = await paymasterDeposit().catch(() => null);
    const out = {
      ...base,
      price: { poolId, poolManager: POOL_MANAGER, spot: t.spot, ema10m: t.ema, divergenceBps: t.divergenceBps, samples: t.samples, lastPoolError, rate, rateError },
      deposit: dep ? { deployed: dep.deployed, xmoney: fmt(dep.wei) } : null,
      worker: { ...worker.status, cursor: ledger.cursor, ...jsonSafe(ledger.totals()) },
      dailyUsedXmoney: fmt(ledger.dailyTotalWei()),
      inFlightXmoney: fmt(ledger.inFlightWei()),
      dailyUnpaidXmoney: fmt(ledger.dailyLossWei()),
      paused: ledger.dailyLossWei() >= cfg.dailyLossWei,
    };
    if (payerQ) {
      const p = getAddress(payerQ);
      const ex = ledger.payerExposure(p);
      const [bal, allowance] = await Promise.all([
        rh.readContract({ address: cfg.xgasDev, abi: ERC20_ABI, functionName: 'balanceOf', args: [p] }).catch(() => null),
        rh.readContract({ address: cfg.xgasDev, abi: ERC20_ABI, functionName: 'allowance', args: [p, cfg.debit.address] }).catch(() => null),
      ]);
      out.payer = {
        address: p,
        xgasDevBalance: bal == null ? null : bal.toString(), xgasDevBalanceFormatted: bal == null ? null : fmt(bal),
        allowance: allowance == null ? null : allowance.toString(), allowanceFormatted: allowance == null ? null : fmt(allowance),
        owedXgasDev: ex.owedXgas.toString(), owedXgasDevFormatted: fmt(ex.owedXgas), outstandingQuotes: ex.quotes,
        unpaidCount: ex.unpaidCount, unpaidXgasDev: ex.unpaidXgas.toString(), blocked: ex.unpaidCount > 0,
        proven: ex.provenCount > 0, creditXmoney: fmt(ex.provenCount > 0 ? cfg.creditWei : (cfg.newPayerCreditWei < cfg.creditWei ? cfg.newPayerCreditWei : cfg.creditWei)),
        dailyUsedXmoney: fmt(ex.dailyWei), burnedXgasDev: fmt(ex.paidXgas), paidCount: ex.paidCount,
        recent: ledger.recentForPayer(p, 10).map((d) => ({
          userOpHash: d.userOpHash, sender: d.sender, state: d.state, charge: d.charge, chargeFormatted: fmt(d.charge),
          actualGasCostXmoney: fmt(d.actualGasCost), success: d.success, l4Tx: d.l4Tx, paidTx: d.paidTx, lastError: d.lastError, at: new Date(d.createdAt).toISOString(),
        })),
      };
    }
    return out;
  }

  async function statusHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    const q = typeof req.query.payer === 'string' ? req.query.payer : '';
    if (q && !isAddress(q, { strict: false })) return res.status(400).json({ error: 'payer must be an address' });
    try { res.json(jsonSafe(await status(q || null))); } catch (e) {
      log.error?.(`[paymaster] status failed: ${e?.message || e}`);
      res.status(500).json({ error: 'status unavailable' });
    }
  }

  async function bundlerHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    const body = req.body; const firstId = Array.isArray(body) ? null : body?.id;
    if (!cfg.bundlerUpstream) return res.status(503).json(rpcError(firstId, -32003, 'The xGas bundler is not configured on this host yet.'));
    if (rateLimited(`b:${ipOf(req)}`)) return res.status(429).json(rpcError(firstId, -32005, 'too many requests; slow down'));
    const msgs = Array.isArray(body) ? body : [body];
    if (!msgs.length || msgs.length > 10 || msgs.some((m) => !m || typeof m !== 'object' || !BUNDLER_METHODS.has(m.method))) {
      return res.status(400).json(rpcError(firstId, -32601, `bundler methods only: ${[...BUNDLER_METHODS].join(', ')}`));
    }
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await fetchImpl(cfg.bundlerUpstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      res.status(r.status).type('application/json').send(text);
    } catch {
      res.status(502).json(rpcError(firstId, -32603, 'bundler unreachable'));
    } finally { clearTimeout(timer); }
  }

  const router = express.Router();
  router.post(`/api/paymaster/${cfg.chainId}`, rpcHandler);
  router.get(`/api/paymaster/${cfg.chainId}/status`, statusHandler);
  router.post(`/api/bundler/${cfg.chainId}`, bundlerHandler);

  let poolTimer = null;
  function start() {
    if (!cfg.enabled) {
      log.log?.(`[paymaster] XGAS.DEV paymaster off: missing ${cfg.missing.join('; ')}`);
      return;
    }
    for (const w of cfg.warnings) log.warn?.(`[paymaster] ${w}`);
    log.log?.(`[paymaster] XGAS.DEV paymaster ${cfg.paymaster} on ${cfg.chainId}, EntryPoint ${cfg.entryPoint}, signer ${cfg.signer.address}, debit wallet ${cfg.debit.address}`);
    samplePool();
    poolTimer = setInterval(samplePool, 30_000); poolTimer.unref?.();
    worker.start();
  }
  function stop() { if (poolTimer) clearInterval(poolTimer); worker?.stop(); }

  // A body the JSON parser rejected (malformed, too large) gets a JSON-RPC error, not an HTML page.
  const errorPaths = [`/api/paymaster/${cfg.chainId}`, `/api/bundler/${cfg.chainId}`];
  function errorHandler(err, _req, res, next) {
    if (res.headersSent) return next(err);
    const status = err?.status >= 400 && err?.status < 500 ? err.status : 500;
    res.status(status).json(rpcError(null, status === 413 ? -32600 : -32700, status === 413 ? 'request too large' : 'parse error'));
  }

  return { router, errorPaths, errorHandler, start, stop, call, prepare, status, currentRate, samplePool, tracker, ledger, worker, config: cfg };
}
