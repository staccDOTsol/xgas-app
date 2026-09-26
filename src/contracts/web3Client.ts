import {
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  parseEther,
  formatEther,
  parseGwei,
  toHex,
  type Abi,
} from 'viem';
import { CONTRACT_ADDRESSES, l4Addresses } from './abis';

// 1. Robinhood Chain L3 (parent / settlement: USDG vault + bridge inbox)
export const robinhoodChain = defineChain({
  id: CONTRACT_ADDRESSES.ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [CONTRACT_ADDRESSES.ROBINHOOD_RPC] },
    public: { http: [CONTRACT_ADDRESSES.ROBINHOOD_RPC] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  testnet: false,
});

/** Public RPC of the xgas Orbit L4 sequencer (used for wallet_addEthereumChain and all reads). */
export function orbitL4RpcUrl(): string {
  return CONTRACT_ADDRESSES.ORBIT_L4_RPC;
}

// 2. xgas Orbit L4 (everything settles here, in native $xMoney)
export const xgasOrbitChain = defineChain({
  id: CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID,
  name: 'xgas Orbit L4',
  nativeCurrency: { name: 'X Money Gas', symbol: 'xMoney', decimals: 18 },
  rpcUrls: {
    default: { http: [CONTRACT_ADDRESSES.ORBIT_L4_RPC] },
    public: { http: [CONTRACT_ADDRESSES.ORBIT_L4_RPC] },
  },
  testnet: false,
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(CONTRACT_ADDRESSES.ROBINHOOD_RPC),
});

export const l4PublicClient = createPublicClient({
  chain: xgasOrbitChain,
  transport: http(CONTRACT_ADDRESSES.ORBIT_L4_RPC),
});

export const L3_CHAIN_ID = CONTRACT_ADDRESSES.ROBINHOOD_CHAIN_ID;
export const L4_CHAIN_ID = CONTRACT_ADDRESSES.ORBIT_L4_CHAIN_ID;

function clientFor(chainId: number) {
  return chainId === L4_CHAIN_ID ? l4PublicClient : publicClient;
}

function addChainParams(chainId: number) {
  if (chainId === L4_CHAIN_ID) {
    return {
      chainId: `0x${L4_CHAIN_ID.toString(16)}`,
      chainName: 'xgas Orbit L4',
      nativeCurrency: { name: 'X Money Gas', symbol: 'xMoney', decimals: 18 },
      rpcUrls: [orbitL4RpcUrl()],
    };
  }
  return {
    chainId: `0x${L3_CHAIN_ID.toString(16)}`,
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [CONTRACT_ADDRESSES.ROBINHOOD_RPC],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
  };
}

// ---------------------------------------------------------------------------
// L4 discovery + bridge REST helpers (served by the sequencer host)
// ---------------------------------------------------------------------------
export interface L4Info {
  chainId: number;
  rpcPath: string;
  l3ChainId: number;
  vault: string;
  ready: boolean;
  contracts: { escrow: string; fomo: string; router: string; nguLauncher?: string | null; legacy2bp?: { nguLauncher?: string | null } | null } | null;
  bridge?: { lastScannedBlock: string | null; processedCount: number; pendingExits: number };
}

let l4InfoPromise: Promise<L4Info | null> | null = null;

/** Fetch live L4 contract addresses and cache them into `l4Addresses`. */
export async function loadL4Info(force = false): Promise<L4Info | null> {
  if (!force && l4InfoPromise) return l4InfoPromise;
  l4InfoPromise = (async () => {
    try {
      const res = await fetch('/api/l4-info');
      if (!res.ok) {
        console.error(`[l4-info] host returned ${res.status}; running on compiled-in addresses.`);
        return null;
      }
      // A host that predates this route answers with the SPA's index.html and a 200,
      // so res.ok is not enough: parsing that as JSON throws and the addresses never
      // load. That failure used to be silent. Name it instead.
      const type = res.headers.get('content-type') || '';
      if (!type.includes('application/json')) {
        console.error(
          `[l4-info] /api/l4-info answered ${res.status} with "${type}" instead of JSON. ` +
          'The server is almost certainly older than this build (the route falls through to the SPA). ' +
          'Contract addresses are NOT live — running on compiled-in defaults. Redeploy the host.'
        );
        return null;
      }
      const info = (await res.json()) as L4Info;
      if (info.contracts) {
        l4Addresses.escrow = info.contracts.escrow;
        l4Addresses.fomo = info.contracts.fomo;
        l4Addresses.router = info.contracts.router;
        l4Addresses.nguLauncher = info.contracts.nguLauncher || '';
        l4Addresses.legacyNguLauncher = info.contracts.legacy2bp?.nguLauncher || '';
        l4Addresses.ready = !!info.ready;
      }
      return info;
    } catch (e) {
      console.error('[l4-info] discovery failed; running on compiled-in addresses.', e);
      return null;
    }
  })();
  return l4InfoPromise;
}

