import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Gavel,
  Scale,
  ShieldCheck,
  Clock,
  Coins,
  Lock,
  LockOpen,
  Eye,
  Copy,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  FileText,
  Image as ImageIcon,
  Link2,
  Hourglass,
  Award,
  Info,
} from 'lucide-react';
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  isAddress,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  zeroAddress,
} from 'viem';
import { publicClient, sendOnChainTx, L3_CHAIN_ID, TxError } from '../contracts/web3Client';
import { OTC_ARBITRATION_ABI } from '../contracts/robinhoodArbitrationAbi';

// ---------------------------------------------------------------------------
// Arbiter desk for the Robinhood ETH <-> X Money dollars OTC (Robinhood Chain #4663).
// Reads go through getters only (openDisputeIds, disputeOf, evidenceOf, commitOf, arbiterOf, accountOf,
// canCommit, the escrow's getTrade): Robinhood RPC keeps little history, so no log scans.
// ---------------------------------------------------------------------------

// Minimal escrow ABI: just what an arbiter needs to judge a dispute.
const ESCROW_TRADE_ABI = parseAbi([
  'struct Trade { uint256 orderId; address seller; address buyer; string sellerXHandle; string buyerXHandle; uint256 ethAmount; uint256 expectedCents; uint64 openedAt; uint64 paidAt; uint8 status; string paymentNote; }',
  'function getTrade(uint256 tradeId) view returns (Trade)',
  'function flagged(address) view returns (bool)',
]);

// Interface constants, used only until the chain answers.
const FALLBACK = {
  minStake: parseEther('0.01'),
  stakeAge: 3n * 24n * 3600n,
  commit: 24n * 3600n,
  reveal: 24n * 3600n,
  longStop: 14n * 24n * 3600n,
  slashBps: 1000n,
  unstakeDelay: 7n * 24n * 3600n,
};
const FEE_PCT = '0.10'; // escrow fee on ETH paid to a buyer; all of it goes to the Fee Fanout, none to arbiters
const BOND_MIN_ETH = '0.002';
const BOND_PCT = 5;
const MAX_URI_BYTES = 512;
const MAX_EVIDENCE_PER_PARTY = 16;
const EVIDENCE_PATH = '/api/robinhood/evidence/';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const PENDING_COMMIT_S = 180; // a commit sent from this browser blocks another for this long, unless it shows up sooner

const VOTE_BUYER_PAID = 1 as const;
const VOTE_DID_NOT_PAY = 2 as const;
type Vote = typeof VOTE_BUYER_PAID | typeof VOTE_DID_NOT_PAY;
const OUTCOME_LABEL: Record<number, string> = { 0: 'None', 1: 'Buyer paid', 2: 'Buyer did not pay', 3: 'Long-stop: ETH and bond back to the seller' };
const ZERO_HASH = `0x${'0'.repeat(64)}` as `0x${string}`;

type Hex = `0x${string}`;

interface Cfg { minStake: bigint; stakeAge: bigint; commit: bigint; reveal: bigint; longStop: bigint; slashBps: bigint; unstakeDelay: bigint }
interface ArbiterState {
  stake: bigint; // after settling resolved votes (arbiterOf)
  unstakeAt: number;
  claimable: bigint; // after settling resolved votes (arbiterOf)
  lockedCommits: bigint; // votes on disputes that are not resolved yet
  atRisk: bigint; // reserves of unsettled votes (accountOf)
  eligibleAt: number; // last stake increase + STAKE_AGE (accountOf)
}
interface TradeView {
  orderId: bigint; seller: string; buyer: string; sellerXHandle: string; buyerXHandle: string;
  ethAmount: bigint; expectedCents: bigint; openedAt: number; paidAt: number; status: number; paymentNote: string;
}
interface DisputeView {
  id: bigint; buyer: string; seller: string; bond: bigint; openedAt: number; commitEnd: number; revealEnd: number;
  extensions: number; resolved: boolean; outcome: number; weightBuyerPaid: bigint; weightDidNotPay: bigint; revealers: number;
  evidence: { uri: string; by: string }[];
  trade: TradeView | null;
  buyerFlagged: boolean;
  mine: { commitment: Hex; weight: bigint; revealed: boolean } | null;
  canCommit: { ok: boolean; reason: string } | null;
}
/** One commit attempt from this browser. Attempts are only ever appended, never overwritten. */
interface SavedVote { vote: Vote; salt: Hex; commitment: Hex; savedAt: number; sentAt?: number; txHash?: string }

// --- helpers -----------------------------------------------------------------
const sameAddr = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const shortAddr = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

function fmtEth(wei: bigint, dp = 5): string {
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  if (n < 10 ** -dp) return `<${(10 ** -dp).toFixed(dp)}`;
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function fmtUsd(cents: bigint): string {
  const n = Number(cents) / 100;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function fmtDur(totalSeconds: number | bigint): string {
  let s = Math.max(0, Math.floor(Number(totalSeconds)));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** A contract period in words: "3 days", "24 hours". Countdowns use fmtDur. */
function fmtSpan(totalSeconds: number | bigint): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds)));
  if (s > 0 && s % 86400 === 0 && s >= 2 * 86400) return `${s / 86400} days`;
  if (s > 0 && s % 3600 === 0) return `${s / 3600} hours`;
  return fmtDur(s);
}

function fmtTime(ts: number): string {
  if (!ts) return 'not set';
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function pct(part: bigint, total: bigint): string {
  if (total === 0n) return '0%';
  return `${(Number((part * 10000n) / total) / 100).toFixed(1)}%`;
}

function commitmentFor(tradeId: bigint, vote: number, salt: Hex, arbiter: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }],
      [tradeId, vote, salt, arbiter as Hex]
    )
  );
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// --- salts saved in this browser ------------------------------------------------
// Per (arbitration contract, trade, account) this keeps every commit attempt ever made here. A new attempt with the
// same vote reuses the saved salt (same commitment), so a retry after an RPC hiccup can never leave the browser with
// a salt that does not match what landed on chain. A different vote appends a new attempt. At reveal time the attempt
// whose commitment equals commitOf() is the one used.
const saltKey = (arb: string, id: bigint, acct: string) =>
  `xgas.robinhoodArb.vote:${arb.toLowerCase()}:${id.toString()}:${acct.toLowerCase()}`;

function validAttempt(v: any): v is SavedVote {
  return !!v && (v.vote === 1 || v.vote === 2) && /^0x[0-9a-fA-F]{64}$/.test(v.salt) && /^0x[0-9a-fA-F]{64}$/.test(v.commitment);
}

function readAttempts(arb: string, id: bigint, acct: string | null): SavedVote[] {
  if (!acct) return [];
  try {
    const raw = localStorage.getItem(saltKey(arb, id, acct));
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (Array.isArray(v?.attempts)) return v.attempts.filter(validAttempt);
    if (validAttempt(v)) return [v]; // the single-entry format saved by earlier versions of this page
  } catch {}
  return [];
}

function writeAttempts(arb: string, id: bigint, acct: string, attempts: SavedVote[]): boolean {
  try {
    localStorage.setItem(saltKey(arb, id, acct), JSON.stringify({ attempts }));
    return true;
  } catch {
    return false;
  }
}

