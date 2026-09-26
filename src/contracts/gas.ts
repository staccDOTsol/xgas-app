// L4 gas, first gas of balance.
//
// Every write on the xGas L4 (#466302) goes through sendL4Tx. It picks how the gas is paid, in this order:
//   1. xmoney          the wallet holds enough native xMoney on the L4: a plain transaction, exactly as before.
//   2. wallet-paymaster the wallet reports EIP-5792 paymasterService support for 0x71d7e: wallet_sendCalls with
//                      our ERC-7677 paymaster URL. The user keeps their own address; gas is charged in XGAS.DEV.
//   3. smart-account   the wallet holds XGAS.DEV on Robinhood: an ERC-4337 UserOperation from a SimpleAccount
//                      (v0.7) owned by the wallet, sponsored by XgasDevPaymaster, sent through the xgas bundler.
//                      The wallet only signs a message; it never needs xMoney or even the L4 network added.
//   4. none            no xMoney and no XGAS.DEV: a GasNeededError that says how to get either.
// XGAS.DEV spent on gas is taken by the host's relayer with transferFrom and sent to 0x...dEaD: it is burned.
import { useEffect, useSyncExternalStore } from 'react';
import {
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  createBundlerClient,
  createPaymasterClient,
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
  toSmartAccount,
  type SmartAccount,
} from 'viem/account-abstraction';
import { CONTRACT_ADDRESSES } from './abis';
import {
  ensureChain,
  l4PublicClient,
  L3_CHAIN_ID,
  L4_CHAIN_ID,
  publicClient,
  sendOnChainTx,
  TxError,
  xgasOrbitChain,
} from './web3Client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const L4_CHAIN_HEX = `0x${L4_CHAIN_ID.toString(16)}`; // 0x71d7e
export const PAYMASTER_PATH = `/api/paymaster/${L4_CHAIN_ID}`;
export const XGAS_DEV: Address = CONTRACT_ADDRESSES.XGAS_DEV as Address;
export const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';
/** Canonical EntryPoint v0.7 (CREATE2). The status endpoint overrides it when the L4 got a plain deploy. */
const DEFAULT_ENTRYPOINT: Address = entryPoint07Address;
/** Gas a typical L4 write takes when we cannot estimate it (used for the panel and the balance check). */
const TYPICAL_GAS = 300_000n;
/** Robinhood gas an ERC-20 approve takes, with room. */
const APPROVE_GAS = 70_000n;

const env = (import.meta as any).env || {};
const ENV_BUNDLER_URL: string = env.VITE_XGAS_BUNDLER_URL || '';
const ENV_FACTORY: string = env.VITE_XGAS_AA_FACTORY || '';
/** The host's allowlisted proxy to the Alto bundler, used when the status names no public bundler URL. */
const BUNDLER_PROXY_PATH = `/api/bundler/${L4_CHAIN_ID}`;

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// SimpleAccount / SimpleAccountFactory v0.7 (eth-infinitism @account-abstraction/contracts 0.7.0)
const SIMPLE_ACCOUNT_ABI = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);
const SIMPLE_FACTORY_ABI = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
]);
/** 65-byte stub that ECDSA.recover accepts without reverting, for gas estimation only. */
const STUB_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

export type GasMode = 'xmoney' | 'wallet-paymaster' | 'smart-account' | 'none';