/** Poll the L4 until the address's native balance rises above `above` (bridged deposit landed). */
export async function waitForL4Credit(address: string, above: bigint, timeoutMs = 4 * 60_000): Promise<bigint | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const bal = await l4PublicClient.getBalance({ address: address as `0x${string}` });
      if (bal > above) return bal;
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

export interface Withdrawal {
  txHash: string; caller: string; destination: string; position: string; callvalue: string; amount: string;
  arbBlockNum: string; timestamp: string; status: 'pending' | 'claimable' | 'executed'; executedTx?: string;
}

/** L4 -> L3 withdrawals initiated by this address, with confirmation status from Robinhood. */
export async function fetchWithdrawals(address: string): Promise<{ withdrawals: Withdrawal[]; confirmedSendCount: string; executorEnabled: boolean }> {
  const res = await fetch(`/api/withdrawals/${address}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'withdrawals unavailable');
  return res.json();
}

/** Ask the host to execute a confirmed withdrawal on the Robinhood Outbox (permissionless; host pays gas). */
export async function executeWithdrawal(txHash: string, position: string): Promise<{ ok: boolean; txHash?: string; alreadyExecuted?: boolean }> {
  const res = await fetch('/api/withdrawals/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash, position }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'execute failed');
  return data;
}

export async function fetchL4XMoneyBalance(address: string): Promise<number> {
  try {
    const bal = await l4PublicClient.getBalance({ address: address as `0x${string}` });
    return Number(formatEther(bal));
  } catch {
    try {
      const res = await fetch(`/api/l4-balance/${address}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return Number(data.balance || 0);
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Calldata encoding
// ---------------------------------------------------------------------------
export interface EncodedCalldataResult {
  selector: string;
  calldata: string;
  functionName: string;
  signature: string;
  argsJson: string;
  castCommand: string;
  valueWei: string;
}

export function safeJsonStringify(value: any, space: number = 2): string {
  try {
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space);
  } catch (e) {
    return String(value);
  }
}

export function encodeAbiCall(
  abi: readonly any[],
  functionName: string,
  args: any[] = [],
  contractAddress: string = l4Addresses.escrow,
  valueEth: string = '0',
  chainId: number = L4_CHAIN_ID
): EncodedCalldataResult {
  try {
    const calldata = encodeFunctionData({ abi: abi as Abi, functionName, args });
    const selector = calldata.slice(0, 10);
    const valueWei = valueEth && Number(valueEth) > 0 ? parseEther(valueEth).toString() : '0';

    const fnDef = abi.find(item => item.type === 'function' && item.name === functionName);
    const paramTypes = fnDef?.inputs?.map((i: any) => i.type).join(',') || '';
    const signature = `${functionName}(${paramTypes})`;

    const castArgs = args.map(a => Array.isArray(a) ? `"[${a.join(',')}]"` : String(a)).join(' ');
    const valueFlag = Number(valueEth) > 0 ? ` --value ${valueEth}ether` : '';
    const isPayableOrWrite = fnDef?.stateMutability !== 'view' && fnDef?.stateMutability !== 'pure';
    const castVerb = isPayableOrWrite ? 'send' : 'call';
    const authFlag = isPayableOrWrite ? ' --private-key $PRIVATE_KEY' : '';
    const rpc = chainId === L4_CHAIN_ID ? orbitL4RpcUrl() : CONTRACT_ADDRESSES.ROBINHOOD_RPC;

    const castCommand = `cast ${castVerb} ${contractAddress} "${signature}" ${castArgs}${valueFlag} --rpc-url ${rpc}${authFlag}`;

    return { selector, calldata, functionName, signature, argsJson: safeJsonStringify(args, 2), castCommand, valueWei };
  } catch (err: any) {
    console.warn('Encoding calldata warning:', err);
    return {
      selector: '0x00000000',
      calldata: '0x',
      functionName,
      signature: `${functionName}()`,
      argsJson: safeJsonStringify(args, 2),
      castCommand: `# Error encoding: ${err?.message || 'unknown'}`,
      valueWei: '0',
    };
  }
}

// ---------------------------------------------------------------------------
// Wallet / network
// ---------------------------------------------------------------------------
export async function getWalletChainId(): Promise<number | null> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) return null;
  try {
    const hex = await ethereum.request({ method: 'eth_chainId' });
    return parseInt(hex, 16);
  } catch {
    return null;
  }
}

