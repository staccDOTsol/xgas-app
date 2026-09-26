// In-memory stand-ins for the two viem public clients the paymaster uses. Only what the code calls.
import { getAddress, keccak256 } from 'viem';

export const SLOT0_WORD = '0x0000000000000000000280980000000000000e36106605b5c75d0d9d08cdaaf7'; // live read, 26 Sep 2026
export const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const DEBIT_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
export const PAYMASTER = '0x1111111111111111111111111111111111111111';
export const FACTORY = '0x2222222222222222222222222222222222222222';
export const PAYER = '0x3333333333333333333333333333333333333333';
export const SENDER = '0x4444444444444444444444444444444444444444';

const lc = (a) => String(a).toLowerCase();

export function fakeRobinhood({ balances = {}, allowances = {}, slot0 = SLOT0_WORD, nav = 1000255901452423761n } = {}) {
  const st = {
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [lc(k), v])),
    allowances: Object.fromEntries(Object.entries(allowances).map(([k, v]) => [lc(k), v])),
    slot0, nav, sent: [], receipts: new Map(), nonceLatest: 0, noncePending: 0, sendError: null, autoMine: true, calls: 0,
  };
  const c = {
    st,
    async readContract({ functionName, args }) {
      st.calls++;
      switch (functionName) {
        case 'extsload': return st.slot0;
        case 'getReserveNAV': return [st.nav, 0n, 0n];
        case 'balanceOf': return st.balances[lc(args[0])] ?? 0n;
        case 'allowance': return st.allowances[`${lc(args[0])}:${lc(args[1])}`] ?? 0n;
        default: throw new Error(`fake rh: ${functionName}`);
      }
    },
    async estimateGas() { return 60_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n }; },
    async getTransactionCount({ blockTag }) { return blockTag === 'pending' ? st.noncePending : st.nonceLatest; },
    async sendRawTransaction({ serializedTransaction }) {
      if (st.sendError) { const e = st.sendError; st.sendError = null; throw e; }
      const hash = keccak256(serializedTransaction);
      st.sent.push(hash);
      if (st.autoMine) { st.receipts.set(hash, { status: 'success', transactionHash: hash }); st.nonceLatest++; st.noncePending++; }
      return hash;
    },
    async getTransactionReceipt({ hash }) {
      const r = st.receipts.get(hash);
      if (!r) { const e = new Error(`Transaction receipt with hash "${hash}" could not be found.`); e.name = 'TransactionReceiptNotFoundError'; throw e; }
      return r;
    },
    async waitForTransactionReceipt({ hash }) { const r = st.receipts.get(hash); if (!r) throw new Error('timeout'); return r; },
  };
  return c;
}

export function fakeL4({ code = {}, owners = {}, factoryAddresses = {}, depositWei = 10n ** 18n, gasPrice = 100_000_000n } = {}) {
  const st = { code: Object.fromEntries(Object.entries(code).map(([k, v]) => [lc(k), v])), owners, factoryAddresses, depositWei, gasPrice, logs: [], uoLogs: [], head: 100n };
  return {
    st,
    async getCode({ address }) { return st.code[lc(address)]; },
    async getGasPrice() { return st.gasPrice; },
    async getBlockNumber() { return st.head; },
    async readContract({ address, functionName, args }) {
      if (functionName === 'balanceOf') return st.depositWei;
      if (functionName === 'owner') { const o = st.owners[lc(address)]; if (!o) throw new Error('revert'); return o; }
      if (functionName === 'getAddress') { const v = st.factoryAddresses[`${lc(args[0])}:${args[1]}`]; if (!v) return '0x000000000000000000000000000000000000bEEF'; return v; }
      throw new Error(`fake l4: ${functionName}`);
    },
    async getLogs({ address, event, fromBlock, toBlock }) {
      const src = event.name === 'UserOperationEvent' ? st.uoLogs : st.logs;
      return src.filter((l) => lc(l.address) === lc(address) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

export function chargedLog({ userOpHash, sender = SENDER, payer = PAYER, actualGasCost, maxXgasDevCharge, block = 10n, address = PAYMASTER, succeeded = true }) {
  return {
    address: getAddress(address), blockNumber: block, transactionHash: `0x${'ab'.repeat(32)}`, removed: false,
    args: { userOpHash, sender: getAddress(sender), robinhoodPayer: getAddress(payer), actualGasCost, actualUserOpFeePerGas: 100_000_000n, maxXgasDevCharge, succeeded },
  };
}

export const silent = { log() {}, warn() {}, error() {} };