export const GAS_MODE_LABEL: Record<GasMode, string> = {
  xmoney: 'xMoney from your wallet',
  'wallet-paymaster': 'XGAS.DEV, from your own address',
  'smart-account': 'XGAS.DEV, through your xGas account',
  none: 'No gas yet',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** No way to pay the gas: carries what the user can do about it. */
export class GasNeededError extends Error {
  constructor(message: string, public readonly plan: GasPlan | null) {
    super(message);
    this.name = 'GasNeededError';
  }
}

// ---------------------------------------------------------------------------
// Paymaster status (GET /api/paymaster/466302/status), parsed defensively
// ---------------------------------------------------------------------------
export interface PaymasterStatus {
  live: boolean;
  reason: string | null;
  entryPoint: Address;
  factory: Address | null;
  paymaster: Address | null;
  bundlerUrl: string;
  /** Robinhood address the user approves XGAS.DEV to (the debit wallet that calls transferFrom). */
  spender: Address | null;
  /** XGAS.DEV per 1 xMoney of gas. Null when the host has no price right now. */
  xgasDevPerXMoney: number | null;
  /** True when xgasDevPerXMoney already carries the buffer (the host's rate does). */
  bufferIncluded: boolean;
  bufferBps: number;
  suggestedAllowance: bigint | null;
  payer: {
    blocked: boolean;
    reason: string | null;
    unpaid: bigint;
    owed: bigint;
  } | null;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
function pickAddr(...vals: any[]): Address | null {
  for (const v of vals) {
    if (typeof v === 'string' && ADDR_RE.test(v) && !/^0x0{40}$/.test(v)) return v as Address;
    if (v && typeof v === 'object' && typeof v.address === 'string' && ADDR_RE.test(v.address)) return v.address as Address;
  }
  return null;
}
function pickNum(...vals: any[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function pickWei(...vals: any[]): bigint | null {
  for (const v of vals) {
    if (v == null || v === '') continue;
    try {
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.floor(v));
      if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
    } catch {}
  }
  return null;
}
function pickStr(...vals: any[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

// Shape served by server/paymaster/service.mjs (enabled, paymaster, simpleAccountFactory, bundlerUrl, spender,
// limits{...Xmoney}, price.rate.xgasDevPerXmoney with bufferIncluded, payer{blocked, unpaidXgasDev, owedXgasDev}),
// with a few aliases so a renamed field degrades to "not live" instead of a crash.
function parseStatus(j: any): PaymasterStatus {
  const c = j?.contracts || j?.addresses || {};
  const price = j?.price || {};
  const rate = price.rate || {};
  const limits = j?.limits || {};
  const xgasUsd = pickNum(rate.xgasDevUsd, price.xgasDevUsd);
  const navUsd = pickNum(rate.xmoneyNavUsd, price.xMoneyNavUsd) ?? 1;
  const direct = pickNum(rate.xgasDevPerXmoney, rate.xgasDevPerXMoney, price.xgasDevPerXmoney, j?.xgasDevPerXmoney);
  const ratio = direct ?? (xgasUsd ? navUsd / xgasUsd : null);
  const bufferIncluded = direct != null ? rate.bufferIncluded !== false : false;
  const bufferBps = pickNum(limits.bufferBps, j?.bufferBps) ?? 1000;
  const p = j?.payer && typeof j.payer === 'object' ? j.payer : null;
  const entryPoint = pickAddr(j?.entryPoint, c.entryPoint) || DEFAULT_ENTRYPOINT;
  const factory = pickAddr(j?.simpleAccountFactory, j?.factory, c.simpleAccountFactory, ENV_FACTORY);
  const paymaster = pickAddr(j?.paymaster, c.paymaster);
  const live = !!(j?.enabled ?? j?.live) && !!paymaster;
  const missing = Array.isArray(j?.missing) && j.missing.length ? ` Missing: ${j.missing.join(', ')}.` : '';
  // One day of the per-payer daily cap, priced at the current rate: the approval asked for once.
  const dailyX = pickNum(limits.dailyXmoneyPerPayer);
  const suggested = pickWei(j?.suggestedAllowance)
    ?? (dailyX && ratio ? BigInt(Math.ceil(dailyX * ratio * (bufferIncluded ? 1 : 1 + bufferBps / 10_000) * 1e6)) * 10n ** 12n : null);
  return {
    live,
    reason: pickStr(j?.reason, j?.error, price.rateError) || (live ? null : `XGAS.DEV gas is not live on this host yet.${missing}`),
    entryPoint,
    factory,
    paymaster,
    bundlerUrl: pickStr(j?.bundlerUrl, ENV_BUNDLER_URL) || `${typeof window !== 'undefined' ? window.location.origin : ''}${BUNDLER_PROXY_PATH}`,
    spender: pickAddr(j?.spender),
    xgasDevPerXMoney: ratio,
    bufferIncluded,
    bufferBps,
    suggestedAllowance: suggested,
    payer: p ? {
      blocked: !!p.blocked,
      reason: p.blocked ? pickStr(p.reason) || `XGAS.DEV gas is paused for this address until ${p.unpaidCount || 'its'} unpaid gas charge${p.unpaidCount === 1 ? '' : 's'} settle${p.unpaidCount === 1 ? 's' : ''}. Keep the XGAS.DEV allowance and balance in place.` : null,
      unpaid: pickWei(p.unpaidXgasDev) ?? 0n,
      owed: pickWei(p.owedXgasDev) ?? 0n,
    } : null,
  };
}

const OFFLINE_STATUS: PaymasterStatus = parseStatus({ live: false, reason: 'Could not reach the XGAS.DEV gas service.' });

const statusCache = new Map<string, { at: number; p: Promise<PaymasterStatus> }>();
export function fetchPaymasterStatus(payer?: string, force = false): Promise<PaymasterStatus> {
  const key = (payer || '').toLowerCase();
  const hit = statusCache.get(key);
  if (!force && hit && Date.now() - hit.at < 20_000) return hit.p;
  const p = (async () => {
    try {
      const q = payer ? `?payer=${payer}` : '';
      const res = await fetch(`${PAYMASTER_PATH}/status${q}`, { credentials: 'same-origin' });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('application/json')) return OFFLINE_STATUS; // an older host answers with the SPA
      const j = await res.json().catch(() => null);
      if (!j) return OFFLINE_STATUS;
      if (!res.ok) return parseStatus({ ...j, live: false });
      return parseStatus(j);
    } catch {
      return OFFLINE_STATUS;
    }
  })();
  statusCache.set(key, { at: Date.now(), p });
  return p;
}

// ---------------------------------------------------------------------------
// Robinhood side: XGAS.DEV balance, allowance to the relayer, ETH for the approve
// ---------------------------------------------------------------------------
export interface XgasDevPosition { balance: bigint; allowance: bigint; robinhoodEth: bigint; approveCost: bigint }

export async function readXgasDevPosition(owner: string, spender: string | null): Promise<XgasDevPosition> {
  const o = owner as Address;
  const [balance, allowance, robinhoodEth, gasPrice] = await Promise.all([
    publicClient.readContract({ address: XGAS_DEV, abi: ERC20_ABI, functionName: 'balanceOf', args: [o] }).catch(() => 0n),
    spender
      ? publicClient.readContract({ address: XGAS_DEV, abi: ERC20_ABI, functionName: 'allowance', args: [o, spender as Address] }).catch(() => 0n)
      : Promise.resolve(0n),
    publicClient.getBalance({ address: o }).catch(() => 0n),
    publicClient.getGasPrice().catch(() => 0n),
  ]);
  return { balance, allowance, robinhoodEth, approveCost: (gasPrice * APPROVE_GAS * 3n) / 2n };
}

// ---------------------------------------------------------------------------
// SimpleAccount v0.7 owned by the injected wallet
// ---------------------------------------------------------------------------
const saAddrCache = new Map<string, Promise<Address | null>>();
/** Counterfactual SimpleAccount address for `owner` (salt 0), or null when the factory is not on the L4 yet. */
export function xgasAccountAddress(owner: string, factory: Address | null): Promise<Address | null> {
  if (!owner || !factory) return Promise.resolve(null);
  const key = `${factory}:${owner}`.toLowerCase();
  let p = saAddrCache.get(key);
  if (!p) {
    p = l4PublicClient
      .readContract({ address: factory, abi: SIMPLE_FACTORY_ABI, functionName: 'getAddress', args: [owner as Address, 0n] })
      .then(a => (a && !/^0x0{40}$/.test(a) ? (a as Address) : null))
      .catch(() => { saAddrCache.delete(key); return null; });
    saAddrCache.set(key, p);
  }
  return p;
}

function ethereum(): any {
  const e = (window as any).ethereum;
  if (!e) throw new Error('No EVM wallet detected (MetaMask/Rabby).');
  return e;
}

export async function toXgasSimpleAccount(owner: Address, st: PaymasterStatus): Promise<SmartAccount> {
  if (!st.factory) throw new Error('The xGas account factory is not deployed on the L4 yet.');
  const factory = st.factory;
  const entryPoint = { abi: entryPoint07Abi, address: st.entryPoint, version: '0.7' as const };
  const address = await xgasAccountAddress(owner, factory);
  if (!address) throw new Error('Could not work out your xGas account address from the factory.');
  return toSmartAccount({
    client: l4PublicClient,
    entryPoint,
    async getAddress() { return address; },
    async encodeCalls(calls) {
      if (calls.length === 1) {
        return encodeFunctionData({ abi: SIMPLE_ACCOUNT_ABI, functionName: 'execute', args: [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? '0x'] });
      }
      return encodeFunctionData({
        abi: SIMPLE_ACCOUNT_ABI, functionName: 'executeBatch',
        args: [calls.map(c => c.to), calls.map(c => c.value ?? 0n), calls.map(c => c.data ?? '0x')],
      });
    },
    async getFactoryArgs() {
      return {
        factory,
        factoryData: encodeFunctionData({ abi: SIMPLE_FACTORY_ABI, functionName: 'createAccount', args: [owner, 0n] }),
      };
    },
    async getNonce() {
      return l4PublicClient.readContract({ address: st.entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [address, 0n] }) as Promise<bigint>;
    },
    async getStubSignature() { return STUB_SIGNATURE; },
    async signMessage({ message }) {
      const data = typeof message === 'string' ? toHex(message) : typeof message.raw === 'string' ? message.raw : toHex(message.raw);
      return ethereum().request({ method: 'personal_sign', params: [data, owner] }) as Promise<Hex>;
    },
    async signTypedData() {
      throw new Error('The xGas account does not sign typed data.');
    },
    // SimpleAccount v0.7 checks ECDSA.recover(toEthSignedMessageHash(userOpHash)) == owner: a personal_sign of the hash.
    async signUserOperation(op) {
      const { chainId = L4_CHAIN_ID, ...userOperation } = op as any;
      const hash = getUserOperationHash({
        chainId,
        entryPointAddress: st.entryPoint,
        entryPointVersion: '0.7',
        userOperation: { ...userOperation, sender: address },
      });
      return ethereum().request({ method: 'personal_sign', params: [hash, owner] }) as Promise<Hex>;
    },
  });
}

// ---------------------------------------------------------------------------
// EIP-5792: does the wallet sponsor through a paymaster URL on 0x71d7e?
// ---------------------------------------------------------------------------
const capsCache = new Map<string, Promise<boolean>>();
export function walletPaymasterSupport(owner: string): Promise<boolean> {
  const key = owner.toLowerCase();
  let p = capsCache.get(key);
  if (!p) {
    p = (async () => {
      const eth = (window as any).ethereum;
      if (!eth || !owner) return false;
      let caps: any = null;
      try { caps = await eth.request({ method: 'wallet_getCapabilities', params: [owner, [L4_CHAIN_HEX]] }); }
      catch { try { caps = await eth.request({ method: 'wallet_getCapabilities', params: [owner] }); } catch { return false; } }
      if (!caps || typeof caps !== 'object') return false;
      const forChain = caps[L4_CHAIN_HEX] || caps[L4_CHAIN_HEX.toUpperCase()] || caps[String(L4_CHAIN_ID)] || caps['0x0'] || {};
      return !!forChain?.paymasterService?.supported;
    })();
    capsCache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// The plan: which gas pays, and what it costs
// ---------------------------------------------------------------------------
export interface GasPlan {
  owner: string;
  mode: GasMode;
  /** Why this mode, in one sentence for the user. */
  reason: string;
  eoaXMoney: bigint;
  /** xMoney this transaction (or a typical one) needs: value + gas at a 25% fee margin. */
  needXMoney: bigint;
  gasCostXMoney: bigint;
  status: PaymasterStatus;
  xgasDev: XgasDevPosition | null;
  smartAccount: Address | null;
  smartAccountXMoney: bigint;
  walletPaymaster: boolean;
  /** Estimated XGAS.DEV charge for this gas at the buffered price (the real charge is on gas actually used). */
  xgasDevEstimate: bigint | null;
  needsApproval: boolean;
  /** Needs Robinhood ETH for the one-time approve (the /robinhood drip gives it). */
  needsDrip: boolean;
}

/** XGAS.DEV (wei) for `xMoneyWei` of gas at the status price, buffer included. */
export function xgasDevForGas(xMoneyWei: bigint, st: PaymasterStatus): bigint | null {
  if (!st.xgasDevPerXMoney) return null;
  const ratioE6 = BigInt(Math.round(st.xgasDevPerXMoney * 1e6));
  const buffer = st.bufferIncluded ? 10_000n : BigInt(10_000 + st.bufferBps);
  return (xMoneyWei * ratioE6 * buffer) / 10_000n / 1_000_000n;
}

async function l4Fees(): Promise<bigint> {
  try {
    const f = await l4PublicClient.estimateFeesPerGas();
    return f.maxFeePerGas ?? (await l4PublicClient.getGasPrice());
  } catch {
    return l4PublicClient.getGasPrice().catch(() => 100_000_000n);
  }
}

export async function planL4Gas(owner: string, call?: { to: string; data: string; valueWei?: bigint }): Promise<GasPlan> {
  const value = call?.valueWei ?? 0n;
  const [eoaRead, maxFee, status] = await Promise.all([
    l4PublicClient.getBalance({ address: owner as Address }).catch(() => null),
    l4Fees(),
    fetchPaymasterStatus(owner),
  ]);
  const eoaXMoney = eoaRead ?? 0n;
  let gas = TYPICAL_GAS;
  if (call) {
    try {
      gas = await l4PublicClient.estimateGas({ account: owner as Address, to: call.to as Address, data: call.data as Hex, value });
    } catch {}
  }
  const gasCostXMoney = (gas * maxFee * 125n) / 100n;
  const needXMoney = value + gasCostXMoney;
  // A UserOperation carries more gas than the bare call (account deploy on first use, validation, postOp).
  const aaGasCost = ((gas + 350_000n) * maxFee * 125n) / 100n;
  const xgasDevEstimate = xgasDevForGas(aaGasCost, status);

  // The xGas account address is read even when xMoney pays, so orders it made still show as the user's.
  const smartAccount = status.factory ? await xgasAccountAddress(owner, status.factory) : null;
  const smartAccountXMoney = smartAccount ? await l4PublicClient.getBalance({ address: smartAccount }).catch(() => 0n) : 0n;

  // xMoney pays: nothing on Robinhood is read. A balance that could not be read also sends normally, so an RPC
  // hiccup never blocks a wallet that has gas: the wallet itself then says whether it can pay.
  if (eoaRead == null || eoaXMoney >= needXMoney) {
    return {
      owner, eoaXMoney, needXMoney, gasCostXMoney, status, xgasDev: null, smartAccount, smartAccountXMoney,
      walletPaymaster: false, xgasDevEstimate, mode: 'xmoney', needsApproval: false, needsDrip: false,
      reason: eoaRead == null
        ? 'Could not read your L4 balance just now; sending normally, paid in xMoney.'
        : `Your wallet has ${fmt(eoaXMoney)} xMoney on the L4, enough for this gas.`,
    };
  }

  const [xgasDev, caps] = await Promise.all([
    status.live ? readXgasDevPosition(owner, status.spender) : Promise.resolve(null),
    status.live ? walletPaymasterSupport(owner).catch(() => false) : Promise.resolve(false),
  ]);
  const base = {
    owner, eoaXMoney, needXMoney, gasCostXMoney, status, xgasDev, smartAccount, smartAccountXMoney,
    walletPaymaster: caps, xgasDevEstimate,
  };

  if (!status.live) {
    return { ...base, mode: 'none', reason: `Your wallet has ${fmt(eoaXMoney)} xMoney on the L4, not enough for this. ${status.reason || ''}`.trim(), needsApproval: false, needsDrip: false };
  }
  if (status.payer?.blocked) {
    return { ...base, mode: 'none', reason: status.payer.reason || 'XGAS.DEV gas is paused for this address until its unpaid gas is settled.', needsApproval: false, needsDrip: false };
  }
  const hasXgas = !!xgasDev && xgasDev.balance > 0n && (xgasDevEstimate == null || xgasDev.balance >= xgasDevEstimate);
  if (!hasXgas) {
    return {
      ...base, mode: 'none', needsApproval: false, needsDrip: false,
      reason: `No xMoney on the L4 (${fmt(eoaXMoney)}) and ${xgasDev && xgasDev.balance > 0n ? 'not enough' : 'no'} XGAS.DEV on Robinhood. Bridge USDG into xMoney, or hold XGAS.DEV and pay gas with it.`,
    };
  }
  const want = approvalTarget(status, xgasDevEstimate);
  const needsApproval = !!status.spender && xgasDev!.allowance < (xgasDevEstimate ?? want);
  const needsDrip = needsApproval && xgasDev!.robinhoodEth < xgasDev!.approveCost;

  // 5792 keeps the user's own address, so value must come from the wallet itself.
  if (caps && value <= eoaXMoney) {
    return { ...base, mode: 'wallet-paymaster', reason: 'Your wallet supports paymasters: gas is paid in XGAS.DEV and the transaction still comes from your own address.', needsApproval, needsDrip };
  }
  if (smartAccount && value <= smartAccountXMoney) {
    return { ...base, mode: 'smart-account', reason: `Gas is paid in XGAS.DEV through your xGas account ${short(smartAccount)}, owned by your wallet. It acts on the L4 as that address.`, needsApproval, needsDrip };
  }
  if (smartAccount && value > 0n) {
    return {
      ...base, mode: 'none', needsApproval, needsDrip,
      reason: `This sends ${fmt(value)} xMoney. XGAS.DEV pays the gas, not the amount: your wallet has ${fmt(eoaXMoney)} and your xGas account ${short(smartAccount)} has ${fmt(smartAccountXMoney)}.`,
    };
  }
  return { ...base, mode: 'none', needsApproval, needsDrip, reason: 'The xGas account factory is not deployed on the L4 yet, so XGAS.DEV cannot pay gas from this wallet.' };
}

function approvalTarget(st: PaymasterStatus, estimate: bigint | null): bigint {
  if (st.suggestedAllowance && st.suggestedAllowance > 0n) return st.suggestedAllowance;
  if (estimate && estimate > 0n) return estimate * 50n;
  return 1000n * 10n ** 18n;
}

// ---------------------------------------------------------------------------
// One-time setup on Robinhood: approve XGAS.DEV to the relayer, or get ETH for that approve
// ---------------------------------------------------------------------------
/** Approve the gas relayer to take XGAS.DEV for gas (bounded, never unlimited). Returns the Robinhood tx hash. */
export async function approveXgasDevForGas(owner: string, amount?: bigint): Promise<{ txHash: string; amount: bigint }> {
  const st = await fetchPaymasterStatus(owner, true);
  if (!st.spender) throw new Error('The gas service did not say which Robinhood address to approve.');
  const pos = await readXgasDevPosition(owner, st.spender);
  let amt = amount ?? approvalTarget(st, null);
  if (amt > pos.balance) amt = pos.balance;
  if (amt <= 0n) throw new Error('You hold no XGAS.DEV on Robinhood Chain.');
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [st.spender, amt] });
  const { txHash } = await sendOnChainTx({ to: XGAS_DEV, data, from: owner, chainId: L3_CHAIN_ID, waitForConfirmation: true });
  statusCache.clear();
  void refreshGas(owner, true);
  return { txHash, amount: amt };
}

/** The one-time Robinhood ETH drip from /robinhood (signed in with X), so a wallet with no ETH can approve. */
export async function requestRobinhoodDrip(owner: string): Promise<{ txHash?: string; message: string }> {
  const res = await fetch('/api/robinhood/gas/drip', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: owner }),
  });
  const j = await res.json().catch(() => ({} as any));
  if (res.status === 401) throw new Error(j.error || 'The Robinhood gas drip needs Sign in with X first.');
  if (!res.ok) throw new Error(j.error || `The drip failed (${res.status}).`);
  if (j.uncertain) return { txHash: j.txHash, message: j.message || 'The drip was sent but not confirmed yet. Do not ask again; check the transaction.' };
  const amt = j.amountWei ? `${fmt(BigInt(j.amountWei), 6)} ETH` : 'A little ETH';
  setTimeout(() => { void refreshGas(owner, true); }, 6000);
  return { txHash: j.txHash, message: `${amt} is on its way to ${short(owner)} on Robinhood Chain for the one-time approval.` };
}

// ---------------------------------------------------------------------------
// Confirmation before an XGAS.DEV-paid send (the panel renders a modal; window.confirm otherwise)
// ---------------------------------------------------------------------------
export interface GasConfirmRequest {
  mode: GasMode;
  sender: string;
  owner: string;
  /** Upper bound the paymaster signed (or our buffered estimate when the host did not return one). */
  maxCharge: bigint | null;
  estimate: bigint | null;
  approval: bigint | null;
  gasCostXMoney: bigint;
  note: string | null;
}
type ConfirmHandler = (req: GasConfirmRequest) => Promise<boolean>;
const confirmHandlers: ConfirmHandler[] = [];
export function registerGasConfirm(fn: ConfirmHandler): () => void {
  confirmHandlers.push(fn);
  return () => { const i = confirmHandlers.lastIndexOf(fn); if (i >= 0) confirmHandlers.splice(i, 1); };
}
export function describeGasConfirm(r: GasConfirmRequest): string[] {
  const lines: string[] = [];
  lines.push(r.mode === 'smart-account'
    ? `Sent from your xGas account ${short(r.sender)}, owned by your wallet ${short(r.owner)}.`
    : `Sent from your own address ${short(r.sender)}.`);
  if (r.approval) lines.push(`First, a one-time approval on Robinhood Chain: the xGas gas relayer may take up to ${fmt(r.approval, 2)} XGAS.DEV for gas.`);
  if (r.maxCharge != null) lines.push(`Gas is paid in XGAS.DEV: at most ${fmt(r.maxCharge, 4)} XGAS.DEV${r.estimate != null && r.estimate < r.maxCharge ? `, about ${fmt(r.estimate, 4)} expected` : ''}. You are charged for the gas actually used, in proportion to that cap.`);
  else if (r.estimate != null) lines.push(`Gas is paid in XGAS.DEV: about ${fmt(r.estimate, 4)} XGAS.DEV at the live pool price plus the buffer. The paymaster signs the exact cap when your wallet asks for it, and you pay for the gas actually used.`);
  else lines.push('Gas is paid in XGAS.DEV at the live pool price, for the gas actually used.');
  lines.push('XGAS.DEV spent on gas is burned (sent to 0x...dEaD). A transaction that reverts still pays its gas.');
  if (r.note) lines.push(r.note);
  return lines;
}
async function confirmGas(req: GasConfirmRequest): Promise<boolean> {
  const h = confirmHandlers[confirmHandlers.length - 1];
  if (h) return h(req);
  return window.confirm(describeGasConfirm(req).join('\n\n') + '\n\nContinue?');
}

// ---------------------------------------------------------------------------
// Shared store: the current plan per owner and the last XGAS.DEV-paid send
// ---------------------------------------------------------------------------
export interface LastGasUse { mode: GasMode; txHash: string; sender: string; maxCharge: bigint | null; userOpHash?: string; at: number }
interface GasSnapshot { owner: string; plan: GasPlan | null; loading: boolean; error: string | null; last: LastGasUse | null }
let snapshot: GasSnapshot = { owner: '', plan: null, loading: false, error: null, last: null };
const listeners = new Set<() => void>();
function setSnap(patch: Partial<GasSnapshot>) { snapshot = { ...snapshot, ...patch }; listeners.forEach(l => l()); }
const inflight = new Map<string, Promise<void>>();
let lastRefreshAt = 0;

export function refreshGas(owner: string, force = false): Promise<void> {
  if (!owner) { setSnap({ owner: '', plan: null, loading: false, error: null }); return Promise.resolve(); }
  const key = owner.toLowerCase();
  const running = inflight.get(key);
  if (running) return running;
  if (!force && snapshot.owner.toLowerCase() === key && snapshot.plan && Date.now() - lastRefreshAt < 10_000) return Promise.resolve();
  if (snapshot.owner.toLowerCase() !== key) setSnap({ owner, plan: null, last: null });
  setSnap({ loading: true });
  const p = (async () => {
    try {
      if (force) statusCache.delete(key);
      const plan = await planL4Gas(owner);
      if (snapshot.owner.toLowerCase() === key) setSnap({ plan, error: null });
    } catch (e: any) {
      setSnap({ error: e?.message || 'Could not work out the L4 gas.' });
    } finally {
      lastRefreshAt = Date.now();
      inflight.delete(key);
      setSnap({ loading: false });
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Live gas plan for `owner` (empty string when no wallet). Refreshes every 30 s while mounted. */
export function useL4Gas(owner: string): GasSnapshot & { refresh: () => Promise<void> } {
  const snap = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => snapshot,
  );
  useEffect(() => {
    void refreshGas(owner);
    if (!owner) return;
    const t = setInterval(() => { void refreshGas(owner); }, 30_000);
    return () => clearInterval(t);
  }, [owner]);
  const mine = snap.owner.toLowerCase() === owner.toLowerCase();
  return {
    ...(mine ? snap : { owner, plan: null, loading: true, error: null, last: null }),
    refresh: () => refreshGas(owner, true),
  };
}

/** True when `addr` is the wallet or the xGas account it owns (orders made through XGAS.DEV gas belong to the account). */
export function isOwnAddress(addr: string, owner: string, plan: GasPlan | null): boolean {
  if (!addr || !owner) return false;
  const a = addr.toLowerCase();
  return a === owner.toLowerCase() || (!!plan?.smartAccount && a === plan.smartAccount.toLowerCase());
}

// ---------------------------------------------------------------------------
// sendL4Tx: drop-in for sendOnChainTx on the L4
// ---------------------------------------------------------------------------
export interface SendL4Params {
  to: string;
  data: string;
  valueWei?: bigint;
  valueEth?: string;
  from?: string;
  waitForConfirmation?: boolean;
  /** Ignored unless it is not the L4: anything else goes straight to sendOnChainTx. */
  chainId?: number;
}
export interface SendL4Result { txHash: string; status: 'CONFIRMED' | 'SUBMITTED'; mode: GasMode; sender: string; maxCharge?: bigint | null }

export async function sendL4Tx(params: SendL4Params): Promise<SendL4Result> {
  if (params.chainId != null && params.chainId !== L4_CHAIN_ID) {
    const r = await sendOnChainTx(params);
    return { ...r, mode: 'xmoney', sender: params.from || '' };
  }
  const eth = ethereum();
  const owner: string = params.from || (await eth.request({ method: 'eth_requestAccounts' }))[0];
  if (!owner) throw new Error('No active account selected.');
  const value = params.valueWei ?? (params.valueEth && Number(params.valueEth) > 0 ? parseEther(params.valueEth) : 0n);

  const plan = await planL4Gas(owner, { to: params.to, data: params.data, valueWei: value });
  if (snapshot.owner.toLowerCase() === owner.toLowerCase()) setSnap({ plan });

  if (plan.mode === 'xmoney') {
    const r = await sendOnChainTx({ ...params, from: owner, valueWei: value, chainId: L4_CHAIN_ID });
    void refreshGas(owner, true);
    return { ...r, mode: 'xmoney', sender: owner };
  }
  if (plan.mode === 'none') throw new GasNeededError(plan.reason, plan);
  if (plan.needsApproval && plan.needsDrip) {
    throw new GasNeededError(
      'Paying gas in XGAS.DEV needs a one-time approval on Robinhood Chain, and this wallet has no Robinhood ETH for it. Use "Get Robinhood gas" in the gas panel (one-time drip, needs Sign in with X), then try again.',
      plan,
    );
  }

  const res = plan.mode === 'wallet-paymaster'
    ? await sendViaWalletPaymaster(owner, params, value, plan)
    : await sendViaSmartAccount(owner as Address, params, value, plan);
  setSnap({ last: { mode: plan.mode, txHash: res.txHash, sender: res.sender, maxCharge: res.maxCharge ?? null, userOpHash: res.userOpHash, at: Date.now() } });
  void refreshGas(owner, true);
  return res;
}

async function ensureApproval(owner: string, plan: GasPlan, need: bigint | null): Promise<void> {
  if (!plan.status.spender || !plan.xgasDev) return;
  const want = need ?? plan.xgasDevEstimate ?? 0n;
  if (plan.xgasDev.allowance >= want && want > 0n) return;
  const target = approvalTarget(plan.status, plan.xgasDevEstimate);
  await approveXgasDevForGas(owner, target > want ? target : want);
}

// --- mode 2: EIP-5792 wallet_sendCalls with paymasterService --------------------------------------------
async function sendViaWalletPaymaster(owner: string, params: SendL4Params, value: bigint, plan: GasPlan): Promise<SendL4Result & { userOpHash?: string }> {
  const approval = plan.needsApproval ? approvalTarget(plan.status, plan.xgasDevEstimate) : null;
  const ok = await confirmGas({
    mode: 'wallet-paymaster', sender: owner, owner, maxCharge: null, estimate: plan.xgasDevEstimate,
    approval, gasCostXMoney: plan.gasCostXMoney, note: 'Your wallet will show the sponsored transaction next.',
  });
  if (!ok) throw new Error('Cancelled.');
  if (plan.needsApproval) await ensureApproval(owner, plan, plan.xgasDevEstimate);

  const eth = ethereum();
  await ensureChain(L4_CHAIN_ID);
  const url = `${window.location.origin}${PAYMASTER_PATH}`;
  const calls = [{ to: params.to, data: params.data, value: toHex(value) }];
  const capabilities = { paymasterService: { url, context: { robinhoodPayer: owner, mode: 'eip5792' } } };
  let id: string;
  try {
    const r = await eth.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: L4_CHAIN_HEX, from: owner, atomicRequired: false, calls, capabilities }] });
    id = typeof r === 'string' ? r : r?.id;
  } catch (e: any) {
    if (e?.code === 4001) throw e;
    // Wallets on the first 5792 draft only take version 1.0.
    const r = await eth.request({ method: 'wallet_sendCalls', params: [{ version: '1.0', chainId: L4_CHAIN_HEX, from: owner, calls, capabilities }] });
    id = typeof r === 'string' ? r : r?.id;
  }
  if (!id) throw new Error('The wallet did not return a call id.');
  if (!params.waitForConfirmation) return { txHash: id, status: 'SUBMITTED', mode: 'wallet-paymaster', sender: owner, maxCharge: plan.xgasDevEstimate };

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let s: any;
    try { s = await eth.request({ method: 'wallet_getCallsStatus', params: [id] }); } catch { continue; }
    const code = typeof s?.status === 'number' ? s.status : s?.status === 'CONFIRMED' ? 200 : s?.status === 'PENDING' ? 100 : 0;
    if (code === 100 || code === 0) continue;
    const receipt = s?.receipts?.[0];
    const txHash: string = receipt?.transactionHash || id;
    const okStatus = receipt?.status == null || receipt.status === '0x1' || receipt.status === 1 || receipt.status === 'success';
    if (code === 200 && okStatus) return { txHash, status: 'CONFIRMED', mode: 'wallet-paymaster', sender: owner, maxCharge: plan.xgasDevEstimate };
    throw new TxError(`The sponsored transaction failed on chain (${txHash}). Its gas was still charged in XGAS.DEV.`, txHash, 'reverted');
  }
  throw new TxError(`The wallet sent the calls (${id}) but did not report a result in 3 minutes. Check the explorer before you try again.`, id, 'unconfirmed');
}