/**
 * Make sure the injected wallet is on `targetChainId` (EIP-3326 switch, EIP-3085 add fallback).
 * Throws if the user rejects.
 */
export async function ensureChain(targetChainId: number): Promise<void> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) throw new Error('No EVM wallet detected (MetaMask/Rabby).');
  const current = await getWalletChainId();
  if (current === targetChainId) return;
  const targetHex = `0x${targetChainId.toString(16)}`;
  try {
    await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] });
  } catch (switchError: any) {
    // 4902: unknown chain -> add it. Some wallets return -32603 with a nested 4902.
    const code = switchError?.code ?? switchError?.data?.originalError?.code;
    if (code === 4902 || code === -32603 || /unrecognized|not added|Unrecognized chain/i.test(switchError?.message || '')) {
      await ethereum.request({ method: 'wallet_addEthereumChain', params: [addChainParams(targetChainId)] });
    } else {
      throw switchError;
    }
  }
  const after = await getWalletChainId();
  if (after !== targetChainId) {
    throw new Error(`Wallet is on chain #${after}; please switch to #${targetChainId}`);
  }
}

/** Switch (or add) a network. Defaults to the xgas Orbit L4. */
export async function switchNetwork(targetChainId: number = L4_CHAIN_ID): Promise<boolean> {
  try {
    await ensureChain(targetChainId);
    return true;
  } catch (e) {
    console.warn('switchNetwork failed:', e);
    return false;
  }
}

/** 1-click add the xgas Orbit L4 network (native $xMoney) to Rabby / MetaMask. */
export async function addOrbitL4ToWallet(): Promise<boolean> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) return false;
  try {
    await ethereum.request({ method: 'wallet_addEthereumChain', params: [addChainParams(L4_CHAIN_ID)] });
    return true;
  } catch {
    return false;
  }
}

/** 1-click import the L3 $xMoney claim token (the ERC20 minted by the vault on Robinhood Chain). */
export async function addXMoneyTokenToWallet(): Promise<boolean> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) return false;
  try {
    await ensureChain(L3_CHAIN_ID);
    return await ethereum.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: { address: CONTRACT_ADDRESSES.XMONEY_USD_L3, symbol: 'xMoney', decimals: 18 },
      },
    });
  } catch {
    return false;
  }
}

export async function connectInjectedWallet(): Promise<{ success: boolean; address?: string; chainId?: number; error?: string }> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    return { success: false, error: 'No injected Web3 provider detected (MetaMask, Rabby, etc.)' };
  }
  try {
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const currentChainHex = await ethereum.request({ method: 'eth_chainId' });
    return { success: true, address: accounts[0], chainId: parseInt(currentChainHex, 16) };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to connect wallet' };
  }
}

/**
 * On-chain transaction broadcast on either chain:
 * - switches the wallet to `chainId` first (default: xgas Orbit L4)
 * - EIP-1559 fee estimation from that chain with a 25% buffer
 * - optional wait for the receipt on that chain
 */