/** Append an attempt, or update the one with the same commitment. Never drops an existing attempt. */
function upsertAttempt(arb: string, id: bigint, acct: string, next: SavedVote): boolean {
  const list = readAttempts(arb, id, acct);
  const i = list.findIndex((a) => a.commitment.toLowerCase() === next.commitment.toLowerCase());
  if (i >= 0) list[i] = { ...list[i], ...next, salt: list[i].salt, vote: list[i].vote };
  else list.push(next);
  return writeAttempts(arb, id, acct, list);
}

type EvidenceKind =
  | { kind: 'image'; src: string }
  | { kind: 'textFile'; src: string }
  | { kind: 'file'; src: string }
  | { kind: 'link'; href: string }
  | { kind: 'text'; text: string };

/** Our own evidence store, by extension: images inline, .txt notes as text. Other links stay links (never hot-link third-party images). */
function classifyEvidence(uri: string): EvidenceKind {
  const u = uri.trim();
  let file: string | null = null;
  if (u.startsWith(EVIDENCE_PATH)) file = u.slice(EVIDENCE_PATH.length);
  const abs = u.match(/^https:\/\/(?:www\.)?xgas\.dev\/api\/robinhood\/evidence\/([^/?#]+)$/);
  if (abs) file = abs[1];
  const tagged = u.match(/^evidence:([^/?#]+)$/);
  if (tagged) file = tagged[1];
  if (file != null && /^[A-Za-z0-9._-]{1,200}$/.test(file)) {
    const src = EVIDENCE_PATH + file;
    if (/\.(png|jpe?g|webp)$/i.test(file)) return { kind: 'image', src };
    if (/\.txt$/i.test(file)) return { kind: 'textFile', src };
    return { kind: 'file', src };
  }
  if (/^https?:\/\/[^\s]+$/i.test(u)) return { kind: 'link', href: u };
  return { kind: 'text', text: u };
}

function errText(e: any): string {
  if (e instanceof TxError) return e.message;
  if (e?.code === 4001 || /user rejected|denied/i.test(e?.message || '')) return 'You cancelled it in your wallet. Nothing was sent.';
  return e?.shortMessage || e?.details || e?.message || String(e);
}

const isUserRejection = (e: any) => e?.code === 4001 || /user rejected|denied|rejected the request/i.test(e?.message || '');

// --- small UI pieces -------------------------------------------------------------
function Stat({ label, value, sub, tone = 'text-white' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-mono">{label}</div>
      <div className={`text-sm font-bold font-mono break-words ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function TextEvidence({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(src, { credentials: 'omit' })
      .then(async (r) => {
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !type.startsWith('text/plain')) throw new Error(String(r.status));
        const t = await r.text();
        if (alive) setText(t.length > 20_000 ? `${t.slice(0, 20_000)}\n[cut at 20,000 characters]` : t);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [src]);
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase text-slate-500 font-mono flex items-center gap-1"><FileText className="w-3 h-3" /> Text note</div>
      {text != null ? (
        <pre className="text-xs text-slate-200 whitespace-pre-wrap break-words font-mono bg-black/30 border border-[#1e2538] rounded-lg p-2 max-h-72 overflow-y-auto">{text}</pre>
      ) : failed ? (
        <a href={src} target="_blank" rel="noreferrer" className="text-cyan-300 underline break-all text-xs">Text note (could not be loaded here; open it)</a>
      ) : (
        <p className="text-xs text-slate-500">Loading the note...</p>
      )}
    </div>
  );
}

function EvidenceItem({ uri }: { uri: string }) {
  const [broken, setBroken] = useState(false);
  const ev = classifyEvidence(uri);
  if (ev.kind === 'image') {
    if (broken) {
      return (
        <a href={ev.src} target="_blank" rel="noreferrer" className="text-cyan-300 underline break-all text-xs flex items-center gap-1">
          <FileText className="w-3.5 h-3.5 shrink-0" /> Screenshot (could not be shown inline; open it)
        </a>
      );
    }
    return (
      <a href={ev.src} target="_blank" rel="noreferrer" className="block">
        <img
          src={ev.src}
          alt="Evidence uploaded by a party to this trade"
          loading="lazy"
          onError={() => setBroken(true)}
          className="max-h-72 w-auto max-w-full rounded-lg border border-[#1e2538] bg-black/30"
        />
      </a>
    );
  }
  if (ev.kind === 'textFile') return <TextEvidence src={ev.src} />;
  if (ev.kind === 'file') {
    return (
      <a href={ev.src} target="_blank" rel="noreferrer" className="text-cyan-300 underline break-all text-xs flex items-center gap-1">
        <FileText className="w-3.5 h-3.5 shrink-0" /> Evidence file
      </a>
    );
  }
  if (ev.kind === 'link') {
    return (
      <a href={ev.href} target="_blank" rel="noopener noreferrer nofollow" className="text-cyan-300 underline break-all text-xs flex items-start gap-1">
        <Link2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{ev.href}</span>
      </a>
    );
  }
  return <p className="text-xs text-slate-200 whitespace-pre-wrap break-words">{ev.text}</p>;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {});
      }}
      className="px-2 py-1 rounded-md bg-[#1b2234] hover:bg-[#232c42] text-slate-300 text-[11px] flex items-center gap-1 cursor-pointer shrink-0"
    >
      <Copy className="w-3 h-3" /> {done ? 'Copied' : label}
    </button>
  );
}

// --- main component --------------------------------------------------------------
export function RobinhoodArbiters(props: { account: string | null; otcAddress: string; arbitrationAddress: string }) {
  const { account, otcAddress, arbitrationAddress } = props;
  const deployed = !!arbitrationAddress && !!otcAddress && isAddress(arbitrationAddress) && isAddress(otcAddress);
  const arb = (arbitrationAddress || zeroAddress) as Hex;
  const otc = (otcAddress || zeroAddress) as Hex;

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [cfg, setCfg] = useState<Cfg>(FALLBACK);
  const [cfgLive, setCfgLive] = useState(false);
  const [boundEscrow, setBoundEscrow] = useState<string | null>(null);
  const [me, setMe] = useState<ArbiterState | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [disputes, setDisputes] = useState<DisputeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string; tx?: string } | null>(null);
  const [stakeInput, setStakeInput] = useState('');
  const [choice, setChoice] = useState<Record<string, Vote>>({});
  const [manualVote, setManualVote] = useState<Record<string, Vote>>({});
  const [manualSalt, setManualSalt] = useState<Record<string, string>>({});
  const [evidenceDraft, setEvidenceDraft] = useState<Record<string, string>>({});
  const [savedTick, setSavedTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Another tab saving a salt shows up here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('xgas.robinhoodArb.vote:')) setSavedTick((n) => n + 1); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Constants and the bind check: once per address.
  useEffect(() => {
    if (!deployed) return;
    let alive = true;
    (async () => {
      try {
        const rd = (functionName: string) => publicClient.readContract({ address: arb, abi: OTC_ARBITRATION_ABI, functionName: functionName as any }) as Promise<any>;
        const [minStake, stakeAge, commit, reveal, longStop, slashBps, unstakeDelay, esc] = await Promise.all([
          rd('MIN_STAKE'), rd('STAKE_AGE'), rd('COMMIT'), rd('REVEAL'), rd('LONG_STOP'), rd('SLASH_BPS'), rd('UNSTAKE_DELAY'), rd('escrow'),
        ]);
        if (!alive) return;
        setCfg({ minStake, stakeAge, commit, reveal, longStop, slashBps, unstakeDelay });
        setCfgLive(true);
        setBoundEscrow(esc as string);
      } catch (e) {
        console.warn('[arbiters] constants read failed; showing interface defaults', e);
      }
    })();
    return () => { alive = false; };
  }, [deployed, arb]);

  const refresh = useCallback(async () => {
    if (!deployed) return;
    setLoading(true);
    try {
      const rd = (functionName: string, args: any[] = []) =>
        publicClient.readContract({ address: arb, abi: OTC_ARBITRATION_ABI, functionName: functionName as any, args: args as any }) as Promise<any>;

      const [ids, arbiter, account_, bal] = await Promise.all([
        rd('openDisputeIds') as Promise<readonly bigint[]>,
        account ? rd('arbiterOf', [account]) : Promise.resolve(null),
        account ? rd('accountOf', [account]).catch(() => null) : Promise.resolve(null),
        account ? publicClient.getBalance({ address: account as Hex }) : Promise.resolve(null),
      ]);
      setBalance(bal as bigint | null);
      if (arbiter) {
        const [stake, unstakeAt, claimable, lockedCommits] = arbiter as readonly [bigint, bigint, bigint, bigint];
        const acc = account_ as readonly any[] | null;
        setMe({
          stake, unstakeAt: Number(unstakeAt), claimable, lockedCommits,
          atRisk: acc ? BigInt(acc[1]) : 0n,
          eligibleAt: acc && acc.length > 6 ? Number(acc[6]) : 0,
        });
      } else {
        setMe(null);
      }

      const list = await Promise.all(
        [...ids].map(async (id): Promise<DisputeView> => {
          const [d, ev, trade, mine, can] = await Promise.all([
            rd('disputeOf', [id]),
            rd('evidenceOf', [id]).catch(() => [[], []]),
            publicClient.readContract({ address: otc, abi: ESCROW_TRADE_ABI, functionName: 'getTrade', args: [id] }).catch(() => null),
            account ? rd('commitOf', [id, account]).catch(() => null) : Promise.resolve(null),
            account ? rd('canCommit', [id, account]).catch(() => null) : Promise.resolve(null),
          ]);
          const [buyer, seller, bond, openedAt, commitEnd, revealEnd, extensions, resolved, outcome, wPaid, wNot, revealers] =
            d as readonly [string, string, bigint, bigint, bigint, bigint, number | bigint | boolean, boolean, number, bigint, bigint, bigint];
          const [uris, by] = ev as readonly [readonly string[], readonly string[]];
          let buyerFlagged = false;
          try {
            buyerFlagged = (await publicClient.readContract({ address: otc, abi: ESCROW_TRADE_ABI, functionName: 'flagged', args: [buyer as Hex] })) as boolean;
          } catch {}
          const t = trade as any;
          return {
            id,
            buyer, seller, bond,
            openedAt: Number(openedAt), commitEnd: Number(commitEnd), revealEnd: Number(revealEnd),
            extensions: Number(extensions), resolved, outcome: Number(outcome),
            weightBuyerPaid: wPaid, weightDidNotPay: wNot, revealers: Number(revealers),
            evidence: uris.map((uri, i) => ({ uri, by: by[i] || zeroAddress })),
            trade: t
              ? {
                  orderId: t.orderId, seller: t.seller, buyer: t.buyer, sellerXHandle: t.sellerXHandle, buyerXHandle: t.buyerXHandle,
                  ethAmount: t.ethAmount, expectedCents: t.expectedCents, openedAt: Number(t.openedAt), paidAt: Number(t.paidAt),
                  status: Number(t.status), paymentNote: t.paymentNote,
                }
              : null,
            buyerFlagged,
            mine: mine ? { commitment: (mine as any)[0] as Hex, weight: (mine as any)[1] as bigint, revealed: (mine as any)[2] as boolean } : null,
            canCommit: can ? { ok: !!(can as any)[0], reason: String((can as any)[1] || '') } : null,
          };
        })
      );
      list.sort((a, b) => a.revealEnd - b.revealEnd);
      setDisputes(list);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [deployed, arb, otc, account]);

  useEffect(() => {
    if (!deployed) return;
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [deployed, refresh]);

  const send = useCallback(
    async (functionName: string, args: any[] = [], valueWei?: bigint) => {
      if (!account) throw new Error('Connect a wallet first.');
      const data = encodeFunctionData({ abi: OTC_ARBITRATION_ABI, functionName: functionName as any, args: args as any });
      return sendOnChainTx({ to: arb, data, valueWei, from: account, chainId: L3_CHAIN_ID, waitForConfirmation: true });
    },
    [account, arb]
  );

  const run = useCallback(
    async (key: string, okText: string, fn: () => Promise<{ txHash: string } | void>) => {
      setBusy(key);
      setNotice(null);
      try {
        const r = await fn();
        setNotice({ kind: 'ok', text: okText, tx: r ? r.txHash : undefined });
        await refresh();
      } catch (e) {
        setNotice({ kind: 'err', text: errText(e), tx: e instanceof TxError ? e.txHash : undefined });
        refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  // --- derived arbiter state ---
  const stake = me?.stake ?? 0n;
  const unstaking = !!me && me.unstakeAt > 0;
  const withdrawable = unstaking && now >= (me?.unstakeAt ?? 0) && (me?.lockedCommits ?? 0n) === 0n;
  const slashPct = Number(cfg.slashBps) / 100;
  const stakeAgeTxt = fmtSpan(cfg.stakeAge);
  const longStopTxt = fmtSpan(cfg.longStop);
  const reservePerVote = (stake * cfg.slashBps) / 10000n;
  const freeForVotes = stake > (me?.atRisk ?? 0n) ? stake - (me?.atRisk ?? 0n) : 0n;

  const stakeWei = useMemo(() => {
    try {
      if (!stakeInput.trim()) return null;
      const w = parseEther(stakeInput.trim());
      return w > 0n ? w : null;
    } catch {
      return null;
    }
  }, [stakeInput]);
  const stakeAfter = stake + (stakeWei ?? 0n);
  const openCommitted = disputes.filter((d) => !d.resolved && d.mine && d.mine.commitment !== ZERO_HASH).length;

  const bindProblem = useMemo(() => {
    if (!boundEscrow) return null;
    if (sameAddr(boundEscrow, zeroAddress)) return 'The arbitration contract is not bound to the desk yet, so no dispute can open. Staking works, but there is nothing to vote on until the one-time bind.';
    if (!sameAddr(boundEscrow, otcAddress)) return `This arbitration contract is bound to ${boundEscrow}, not to the desk at ${otcAddress}. Do not stake until this is fixed.`;
    return null;
  }, [boundEscrow, otcAddress]);

  // --- not deployed ---
  if (!deployed) {
    return (
      <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-5 shadow-xl space-y-2">
        <h3 className="text-base font-bold text-white flex items-center gap-2 font-display">
          <Gavel className="w-4 h-4 text-amber-400" /> Arbiters
        </h3>
        <p className="text-sm text-slate-300">Not deployed yet.</p>
        <p className="text-xs text-slate-400">
          Arbiters stake ETH on Robinhood Chain and vote on disputed trades. This panel goes live when the escrow and the arbitration contract are deployed and bound.
        </p>
      </div>
    );
  }

  const phaseOf = (d: DisputeView): { key: 'commit' | 'reveal' | 'resolve' | 'done'; label: string; endsAt: number } => {
    const round = d.extensions > 0 ? ` (round ${d.extensions + 1})` : '';
    if (d.resolved) return { key: 'done', label: `Resolved: ${OUTCOME_LABEL[d.outcome] ?? d.outcome}`, endsAt: 0 };
    if (now <= d.commitEnd) return { key: 'commit', label: `Commit phase${round}`, endsAt: d.commitEnd };
    if (now <= d.revealEnd) return { key: 'reveal', label: `Reveal phase${round}`, endsAt: d.revealEnd };
    return { key: 'resolve', label: 'Ready to resolve', endsAt: d.revealEnd };
  };

  /** Why commitVote would revert, in words. Uses the contract's own canCommit when it answered. */
  const commitBlock = (d: DisputeView): string | null => {
    const reason = d.canCommit ? (d.canCommit.ok ? '' : d.canCommit.reason) : null;
    const r = reason ?? (
      unstaking ? 'unstaking'
      : stake < cfg.minStake ? 'not staked'
      : (me?.eligibleAt ?? 0) > d.openedAt ? 'stake too new'
      : freeForVotes < reservePerVote ? 'stake reserved'
      : ''
    );
    switch (r) {
      case '': return null;
      case 'not open': return 'This dispute is not open.';
      case 'commit closed': return 'The commit window has closed.';
      case 'party': return 'You are the buyer or the seller on this trade, so you cannot vote on it.';
      case 'unstaking': return 'You requested unstake, so you cannot commit to new disputes.';
      case 'not staked': return `Stake at least ${fmtEth(cfg.minStake)} ETH to vote. New stake only counts on disputes that open ${stakeAgeTxt} or more after it.`;
      case 'stake too new': return `Your stake became eligible ${fmtTime(me?.eligibleAt ?? 0)}, after this dispute opened (${fmtTime(d.openedAt)}). Only stake that was in place ${stakeAgeTxt} before a dispute opened can vote on it, and every deposit restarts that clock.`;
      case 'committed': return 'You already committed a vote on this dispute.';
      case 'stake reserved': return `Each open vote reserves ${slashPct}% of your stake, and your open votes already reserve all you have free. Reveal them and wait for one of those disputes to resolve.`;
      default: return `The contract would refuse this commit (${r}).`;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2 font-display">
              <Gavel className="w-5 h-5 text-amber-400" /> Arbiters: settle disputed trades
            </h3>
            <p className="text-xs text-slate-400 max-w-2xl mt-1">
              A seller who says the X Money payment never arrived can dispute a trade by posting a bond. Staked arbiters look at the evidence from both sides and vote in secret (commit, then reveal). Arbiters on the majority side are paid out of that bond. Arbiters on the minority side, and anyone who commits but never reveals, lose {slashPct}% of their stake.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-[#151c2d] hover:bg-[#1b2234] text-slate-300 text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          <Stat label="Paid from" value="The seller's bond" sub="No reward pool. The fee goes to the Fee Fanout." tone="text-emerald-400" />
          <Stat label="Open disputes" value={disputes.length} />
          <Stat label="Minimum stake" value={`${fmtEth(cfg.minStake)} ETH`} sub={`Weight is your whole stake. It must be ${stakeAgeTxt} old when a dispute opens.`} />
          <Stat label="Vote windows" value={`${fmtSpan(cfg.commit)} + ${fmtSpan(cfg.reveal)}`} sub={`Repeats on a tie, up to ${longStopTxt}`} />
        </div>
        {!cfgLive && <p className="text-[11px] text-slate-500 mt-2">Showing the published constants until the contract answers.</p>}
        {bindProblem && (
          <div className="mt-3 flex items-start gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span className="break-words">{bindProblem}</span>
          </div>
        )}
        {loadError && (
          <div className="mt-3 flex items-start gap-2 text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span className="break-words">Could not read the contracts: {loadError}</span>
          </div>
        )}
        {notice && (
          <div
            className={`mt-3 flex items-start gap-2 text-xs rounded-xl p-3 border ${
              notice.kind === 'ok' ? 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30' : 'text-rose-200 bg-rose-500/10 border-rose-500/30'
            }`}
          >
            {notice.kind === 'ok' ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span className="break-words">
              {notice.text}
              {notice.tx && (
                <>
                  {' '}
                  <a href={`${EXPLORER}/tx/${notice.tx}`} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">
                    View transaction <ExternalLink className="w-3 h-3" />
                  </a>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: your stake + rules */}
        <div className="space-y-4 min-w-0">
          <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl space-y-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2 font-display">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Your arbiter stake
            </h4>
            {!account ? (
              <p className="text-xs text-slate-400">Connect a wallet to stake, vote and claim rewards. You can read every dispute without one.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Staked" value={`${fmtEth(stake)} ETH`} sub="Your vote weight when you commit" />
                  <Stat
                    label="Can vote on"
                    value={stake === 0n ? 'Nothing yet' : `Disputes opened from ${fmtTime(me?.eligibleAt ?? 0)}`}
                    sub={stake === 0n ? undefined : (me?.eligibleAt ?? 0) > now ? `That is ${fmtDur((me?.eligibleAt ?? 0) - now)} from now` : 'Not ones that opened before that'}
                  />
                  <Stat label="Claimable" value={`${fmtEth(me?.claimable ?? 0n)} ETH`} tone="text-emerald-400" />
                  <Stat
                    label="Locked votes"
                    value={(me?.lockedCommits ?? 0n).toString()}
                    sub={stake > 0n ? `${fmtEth(me?.atRisk ?? 0n)} ETH reserved, ${fmtEth(freeForVotes)} free` : 'Unrevealed or unresolved'}
                  />
                </div>

                <div className="text-xs rounded-xl p-3 bg-[#151c2d] border border-[#1e2538]">
                  {stake === 0n ? (
                    <span className="text-slate-400">Not staked. Stake at least {fmtEth(cfg.minStake)} ETH; it can vote on disputes that open {stakeAgeTxt} or more after your deposit.</span>
                  ) : unstaking ? (
                    now < (me?.unstakeAt ?? 0) ? (
                      <span className="text-amber-200 flex items-start gap-1.5">
                        <Hourglass className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        Unstaking. Withdrawable in {fmtDur((me?.unstakeAt ?? 0) - now)} ({fmtTime(me?.unstakeAt ?? 0)}). You cannot commit to new disputes.
                      </span>
                    ) : (me?.lockedCommits ?? 0n) > 0n ? (
                      <span className="text-amber-200 flex items-start gap-1.5">
                        <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        The delay has passed, but {me?.lockedCommits.toString()} vote(s) are still locked. Reveal them and wait for those disputes to resolve, then withdraw.
                      </span>
                    ) : (
                      <span className="text-emerald-300 flex items-start gap-1.5">
                        <LockOpen className="w-3.5 h-3.5 shrink-0 mt-0.5" /> Ready to withdraw.
                      </span>
                    )
                  ) : stake < cfg.minStake ? (
                    <span className="text-amber-200">Below the {fmtEth(cfg.minStake)} ETH minimum. Add {fmtEth(cfg.minStake - stake)} ETH to vote.</span>
                  ) : (me?.eligibleAt ?? 0) > now ? (
                    <span className="text-amber-200 flex items-start gap-1.5">
                      <Hourglass className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      Staked. Your stake can vote on disputes that open after {fmtTime(me?.eligibleAt ?? 0)} ({fmtDur((me?.eligibleAt ?? 0) - now)} from now), not on any open before then.
                    </span>
                  ) : freeForVotes < reservePerVote ? (
                    <span className="text-amber-200">Active, but your open votes reserve all of your free stake ({slashPct}% each). Wait for one to resolve before committing another.</span>
                  ) : (
                    <span className="text-emerald-300">Active. You can commit on disputes that opened after {fmtTime(me?.eligibleAt ?? 0)}.</span>
                  )}
                </div>

                {/* Stake more */}
                <div className="space-y-2">
                  <label className="text-[11px] uppercase tracking-wide text-slate-500 font-mono">Add stake (ETH)</label>
                  <div className="flex gap-2">
                    <input
                      value={stakeInput}
                      onChange={(e) => setStakeInput(e.target.value.replace(/[^0-9.]/g, ''))}
                      inputMode="decimal"
                      placeholder={fmtEth(cfg.minStake)}
                      disabled={unstaking}
                      className="flex-1 min-w-0 bg-[#151c2d] border border-[#1e2538] rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={!stakeWei || stakeAfter < cfg.minStake || busy !== null || unstaking || (balance != null && stakeWei > balance)}
                      onClick={() => {
                        if (!stakeWei) return;
                        if (stake > 0n && !window.confirm(`Adding stake restarts the ${stakeAgeTxt} clock for your whole stake: it will only be able to vote on disputes that open after ${fmtTime(now + Number(cfg.stakeAge))}. Votes you already committed are not affected. Add ${fmtEth(stakeWei)} ETH?`)) return;
                        run('stake', `Staked ${fmtEth(stakeWei)} ETH. It can vote on disputes that open ${stakeAgeTxt} from now or later.`, () => send('stake', [], stakeWei));
                      }}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    >
                      {busy === 'stake' ? 'Staking...' : 'Stake'}
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Wallet: {balance == null ? '...' : `${fmtEth(balance)} ETH`} on Robinhood Chain. You also pay gas.
                    {unstaking && <span className="text-amber-300"> You requested unstake, so the contract does not take more stake from this address.</span>}
                    {!unstaking && stakeWei && stakeAfter < cfg.minStake && <span className="text-amber-300"> Your total stake must reach {fmtEth(cfg.minStake)} ETH.</span>}
                    {!unstaking && stakeWei && balance != null && stakeWei > balance && <span className="text-amber-300"> That is more than your wallet holds.</span>}
                    {!unstaking && <> Every deposit restarts the {stakeAgeTxt} clock for your whole stake.</>}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row lg:flex-col gap-2">
                  {stake > 0n && !unstaking && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(`Request unstake? Your stake unlocks after ${fmtSpan(cfg.unstakeDelay)}, and you cannot commit to new disputes or add stake from now on. Votes you already committed still have to be revealed or they are slashed ${slashPct}%.`)) return;
                        run('unstake', `Unstake requested. Withdrawable after ${fmtSpan(cfg.unstakeDelay)} once no votes are locked.`, () => send('requestUnstake'));
                      }}
                      className="flex-1 py-2 rounded-lg bg-[#151c2d] border border-[#2a3350] hover:border-amber-500/50 text-slate-200 text-xs font-bold cursor-pointer disabled:opacity-40"
                    >
                      {busy === 'unstake' ? 'Requesting...' : `Request unstake (${fmtSpan(cfg.unstakeDelay)} delay)`}
                    </button>
                  )}
                  {unstaking && (
                    <button
                      type="button"
                      disabled={!withdrawable || busy !== null}
                      onClick={() => run('withdraw', `Withdrew ${fmtEth(stake)} ETH of stake.`, () => send('withdrawStake'))}
                      className="flex-1 py-2 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {busy === 'withdraw' ? 'Withdrawing...' : withdrawable ? `Withdraw ${fmtEth(stake)} ETH` : 'Withdraw (locked)'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={(me?.claimable ?? 0n) === 0n || busy !== null}
                    onClick={() => run('claim', `Claimed ${fmtEth(me?.claimable ?? 0n)} ETH.`, () => send('claimArbiterReward'))}
                    className="flex-1 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-emerald-300 text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <Award className="w-3.5 h-3.5" /> {busy === 'claim' ? 'Claiming...' : `Claim ${fmtEth(me?.claimable ?? 0n)} ETH`}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Rules, stated plainly */}
          <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl space-y-2 text-xs text-slate-300">
            <h4 className="text-sm font-bold text-white flex items-center gap-2 font-display">
              <Scale className="w-4 h-4 text-cyan-400" /> How voting pays, and how it costs
            </h4>
            <ul className="space-y-1.5 list-disc pl-4 marker:text-slate-600">
              <li>Stake at least {fmtEth(cfg.minStake)} ETH. Your vote weight is your whole stake, with no cap, taken when you commit and locked until that dispute resolves. Splitting a stake across addresses gains nothing.</li>
              <li>Your stake can vote on a dispute only if it was last increased at least {stakeAgeTxt} before the dispute opened. Every deposit restarts that clock for your whole stake.</li>
              <li>Only the trade's own two addresses are barred from voting. A buyer or seller who staked from other addresses at least {stakeAgeTxt} before the dispute opened can vote on their own dispute, and the side with more eligible stake decides.</li>
              <li>Commit window: {fmtSpan(cfg.commit)} from when the dispute (or a new round) opens. Reveal window: the {fmtSpan(cfg.reveal)} after that. Keep your salt: without it you cannot reveal.</li>
              <li>Each open vote reserves {slashPct}% of your stake, so you can hold about {Math.floor(10000 / Math.max(1, Number(cfg.slashBps)))} unresolved votes at a time.</li>
              <li>
                <span className="text-rose-300 font-bold">Slashing:</span> if you commit and do not reveal in time, or you reveal on the losing side, you lose that {slashPct}% reserve. It is added to the pay of the majority.
              </li>
              <li>
                <span className="text-emerald-300 font-bold">Buyer paid wins:</span> the buyer gets the ETH minus the {FEE_PCT}% fee (the fee goes to the Fee Fanout), and the seller's whole bond (exactly the larger of {BOND_MIN_ETH} ETH and {BOND_PCT}% of the trade) is paid to the majority.
              </li>
              <li>
                <span className="text-emerald-300 font-bold">Buyer did not pay wins:</span> the ETH goes back to the seller, the buyer's address is flagged, half the bond is paid to the majority as the cost of arbitration and the other half goes back to the seller.
              </li>
              <li>There is no reward pool: the bond and the slashes are the only pay. Majority revealers share it pro rata to weight. Claim it any time.</li>
              <li>A decision needs at least 3 revealers and a strict weight majority. Otherwise resolve starts another round ({fmtSpan(cfg.commit)} commit + {fmtSpan(cfg.reveal)} reveal), again and again. If there is still no decision {longStopTxt} after the dispute opened, the next resolve ends it: the ETH and the whole bond go back to the seller, the buyer is not flagged, revealers are not slashed and nobody is paid. Each stage waits for someone (anyone) to call resolve.</li>
              <li>Unstaking takes {fmtSpan(cfg.unstakeDelay)}, and a withdrawal waits for every vote you hold to be revealed and resolved.</li>
            </ul>
          </div>
        </div>

        {/* Right: disputes */}
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {disputes.length === 0 ? (
            <div className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-8 shadow-xl text-center space-y-2">
              <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto text-slate-500">
                <Scale className="w-6 h-6" />
              </div>
              <div className="text-sm font-bold text-white font-display">{loading ? 'Loading disputes...' : 'No open disputes'}</div>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                When a seller disputes a trade, it shows up here with the evidence from both sides and a countdown for each phase.
              </p>
            </div>
          ) : (
            disputes.map((d) => {
              const key = d.id.toString();
              const phase = phaseOf(d);
              const t = d.trade;
              const isParty = !!account && (sameAddr(account, d.buyer) || sameAddr(account, d.seller));
              const committed = !!d.mine && d.mine.commitment !== ZERO_HASH;
              const revealed = !!d.mine?.revealed;
              void savedTick;
              const attempts = readAttempts(arb, d.id, account);
              // The attempt that matches what is on chain (recomputed, not just the stored commitment).
              const matching = committed && account
                ? attempts.find((a) => commitmentFor(d.id, a.vote, a.salt, account).toLowerCase() === d.mine!.commitment.toLowerCase()) || null
                : null;
              const pendingSend = !committed ? attempts.find((a) => a.sentAt && now - a.sentAt < PENDING_COMMIT_S) || null : null;
              const block = !committed ? commitBlock(d) : null;
              const longStopAt = d.openedAt + Number(cfg.longStop);
              const totalRevealed = d.weightBuyerPaid + d.weightDidNotPay;
              const buyerEv = d.evidence.filter((e) => sameAddr(e.by, d.buyer));
              const sellerEv = d.evidence.filter((e) => sameAddr(e.by, d.seller));
              const otherEv = d.evidence.filter((e) => !sameAddr(e.by, d.buyer) && !sameAddr(e.by, d.seller));
              const myEvCount = d.evidence.filter((e) => sameAddr(e.by, account)).length;
              const draft = (evidenceDraft[key] || '').trim();
              const phaseTone =
                phase.key === 'commit' ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                : phase.key === 'reveal' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                : phase.key === 'resolve' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-slate-700/40 text-slate-300 border-slate-600';

              // manual reveal inputs (when the matching salt is not in this browser)
              const mSalt = (manualSalt[key] || '').trim();
              const mVote = manualVote[key] ?? VOTE_BUYER_PAID;
              const mSaltOk = /^0x[0-9a-fA-F]{64}$/.test(mSalt);
              const manualMatches = mSaltOk && committed && account ? commitmentFor(d.id, mVote, mSalt as Hex, account) === d.mine!.commitment : false;
              const backupText = (a: SavedVote) => `trade ${key} vote ${a.vote} salt ${a.salt} commitment ${a.commitment}`;

              return (
                <div key={key} className="bg-[#0e121d] border border-[#1e2538] rounded-2xl p-4 shadow-xl space-y-3">
                  {/* Title row */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1b2234]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Gavel className="w-4 h-4 text-amber-400 shrink-0" />
                      <a
                        href={`/robinhood/trade/${key}`}
                        onClick={(e) => {
                          // Same-page hop to the trade's own page (the desk listens for popstate); modified clicks open a tab.
                          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                          e.preventDefault();
                          window.history.pushState({ appTab: 'robinhood', rhSub: 'trades' }, '', `/robinhood/trade/${key}`);
                          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
                        }}
                        className="text-sm font-bold text-white font-display hover:underline"
                        title="Open this trade's own page (shareable link)"
                      >
                        Trade #{key}
                      </a>
                      {d.extensions > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">Extended {d.extensions}x</span>}
                    </div>
                    <div className={`text-[11px] font-mono px-2 py-1 rounded-lg border flex items-center gap-1.5 ${phaseTone}`}>
                      <Clock className="w-3.5 h-3.5" />
                      {phase.label}
                      {phase.key === 'commit' || phase.key === 'reveal' ? `: ${fmtDur(phase.endsAt - now)} left` : ''}
                    </div>
                  </div>

                  {/* Trade facts */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="ETH in escrow" value={t ? `${fmtEth(t.ethAmount)} ETH` : '...'} />
                    <Stat label="Dollars owed" value={t ? fmtUsd(t.expectedCents) : '...'} sub="On X Money" tone="text-emerald-400" />
                    <Stat label="Seller bond" value={`${fmtEth(d.bond)} ETH`} sub="All of it pays the majority if the buyer paid; half if not" />
                    <Stat label="Marked paid" value={t && t.paidAt ? fmtTime(t.paidAt) : '...'} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 min-w-0">
                      <div className="text-[10px] uppercase text-slate-500 font-mono">Buyer (says they paid)</div>
                      {t?.buyerXHandle ? (
                        <a href={`https://x.com/${encodeURIComponent(t.buyerXHandle)}`} target="_blank" rel="noreferrer" className="font-bold text-white">@{t.buyerXHandle}</a>
                      ) : <span className="text-slate-400">no handle</span>}
                      <a href={`${EXPLORER}/address/${d.buyer}`} target="_blank" rel="noreferrer" className="block font-mono text-slate-400 break-all">{d.buyer}</a>
                      {d.buyerFlagged && <div className="text-rose-300 mt-1">This address is already flagged from an earlier dispute.</div>}
                    </div>
                    <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 min-w-0">
                      <div className="text-[10px] uppercase text-slate-500 font-mono">Seller (says no payment arrived)</div>
                      {t?.sellerXHandle ? (
                        <a href={`https://x.com/${encodeURIComponent(t.sellerXHandle)}`} target="_blank" rel="noreferrer" className="font-bold text-white">@{t.sellerXHandle}</a>
                      ) : <span className="text-slate-400">no handle</span>}
                      <a href={`${EXPLORER}/address/${d.seller}`} target="_blank" rel="noreferrer" className="block font-mono text-slate-400 break-all">{d.seller}</a>
                    </div>
                  </div>
                  {t && (
                    <div className="text-xs bg-[#151c2d] border border-[#1e2538] rounded-xl p-3">
                      <div className="text-[10px] uppercase text-slate-500 font-mono">Buyer's payment note</div>
                      <p className="text-slate-200 whitespace-pre-wrap break-words">{t.paymentNote || 'No note given.'}</p>
                      <p className="text-slate-500 mt-1">
                        The question: did @{t.buyerXHandle || shortAddr(d.buyer)} send {fmtUsd(t.expectedCents)} on X Money to @{t.sellerXHandle || shortAddr(d.seller)} for this trade?
                        The handles were typed by the addresses that opened the order and the trade; the contract does not verify them.
                      </p>
                    </div>
                  )}

                  {/* Evidence */}
                  <div className="space-y-2">
                    <div className="text-xs font-bold text-white flex items-center gap-1.5">
                      <ImageIcon className="w-3.5 h-3.5 text-cyan-400" /> Evidence ({d.evidence.length})
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {[{ title: 'From the buyer', items: buyerEv }, { title: 'From the seller', items: sellerEv }].map((col) => (
                        <div key={col.title} className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 space-y-2 min-w-0">
                          <div className="text-[10px] uppercase text-slate-500 font-mono">{col.title}</div>
                          {col.items.length === 0 ? (
                            <p className="text-xs text-slate-500">Nothing submitted.</p>
                          ) : (
                            col.items.map((e, i) => <EvidenceItem key={i} uri={e.uri} />)
                          )}
                        </div>
                      ))}
                    </div>
                    {otherEv.length > 0 && (
                      <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 space-y-2">
                        <div className="text-[10px] uppercase text-slate-500 font-mono">From other addresses</div>
                        {otherEv.map((e, i) => (
                          <div key={i} className="space-y-1">
                            <div className="text-[10px] font-mono text-slate-500 break-all">{e.by}</div>
                            <EvidenceItem uri={e.uri} />
                          </div>
                        ))}
                      </div>
                    )}
                    {isParty && !d.resolved && (
                      <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 space-y-2">
                        <div className="text-[10px] uppercase text-slate-500 font-mono">Add evidence as the {sameAddr(account, d.buyer) ? 'buyer' : 'seller'}</div>
                        <textarea
                          value={evidenceDraft[key] || ''}
                          onChange={(e) => setEvidenceDraft((s) => ({ ...s, [key]: e.target.value }))}
                          rows={2}
                          maxLength={MAX_URI_BYTES}
                          placeholder={`A link or a short statement (up to ${MAX_URI_BYTES} bytes)`}
                          className="w-full bg-[#0e121d] border border-[#1e2538] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500/60"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] text-slate-500">
                            Stored on-chain: public and permanent. You pay gas. {Math.max(0, MAX_EVIDENCE_PER_PARTY - myEvCount)} of {MAX_EVIDENCE_PER_PARTY} items left.
                            {bytesOf(draft) > MAX_URI_BYTES && <span className="text-rose-300"> That is {bytesOf(draft)} bytes; the contract takes at most {MAX_URI_BYTES}.</span>}
                          </span>
                          <button
                            type="button"
                            disabled={!draft || bytesOf(draft) > MAX_URI_BYTES || myEvCount >= MAX_EVIDENCE_PER_PARTY || busy !== null}
                            onClick={() =>
                              run(`ev-${key}`, 'Evidence added.', async () => {
                                const r = await send('submitEvidence', [d.id, draft]);
                                setEvidenceDraft((s) => ({ ...s, [key]: '' }));
                                return r;
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40"
                          >
                            {busy === `ev-${key}` ? 'Submitting...' : 'Submit evidence'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Tally and timeline */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 space-y-1">
                      <div className="text-[10px] uppercase text-slate-500 font-mono">Revealed this round ({d.revealers} of 3 needed)</div>
                      <div className="flex justify-between"><span className="text-emerald-300">Buyer paid</span><span className="font-mono">{fmtEth(d.weightBuyerPaid)} ETH ({pct(d.weightBuyerPaid, totalRevealed)})</span></div>
                      <div className="flex justify-between"><span className="text-rose-300">Buyer did not pay</span><span className="font-mono">{fmtEth(d.weightDidNotPay)} ETH ({pct(d.weightDidNotPay, totalRevealed)})</span></div>
                      {phase.key === 'commit' && <div className="text-slate-500">Votes stay sealed until the reveal phase.</div>}
                    </div>
                    <div className="bg-[#151c2d] border border-[#1e2538] rounded-xl p-3 space-y-1 font-mono text-[11px]">
                      <div className="flex justify-between gap-2"><span className="text-slate-500">Opened</span><span className="text-right">{fmtTime(d.openedAt)}</span></div>
                      <div className="flex justify-between gap-2"><span className="text-slate-500">Commit ends</span><span className="text-right">{fmtTime(d.commitEnd)}</span></div>
                      <div className="flex justify-between gap-2"><span className="text-slate-500">Reveal ends</span><span className="text-right">{fmtTime(d.revealEnd)}</span></div>
                      <div className="flex justify-between gap-2"><span className="text-slate-500">Long-stop</span><span className="text-right">{fmtTime(longStopAt)}</span></div>
                    </div>
                  </div>

                  {/* Your vote */}
                  <div className="bg-[#0b0f18] border border-[#1e2538] rounded-xl p-3 space-y-2">
                    <div className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-amber-400" /> Your vote
                    </div>

                    {!account ? (
                      <p className="text-xs text-slate-400">Connect a wallet to vote.</p>
                    ) : isParty ? (
                      <p className="text-xs text-slate-400">You are a party to this trade, so you cannot vote on it.</p>
                    ) : revealed ? (
                      <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                        <CheckCircle className="w-3.5 h-3.5" /> Revealed with weight {fmtEth(d.mine!.weight)} ETH
                        {matching ? ` (${matching.vote === VOTE_BUYER_PAID ? 'buyer paid' : 'buyer did not pay'})` : ''}. Pay or slashing applies when it resolves.
                      </p>
                    ) : committed ? (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-300">
                          Committed with weight {fmtEth(d.mine!.weight)} ETH.{' '}
                          {phase.key === 'commit' && <>Reveal opens in {fmtDur(d.commitEnd - now + 1)}.</>}
                          {phase.key === 'resolve' && <span className="text-rose-300">The reveal window has closed. An unrevealed vote loses its {slashPct}% reserve when this resolves.</span>}
                        </p>
                        {matching ? (
                          <div className="text-[11px] bg-[#151c2d] border border-[#1e2538] rounded-lg p-2 space-y-1">
                            <div className="text-slate-400">
                              Saved in this browser and matching your on-chain commit: <span className="text-white">{matching.vote === VOTE_BUYER_PAID ? 'Buyer paid' : 'Buyer did not pay'}</span>
                            </div>
                            <div className="flex items-center gap-2 min-w-0">
                              <code className="font-mono text-slate-300 break-all min-w-0">{matching.salt}</code>
                              <CopyButton text={backupText(matching)} label="Back up" />
                            </div>
                          </div>
                        ) : attempts.length > 0 ? (
                          <div className="text-[11px] bg-[#151c2d] border border-rose-500/30 rounded-lg p-2 space-y-1">
                            <div className="text-rose-300">None of the {attempts.length} salt(s) saved in this browser match your on-chain commit. Use the vote and salt you backed up from where you committed.</div>
                            {attempts.map((a, i) => (
                              <div key={i} className="flex items-center gap-2 min-w-0">
                                <span className="text-slate-500 shrink-0">{a.vote === VOTE_BUYER_PAID ? 'paid' : 'not paid'}:</span>
                                <code className="font-mono text-slate-400 break-all min-w-0">{a.salt}</code>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {phase.key === 'reveal' && matching && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => run(`rv-${key}`, `Vote revealed on trade #${key}.`, () => send('revealVote', [d.id, matching.vote, matching.salt]))}
                            className="w-full py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40"
                          >
                            {busy === `rv-${key}` ? 'Revealing...' : `Reveal: ${matching.vote === VOTE_BUYER_PAID ? 'buyer paid' : 'buyer did not pay'}`}
                          </button>
                        )}
                        {phase.key === 'reveal' && !matching && (
                          <div className="space-y-2">
                            <p className="text-[11px] text-amber-200">Your matching salt is not saved in this browser. Enter the vote and salt you backed up.</p>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <select
                                value={mVote}
                                onChange={(e) => setManualVote((s) => ({ ...s, [key]: Number(e.target.value) as Vote }))}
                                className="bg-[#151c2d] border border-[#1e2538] rounded-lg px-2 py-2 text-xs text-white"
                              >
                                <option value={VOTE_BUYER_PAID}>Buyer paid</option>
                                <option value={VOTE_DID_NOT_PAY}>Buyer did not pay</option>
                              </select>
                              <input
                                value={manualSalt[key] || ''}
                                onChange={(e) => setManualSalt((s) => ({ ...s, [key]: e.target.value }))}
                                placeholder="0x... (32-byte salt)"
                                className="flex-1 min-w-0 bg-[#151c2d] border border-[#1e2538] rounded-lg px-3 py-2 text-xs text-white font-mono"
                              />
                            </div>
                            {mSalt && !manualMatches && <p className="text-[11px] text-rose-300">This vote and salt do not match your commit, so the reveal would fail.</p>}
                            <button
                              type="button"
                              disabled={!manualMatches || busy !== null}
                              onClick={() => run(`rv-${key}`, `Vote revealed on trade #${key}.`, () => send('revealVote', [d.id, mVote, mSalt as Hex]))}
                              className="w-full py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {busy === `rv-${key}` ? 'Revealing...' : 'Reveal'}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : phase.key === 'commit' ? (
                      block ? (
                        <p className="text-xs text-slate-400">{block}</p>
                      ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {([VOTE_BUYER_PAID, VOTE_DID_NOT_PAY] as Vote[]).map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={() => setChoice((s) => ({ ...s, [key]: v }))}
                                className={`py-2 px-3 rounded-lg text-xs font-bold border cursor-pointer text-left ${
                                  choice[key] === v
                                    ? v === VOTE_BUYER_PAID ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200' : 'bg-rose-500/20 border-rose-400 text-rose-200'
                                    : 'bg-[#151c2d] border-[#1e2538] text-slate-300 hover:border-slate-500'
                                }`}
                              >
                                {v === VOTE_BUYER_PAID ? 'Buyer paid' : 'Buyer did not pay'}
                                <span className="block text-[10px] font-normal text-slate-400">
                                  {v === VOTE_BUYER_PAID ? 'ETH to the buyer, the whole bond pays the majority' : 'ETH back to the seller, buyer flagged, half the bond pays the majority'}
                                </span>
                              </button>
                            ))}
                          </div>
                          <p className="text-[11px] text-slate-400">
                            Commits with weight {fmtEth(stake)} ETH (your whole stake) and reserves {fmtEth(reservePerVote)} ETH of it until this dispute resolves. A random salt is saved in this browser before you sign; back it up. If you do not reveal between {fmtTime(d.commitEnd)} and {fmtTime(d.revealEnd)}, you lose that reserve.
                            {openCommitted > 0 && <> You already hold {openCommitted} open vote(s) on this page.</>}
                          </p>
                          {pendingSend && (
                            <p className="text-[11px] text-amber-200">
                              A commit from this browser was sent {fmtDur(now - (pendingSend.sentAt ?? now))} ago and may still land. Wait for it to show up here before committing again.
                              {pendingSend.txHash && <> <a href={`${EXPLORER}/tx/${pendingSend.txHash}`} target="_blank" rel="noreferrer" className="underline">View transaction</a></>}
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={!choice[key] || busy !== null || !!pendingSend}
                            onClick={() => {
                              const vote = choice[key];
                              if (!vote || !account) return;
                              run(`cm-${key}`, `Vote committed on trade #${key}. Back up your salt, then come back to reveal after ${fmtTime(d.commitEnd)}.`, async () => {
                                // Same vote as an earlier attempt: reuse its salt, so whichever transaction lands, the saved salt matches.
                                const existing = readAttempts(arb, d.id, account).find((a) => a.vote === vote);
                                let attempt: SavedVote;
                                if (existing) {
                                  attempt = existing;
                                } else {
                                  const salt = randomSalt();
                                  attempt = { vote, salt, commitment: commitmentFor(d.id, vote, salt, account), savedAt: Math.floor(Date.now() / 1000) };
                                  const ok = upsertAttempt(arb, d.id, account, attempt);
                                  if (!ok && !window.confirm(`This browser would not save your salt. Copy it now, or you cannot reveal:\n\n${salt}\n\nContinue with the commit?`)) {
                                    throw new Error('Commit cancelled: the salt could not be saved.');
                                  }
                                }
                                upsertAttempt(arb, d.id, account, { ...attempt, sentAt: Math.floor(Date.now() / 1000) });
                                setSavedTick((n) => n + 1);
                                try {
                                  const r = await send('commitVote', [d.id, attempt.commitment]);
                                  upsertAttempt(arb, d.id, account, { ...attempt, txHash: r.txHash });
                                  return r;
                                } catch (e) {
                                  // Only a transaction that certainly did not land frees the pending lock; the salt itself is kept either way.
                                  if (isUserRejection(e) || (e instanceof TxError && e.kind === 'reverted') || !(e instanceof TxError)) {
                                    upsertAttempt(arb, d.id, account, { ...attempt, sentAt: 0 });
                                  } else {
                                    upsertAttempt(arb, d.id, account, { ...attempt, txHash: e.txHash });
                                  }
                                  throw e;
                                } finally {
                                  setSavedTick((n) => n + 1);
                                }
                              });
                            }}
                            className="w-full py-2 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                          >
                            <Lock className="w-3.5 h-3.5" /> {busy === `cm-${key}` ? 'Committing...' : 'Commit sealed vote'}
                          </button>
                          {attempts.length > 0 && (
                            <div className="text-[11px] bg-[#151c2d] border border-[#1e2538] rounded-lg p-2 space-y-1">
                              <div className="text-slate-400">Salts saved in this browser for this dispute (a retry with the same vote reuses its salt):</div>
                              {attempts.map((a, i) => (
                                <div key={i} className="flex items-center gap-2 min-w-0">
                                  <span className="text-slate-500 shrink-0">{a.vote === VOTE_BUYER_PAID ? 'paid' : 'not paid'}:</span>
                                  <code className="font-mono text-slate-300 break-all min-w-0">{a.salt}</code>
                                  <CopyButton text={backupText(a)} label="Back up" />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <p className="text-xs text-slate-400">You did not commit a vote in this round, and its commit window has closed.{d.extensions > 0 || phase.key === 'resolve' ? ' If it ends without a decision, a new round opens for commits.' : ''}</p>
                    )}
                  </div>

                  {/* Resolve */}
                  {phase.key === 'resolve' && (
                    <div className="space-y-1.5">
                      <button
                        type="button"
                        disabled={!account || busy !== null}
                        onClick={() => run(`rs-${key}`, `Resolve sent for trade #${key}.`, () => send('resolve', [d.id]))}
                        className="w-full py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <Gavel className="w-3.5 h-3.5" /> {busy === `rs-${key}` ? 'Resolving...' : 'Resolve this dispute'}
                      </button>
                      <p className="text-[11px] text-slate-500 flex items-start gap-1">
                        <Info className="w-3 h-3 shrink-0 mt-0.5" />
                        Anyone can call this; you pay gas.{' '}
                        {now < longStopAt
                          ? `With fewer than 3 revealers or a tied weight it starts another round of ${fmtSpan(cfg.commit)} + ${fmtSpan(cfg.reveal)} instead of settling.`
                          : 'The long-stop has passed: without a decision this ends the dispute with the ETH and the whole bond back to the seller, and the buyer is not flagged.'}
                      </p>
                    </div>
                  )}
                </div>
              );
            })
          )}
          <p className="text-[11px] text-slate-500 flex items-start gap-1.5 px-1">
            <Coins className="w-3.5 h-3.5 shrink-0" />
            Arbitration contract{' '}
            <a href={`${EXPLORER}/address/${arbitrationAddress}`} target="_blank" rel="noreferrer" className="font-mono underline break-all">{arbitrationAddress}</a>
            {' '}on Robinhood Chain. No admin: after the one-time bind to the desk, nobody can change the rules or move stakes.
          </p>
        </div>
      </div>
    </div>
  );
}

export default RobinhoodArbiters;