// --- mode 3: ERC-4337 UserOperation from the xGas SimpleAccount --------------------------------------------
async function sendViaSmartAccount(owner: Address, params: SendL4Params, value: bigint, plan: GasPlan): Promise<SendL4Result & { userOpHash?: string }> {
  const st = plan.status;
  const account = await toXgasSimpleAccount(owner, st);
  const quote: { maxCharge: bigint | null; estimate: bigint | null } = { maxCharge: null, estimate: null };
  const pm = createPaymasterClient({ transport: http(`${window.location.origin}${PAYMASTER_PATH}`, { retryCount: 0 }) });
  const keep = (r: any) => {
    quote.maxCharge = maxChargeFromPaymasterData(r?.paymasterData)
      ?? pickWei(r?.xgas?.maxXgasDevCharge, r?.maxXgasDevCharge) ?? quote.maxCharge;
    const out: any = {};
    for (const k of ['paymaster', 'paymasterData', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit', 'isFinal', 'paymasterAndData']) {
      if (r?.[k] !== undefined) out[k] = r[k];
    }
    return out;
  };
  const bundler = createBundlerClient({
    client: l4PublicClient,
    chain: xgasOrbitChain,
    transport: http(st.bundlerUrl),
    pollingInterval: 1500,
    paymaster: {
      getPaymasterStubData: async (p: any) => keep(await pm.getPaymasterStubData(p)),
      getPaymasterData: async (p: any) => keep(await pm.getPaymasterData(p)),
    } as any,
    paymasterContext: { robinhoodPayer: owner, owner, mode: 'smart-account' },
    userOperation: {
      // Alto publishes the price it will accept; fall back to the L4's own estimate with the usual 2x room.
      async estimateFeesPerGas({ bundlerClient }: any) {
        try {
          const g: any = await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice', params: [] });
          const pick = g?.fast || g?.standard;
          if (pick?.maxFeePerGas) return { maxFeePerGas: BigInt(pick.maxFeePerGas), maxPriorityFeePerGas: BigInt(pick.maxPriorityFeePerGas) };
        } catch {}
        const f = await l4PublicClient.estimateFeesPerGas();
        return { maxFeePerGas: f.maxFeePerGas * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas * 2n };
      },
    },
  });

  if (plan.needsApproval) {
    // The paymaster refuses to sign until the allowance is there, so approval comes before the quote.
    const ok = await confirmGas({
      mode: 'smart-account', sender: account.address, owner, maxCharge: null, estimate: plan.xgasDevEstimate,
      approval: approvalTarget(st, plan.xgasDevEstimate), gasCostXMoney: plan.gasCostXMoney,
      note: 'After the approval you confirm the exact charge, then your wallet signs one message. It sends no transaction on the L4 itself.',
    });
    if (!ok) throw new Error('Cancelled.');
    await ensureApproval(owner, plan, plan.xgasDevEstimate);
  }

  let op: any;
  try {
    op = await bundler.prepareUserOperation({ account, calls: [{ to: params.to as Address, data: params.data as Hex, value }] });
  } catch (e: any) {
    throw new Error(explainAaError(e, account.address, owner));
  }
  // The paymaster signs who pays: it must be this wallet, or the op would charge someone else's XGAS.DEV.
  const signedFor = decodePaymasterData(op.paymasterData);
  if (signedFor && signedFor.payer.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`The paymaster quoted this operation for ${short(signedFor.payer)}, not your wallet ${short(owner)}. Nothing was signed.`);
  }
  const big = (v: unknown): bigint => (v == null ? 0n : BigInt(v as any));
  const gasTotal: bigint = big(op.callGasLimit) + big(op.verificationGasLimit) + big(op.preVerificationGas)
    + big(op.paymasterVerificationGasLimit) + big(op.paymasterPostOpGasLimit);
  const maxGasXMoney: bigint = gasTotal * big(op.maxFeePerGas);
  const maxCharge = quote.maxCharge ?? xgasDevForGas(maxGasXMoney, st);

  const ok = await confirmGas({
    mode: 'smart-account', sender: account.address, owner, maxCharge, estimate: quote.estimate,
    approval: null, gasCostXMoney: maxGasXMoney,
    note: `Your wallet now signs a message (the operation hash). Max gas ${fmt(maxGasXMoney, 6)} xMoney equivalent.`,
  });
  if (!ok) throw new Error('Cancelled.');

  const signature = await account.signUserOperation({ ...op, chainId: L4_CHAIN_ID });
  let userOpHash: Hex;
  try {
    userOpHash = await bundler.sendUserOperation({ ...op, account: undefined, sender: account.address, signature, entryPointAddress: st.entryPoint } as any);
  } catch (e: any) {
    throw new Error(explainAaError(e, account.address, owner));
  }
  if (!params.waitForConfirmation) return { txHash: userOpHash, status: 'SUBMITTED', mode: 'smart-account', sender: account.address, maxCharge, userOpHash };

  let receipt: any;
  try {
    receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  } catch (e: any) {
    throw new TxError(`UserOperation ${userOpHash} was sent, but the bundler did not report it mined (${e?.shortMessage || e?.message || 'timeout'}). It may still land.`, userOpHash, 'unconfirmed');
  }
  const txHash: string = receipt?.receipt?.transactionHash || userOpHash;
  if (!receipt?.success) {
    throw new TxError(`The operation reverted on chain (${txHash}). Nothing changed except its gas, which is still charged in XGAS.DEV.`, txHash, 'reverted');
  }
  return { txHash, status: 'CONFIRMED', mode: 'smart-account', sender: account.address, maxCharge, userOpHash };
}