export async function sendOnChainTx(params: {
  to: string;
  data: string;
  valueEth?: string;
  valueWei?: bigint;
  from?: string;
  waitForConfirmation?: boolean;
  chainId?: number;
}): Promise<{ txHash: string; status: 'CONFIRMED' | 'SUBMITTED' }> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    throw new Error('No EVM wallet detected (MetaMask/Rabby).');
  }
  const chainId = params.chainId ?? L4_CHAIN_ID;
  const client = clientFor(chainId);

  const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
  const sender = params.from || accounts[0];
  if (!sender) {
    throw new Error('No active account selected.');
  }

  const valueBig = params.valueWei != null
    ? params.valueWei
    : (params.valueEth && Number(params.valueEth) > 0 ? parseEther(params.valueEth) : 0n);
  const valueHex = valueBig > 0n ? toHex(valueBig) : '0x0';

  const txPayload: any = { from: sender, to: params.to, data: params.data, value: valueHex };

  // 0. Ensure wallet is on the right chain
  await ensureChain(chainId);

  // 1. Dynamic fee estimation with a 25% margin
  try {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas) {
      const boostedMaxFee = (fees.maxFeePerGas * 125n) / 100n;
      txPayload.maxFeePerGas = toHex(boostedMaxFee);
      const minPriority = parseGwei('0.001');
      const boostedPriority = fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > minPriority
        ? (fees.maxPriorityFeePerGas * 125n) / 100n
        : minPriority;
      txPayload.maxPriorityFeePerGas = toHex(boostedPriority);
    }
  } catch (e) {
    console.warn('Fee estimation fallback:', e);
  }

  // 2. Gas limit with a 25% buffer (estimated on the target chain so reverts surface early)
  try {
    const estimated = await client.estimateGas({
      account: sender as `0x${string}`,
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}`,
      value: valueBig,
    });
    txPayload.gas = toHex((estimated * 125n) / 100n);
  } catch (gasErr: any) {
    const msg = gasErr?.shortMessage || gasErr?.message || '';
    // Surface contract reverts instead of letting the wallet send a doomed tx
    if (/revert|execution reverted|insufficient funds/i.test(msg)) {
      throw new Error(msg);
    }
    console.warn('Gas limit fallback applied:', gasErr);
    txPayload.gas = '0x55730';
  }

  // 3. Send
  const txHash: string = await ethereum.request({ method: 'eth_sendTransaction', params: [txPayload] });

  // 4. Wait for confirmation on the same chain
  if (params.waitForConfirmation) {
    await client.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    return { txHash, status: 'CONFIRMED' };
  }
  return { txHash, status: 'SUBMITTED' };
}


// ---------------------------------------------------------------------------
// Sign in with X (session served by the app host)
// ---------------------------------------------------------------------------
export interface XUser { id: string; handle: string; name?: string; avatar?: string }

export async function fetchXSession(): Promise<{ configured: boolean; user: XUser | null }> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return { configured: false, user: null };
    return await res.json();
  } catch {
    return { configured: false, user: null };
  }
}

export function xLoginUrl(returnTo: string = typeof window !== 'undefined' ? window.location.pathname : '/'): string {
  return `/auth/x/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function xLogout(): Promise<void> {
  await fetch('/auth/x/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Connector: the same quote/prepare tools the MCP serves, at /api/connector.
// Quotes, fees and approval copy live in one place (mcp/src/tools) instead of being
// re-derived in each component.
// ---------------------------------------------------------------------------
export interface ConnectorStep {
  label: string;
  chainId: number;
  to: string;
  data: string;
  value: string; // wei, decimal string
}

export interface ConnectorApproval {
  action: string;
  asset: string;
  amount: string;
  counterparty: string | null;
  fees: { label: string; amount: string; note?: string }[];
  net: string;
  timeline: string[];
  irreversible?: string;
  notes: string[];
}

export interface ConnectorEnvelope {
  kind: 'unsigned';
  action: string;
  approval: ConnectorApproval;
  transactions: ConnectorStep[];
  next: string;
}

export interface ConnectorResult<T = any> {
  /** Plain-language summary, already written for a person to read. */
  summary: string;
  data: T;
}

export class ConnectorError extends Error {}

/** Call one connector tool. Reads and prepares only; submits are refused server-side. */
export async function callConnector<T = any>(tool: string, args: Record<string, unknown> = {}): Promise<ConnectorResult<T>> {
  const res = await fetch(`/api/connector/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ConnectorError(body.error || `${tool} failed (${res.status})`);
  return body as ConnectorResult<T>;
}

/** True when a prepare returned a refusal (insufficient balance, sold out, inactive order) rather than transactions. */
export function isEnvelope(data: any): data is ConnectorEnvelope {
  return !!data && data.kind === 'unsigned' && Array.isArray(data.transactions);
}

/**
 * Send a prepared envelope through the user's wallet, one step at a time, waiting for
 * each to confirm before the next (an approve that has not landed makes the call after
 * it revert). Nothing here signs: `sendOnChainTx` hands each step to the wallet.
 */
export async function executeEnvelope(
  envelope: ConnectorEnvelope,
  opts: { from?: string; onStep?: (step: ConnectorStep, index: number, total: number) => void } = {}
): Promise<{ hashes: string[] }> {
  const hashes: string[] = [];
  const total = envelope.transactions.length;
  for (let i = 0; i < total; i++) {
    const step = envelope.transactions[i];
    opts.onStep?.(step, i, total);
    const { txHash } = await sendOnChainTx({
      to: step.to,
      data: step.data,
      valueWei: BigInt(step.value),
      from: opts.from,
      chainId: step.chainId,
      waitForConfirmation: true,
    });
    hashes.push(txHash);
  }
  return { hashes };
}