/**
 * The charge cap the paymaster signed, read from paymasterData (server/paymaster/spec.md):
 * abi.encodePacked(uint48 validUntil, uint48 validAfter, uint256 maxXgasDevCharge, address robinhoodPayer, bytes65 sig),
 * 129 bytes. The earlier uint128 draft (113 bytes) is read too.
 */
export function decodePaymasterData(data: unknown): { maxCharge: bigint; payer: Address } | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return null;
  const hex = data.slice(2);
  const at = (from: number, to: number) => hex.slice(from * 2, to * 2);
  try {
    if (hex.length === 129 * 2) return { maxCharge: BigInt(`0x${at(12, 44)}`), payer: `0x${at(44, 64)}` as Address };
    if (hex.length === 113 * 2) return { maxCharge: BigInt(`0x${at(12, 28)}`), payer: `0x${at(28, 48)}` as Address };
  } catch {}
  return null;
}
export function maxChargeFromPaymasterData(data: unknown): bigint | null {
  return decodePaymasterData(data)?.maxCharge ?? null;
}

function explainAaError(e: any, sender: string, owner: string): string {
  const msg: string = e?.details || e?.shortMessage || e?.message || 'The XGAS.DEV gas request failed.';
  if (/revert|execution reverted|AA2\d|AA1\d|UserOperation reverted|simulat/i.test(msg) && sender.toLowerCase() !== owner.toLowerCase()) {
    return `${msg}\n\nThis runs from your xGas account ${short(sender)}, not your wallet ${short(owner)}. Orders, trades and tokens held by your wallet itself need xMoney gas in the wallet.`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function fmt(wei: bigint, digits = 4): string {
  const n = Number(formatEther(wei));
  if (n > 0 && n < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
export function short(a: string): string { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : ''; }
