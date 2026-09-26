import { encodeFunctionData, decodeEventLog, isAddress, parseAbi } from 'viem';
import {
  L3, L4, PARENT_CHAIN_ID, XGAS_CHAIN_ID, XGAS_API, parent, xgas, ZERO,
  BURN_BPS, FANOUT_RAKE_BPS, SCALE_FACTOR, DEPLOY, FAST_CONFIRM_SAFE, VALIDATORS, LEGACY, EARLY_DEPOSITOR,
} from '../config.mjs';
import { ERC20_ABI, VAULT_ABI, ARBSYS_ABI, EARLY_DEPOSITOR_ABI } from '../abis.mjs';
import { fmtUsdg, fmtXMoney, parseUsdg, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply, submitFields } from '../approval.mjs';
import { submitBatch, submitRaw } from '../idempotency.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const amount = (d) => ({ type: 'string', description: d });
const BPS = 10000n;
// Deposits are open on 466302 by default: before the vault switch through EarlyDepositor, after it through
// vault.enterRollup. Set XGAS_DEPOSITS_PAUSED=1 to close them from the connector side.
const DEPOSITS_PAUSED = ['1', 'true', 'yes'].includes(String(process.env.XGAS_DEPOSITS_PAUSED || '').toLowerCase());
const DEPOSITS_PAUSED_MSG = 'Deposits are paused on this connector by its operator (XGAS_DEPOSITS_PAUSED). Nothing was prepared or sent.';

// EarlyDepositor's INBOX is a compile-time constant; read it once and keep it.
let helperInboxCache = null;
async function helperInbox() {
  if (!helperInboxCache) {
    helperInboxCache = await parent.readContract({ address: EARLY_DEPOSITOR, abi: EARLY_DEPOSITOR_ABI, functionName: 'INBOX' });
  }
  return helperInboxCache;
}

/**
 * Which contract a deposit goes through right now. vault.enterRollup creates its ticket on vault.inbox(); until the
 * timelocked setBridgeSystem points that at this chain's inbox, an enterRollup would go to the retired chain. In that
 * window deposits go through EarlyDepositor, which mints from the vault and opens the retryable on this chain's inbox
 * itself. path is 'vault', 'early_depositor', or null when neither can be shown to reach this chain.
 */
async function vaultRoute() {
  const expected = L3.inbox || null;
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  let inbox;
  try {
    inbox = await parent.readContract({ address: L3.xMoney, abi: VAULT_ABI, functionName: 'inbox' });
  } catch (e) {
    return { path: null, vault_inbox: null, this_chain_inbox: expected, routes_to_this_chain: null, note: `Could not read the vault's inbox (${e.shortMessage || e.message}), so this connector cannot tell which route reaches xGas ${XGAS_CHAIN_ID}. Nothing will be prepared until it can.` };
  }
  if (same(inbox, expected)) {
    return {
      path: 'vault', vault_inbox: inbox, this_chain_inbox: expected, routes_to_this_chain: true,
      note: `The vault sends deposits to inbox ${inbox}, which is xGas ${XGAS_CHAIN_ID}: deposits use vault.enterRollup.`,
    };
  }
  let hInbox = null;
  let err = null;
  try { hInbox = await helperInbox(); } catch (e) { err = e.shortMessage || e.message; }
  const helperOk = same(hInbox, expected);
  return {
    path: helperOk ? 'early_depositor' : null,
    vault_inbox: inbox,
    this_chain_inbox: expected,
    routes_to_this_chain: false,
    early_depositor: EARLY_DEPOSITOR,
    early_depositor_inbox: hInbox,
    note: helperOk
      ? `The vault's own enterRollup still targets inbox ${inbox}, not xGas ${XGAS_CHAIN_ID}'s inbox ${expected} (the vault's timelocked switch has not executed). Deposits go through EarlyDepositor ${EARLY_DEPOSITOR}, which mints from the vault and opens the retryable on this chain's inbox itself.`
      : `The vault targets inbox ${inbox}, not xGas ${XGAS_CHAIN_ID}'s inbox ${expected}, and EarlyDepositor ${EARLY_DEPOSITOR} ${err ? `could not be read (${err})` : `targets inbox ${hInbox}`}. No deposit route reaches this chain right now, so nothing will be prepared.`,
  };
}

// EIP-7702: an EOA that has delegated to code carries 0xef0100 || delegate as its code.
const DELEGATION_PREFIX = '0xef0100';
/** The EIP-7702 aliasing landmine, stated once so every deposit path says the same thing. */
const ALIAS_WARNING = 'Do not bridge by calling inbox.depositERC20 directly from a smart account, including an EIP-7702 '
  + 'delegated EOA, or through a relayer or bundler: when the caller has code or is not tx.origin, the Inbox credits the '
  + 'ALIASED address (yours plus 0x1111000000000000000000000000000000001111) on xGas, not yours. This tool uses '
  + 'EarlyDepositor.deposit until the vault switch and vault.enterRollup after it; both name the recipient as the ticket '
  + 'destination, so the $xMoney lands at the recipient shown here.';
async function accountKind(address) {
  // viem returns undefined (not '0x') for an address with no code; only a failed read is 'unknown'.
  let code;
  try { code = await parent.getCode({ address }); } catch { return 'unknown'; }
  if (!code || code === '0x') return 'eoa';
  // EarlyDepositor accepts exactly this shape (23 bytes, 0xef0100 || delegate) and rejects any other code.
  return code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 23 * 2 ? 'eip7702' : 'contract';
}

/** Mirrors XMoney._deposit + _grossXMoneyFor exactly, against live reserve and supply. */
async function enterMath(usdgWei) {
  const [, usdgReserve, circulating] = await parent.readContract({
    address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV',
  });
  const usdgRake = (usdgWei * FANOUT_RAKE_BPS) / BPS;
  const netUsdgToReserve = usdgWei - usdgRake;
  const gross = circulating === 0n || usdgReserve === 0n
    ? netUsdgToReserve * SCALE_FACTOR
    : (netUsdgToReserve * circulating) / usdgReserve;
  const entryBurn = (gross * BURN_BPS) / BPS;
  const net = gross - entryBurn;
  const bufferToBridge = entryBurn / 2n;
  const burnToDead = entryBurn - bufferToBridge;
  return { usdgWei, usdgRake, netUsdgToReserve, gross, entryBurn, net, bufferToBridge, burnToDead, usdgReserve, circulating };
}

// A plain value retry on 466302 uses about 21.2k gas (NodeInterface estimate). Only for the "about" figure;
// the guaranteed minimum below does not depend on it.
const EST_REDEEM_GAS = 21_200n;

/**
 * What actually lands on xGas, per route.
 *   early_depositor: the vault mints `net` to the helper; the helper -> inbox transfer pays the 1 bp xMoney tax
 *     (the new inbox is not yet a bridge-system address), so the deposit D = net - net/1e4. The helper's retryable
 *     pays l2CallValue = D - gasLimit*maxFeePerGas and refunds the unused gas to the recipient (never aliased).
 *   vault: D = net (inbox is bridge-system, untaxed); l2CallValue = D - l3GasLimit*l3MaxFeePerGas, unused gas refunded
 *     to the recipient, or to its alias when the recipient has code on the parent chain.
 * guaranteed = l2CallValue; about = D - ~21.2k * current L3 base fee.
 */
async function enterQuote(usdgWei, route) {
  const r = route || await vaultRoute();
  const early = r.path === 'early_depositor';
  const read = (address, abi, functionName) => parent.readContract({ address, abi, functionName });
  const gas = early
    ? Promise.all([read(EARLY_DEPOSITOR, EARLY_DEPOSITOR_ABI, 'defaultGasLimit'), read(EARLY_DEPOSITOR, EARLY_DEPOSITOR_ABI, 'defaultMaxFeePerGas')])
    : Promise.all([read(L3.xMoney, VAULT_ABI, 'l3GasLimit'), read(L3.xMoney, VAULT_ABI, 'l3MaxFeePerGas')]);
  const [m, [gasLimit, maxFeePerGas], l3BaseFee] = await Promise.all([
    enterMath(usdgWei),
    gas.catch(() => [null, null]),
    xgas.getBlock().then((b) => b.baseFeePerGas ?? null).catch(() => null),
  ]);
  const inboxTax = early ? (m.net * BURN_BPS) / BPS : 0n;
  const l3Deposit = m.net - inboxTax;
  const gasPrepay = gasLimit != null && maxFeePerGas != null ? gasLimit * maxFeePerGas : null;
  const tooSmall = gasPrepay != null && l3Deposit <= gasPrepay;
  const guaranteed = gasPrepay != null && !tooSmall ? l3Deposit - gasPrepay : null;
  const redeemFee = l3BaseFee != null ? EST_REDEEM_GAS * l3BaseFee : null;
  const about = !tooSmall && redeemFee != null && l3Deposit > redeemFee ? l3Deposit - redeemFee : null;
  return { ...m, path: r.path, early, inboxTax, l3Deposit, gasLimit, maxFeePerGas, gasPrepay, tooSmall, guaranteed, l3BaseFee, redeemFee, about, route: r };
}

/** One line on what lands, for quotes and approval screens. */
function creditLine(q, { refundAliased = false } = {}) {
  if (q.tooSmall) return `nothing: the deposit (${fmtXMoney(q.l3Deposit)} xMoney) does not cover the L3 gas prepayment (${fmtXMoney(q.gasPrepay)}), so it would revert`;
  if (refundAliased && q.guaranteed != null) return `${fmtXMoney(q.guaranteed)} $xMoney as native gas on xGas L4 (the unused-gas refund goes to the aliased address, not the recipient)`;
  if (q.about != null && q.guaranteed != null) return `about ${fmtXMoney(q.about)} $xMoney as native gas on xGas L4 (at least ${fmtXMoney(q.guaranteed)})`;
  if (q.guaranteed != null) return `at least ${fmtXMoney(q.guaranteed)} $xMoney as native gas on xGas L4`;
  return `${fmtXMoney(q.l3Deposit)} $xMoney minus L3 gas (the retryable gas parameters could not be read)`;
}

function creditFees(q) {
  const fees = [
    { label: 'USDG rake to the Fanout', amount: `${fmtUsdg(q.usdgRake)} USDG`, note: '0.01%' },
    { label: 'xMoney entry burn', amount: `${fmtXMoney(q.entryBurn)} xMoney`, note: `0.01%: ${fmtXMoney(q.burnToDead)} to 0x…dEaD, ${fmtXMoney(q.bufferToBridge)} minted to the vault's bridge as solvency buffer` },
  ];
  if (q.early) fees.push({ label: 'xMoney transfer tax into the inbox', amount: `${fmtXMoney(q.inboxTax)} xMoney`, note: '0.01%, burned: until the vault switch the new inbox is not a tax-exempt bridge address' });
  fees.push({
    label: 'L3 gas for the auto-redeem',
    amount: q.redeemFee != null ? `about ${fmtXMoney(q.redeemFee)} xMoney` : 'a few millionths of an xMoney',
    note: q.gasPrepay != null ? `${fmtXMoney(q.gasPrepay)} is prepaid (${q.gasLimit} gas at ${q.maxFeePerGas} wei) and the unused part is refunded` : 'prepaid out of the deposit, unused part refunded',
  });
  return fees;
}

/** Mirrors XMoney.exitRollup, and adds the bridge-exit transfer burn the user pays on the way out. */
async function exitMath(xWei) {
  const [, usdgReserve, circulating] = await parent.readContract({
    address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV',
  });
  // Leg 2: the Outbox pays out of the Bridge. That is a transfer OUT of the bridge system,
  // so the 0.01% xMoney tax applies and the parent balance lands 0.01% short.
  const bridgeExitBurn = (xWei * BURN_BPS) / BPS;
  const arrivesOnParent = xWei - bridgeExitBurn;
  const gross = circulating === 0n ? 0n : (arrivesOnParent * usdgReserve) / circulating;
  const usdgRake = (gross * FANOUT_RAKE_BPS) / BPS;
  const usdgOut = gross - usdgRake;
  return { xWei, bridgeExitBurn, arrivesOnParent, gross, usdgRake, usdgOut, usdgReserve, circulating };
}

// BoLD on an Arbitrum parent reads block.number, and on Arbitrum that is the ETHEREUM L1
// block number, not the parent's own ~0.1 s blocks. So confirmPeriodBlocks, createdAtBlock and
// validatorAfkBlocks are all counted in Ethereum blocks. There is no L1 RPC here to measure the
// cadence, so this uses Ethereum's fixed 12 s slot time (missed slots only make it longer).
const L1_SECONDS_PER_BLOCK = 12;
// Past this, a quiet validator is not "between assertions", it is idle, and exits are stuck behind it.
const IDLE_AFTER_SECONDS = 6 * 3600;

const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
]);

const BOLD_ABI = parseAbi([
  'function confirmPeriodBlocks() view returns (uint64)',
  'function latestConfirmed() view returns (bytes32)',
  'function anyTrustFastConfirmer() view returns (address)',
  'function getValidators() view returns (address[])',
  'function latestStakedAssertion(address) view returns (bytes32)',
  'function validatorAfkBlocks() view returns (uint64)',
  'function validatorWhitelistDisabled() view returns (bool)',
  'function getAssertion(bytes32) view returns ((uint64 firstChildBlock, uint64 secondChildBlock, uint64 createdAtBlock, bool isFirstChild, uint8 status, bytes32 configHash))',
]);
const ASSERTION_STATUS = ['none', 'pending', 'confirmed'];

/**
 * How long a withdrawal actually waits, read from the rollup rather than assumed: the
 * contractual challenge window (confirmPeriodBlocks in Ethereum blocks), whether a fast
 * confirmer can skip it, and how long ago the validator last asserted. Cached for a minute.
 */
let windowCache = { at: 0, value: null };
async function assertionWindow() {
  if (windowCache.value && Date.now() - windowCache.at < 60_000) return windowCache.value;
  const rd = (functionName, args = []) => parent.readContract({ address: L3.rollup, abi: BOLD_ABI, functionName, args });
  let confirmBlocks;
  try {
    confirmBlocks = await rd('confirmPeriodBlocks');
  } catch (e) {
    return { error: `Could not read confirmPeriodBlocks from the rollup (${e.shortMessage || e.message}). No ETA is better than a guessed one.` };
  }
  const contractualSeconds = Number(confirmBlocks) * L1_SECONDS_PER_BLOCK;
  const value = {
    rollup: L3.rollup,
    confirm_period_blocks: Number(confirmBlocks),
    counted_in: 'Ethereum L1 blocks (BoLD on an Arbitrum parent reads the L1 block number)',
    l1_seconds_per_block: L1_SECONDS_PER_BLOCK,
    contractual_seconds: contractualSeconds,
    contractual: humanDuration(contractualSeconds),
    measured_at: new Date().toISOString(),
  };

  try {
    const [fastConfirmer, validators, latestConfirmed, afkBlocks, whitelistOff, head] = await Promise.all([
      rd('anyTrustFastConfirmer'), rd('getValidators'), rd('latestConfirmed'),
      rd('validatorAfkBlocks'), rd('validatorWhitelistDisabled'), parent.getBlock(),
    ]);
    const staked = await Promise.all(validators.map((v) => rd('latestStakedAssertion', [v]).catch(() => null)));
    const hashes = [...new Set([latestConfirmed, ...staked].filter((h) => h && !/^0x0+$/.test(h)))];
    const nodes = await Promise.all(hashes.map(async (hash) => ({ hash, ...(await rd('getAssertion', [hash])) })));
    const newest = nodes.reduce((a, b) => (b.createdAtBlock > a.createdAtBlock ? b : a));
    const confirmedNode = nodes.find((n) => n.hash === latestConfirmed);

    // The parent's block header carries the L1 block number it was built on.
    const l1Now = head.l1BlockNumber != null ? BigInt(head.l1BlockNumber) : null;
    const ageBlocks = l1Now != null ? Number(l1Now - newest.createdAtBlock) : null;
    const ageSeconds = ageBlocks != null ? ageBlocks * L1_SECONDS_PER_BLOCK : null;
    const hasFast = fastConfirmer && !/^0x0+$/.test(fastConfirmer);
    const soleValidatorIsFast = hasFast && validators.length === 1 && validators[0].toLowerCase() === fastConfirmer.toLowerCase();
    // 466302 uses a Safe as the fast confirmer: each validator approves the confirmation and the
    // threshold-th one executes it. Read the Safe's owners and threshold instead of assuming.
    let safe = null;
    if (hasFast) {
      try {
        const [owners, threshold] = await Promise.all([
          parent.readContract({ address: fastConfirmer, abi: SAFE_ABI, functionName: 'getOwners' }),
          parent.readContract({ address: fastConfirmer, abi: SAFE_ABI, functionName: 'getThreshold' }),
        ]);
        const listed = new Set([...validators, ...VALIDATORS].map((a) => a.toLowerCase()));
        safe = {
          threshold: Number(threshold),
          owners,
          owners_are_validators: owners.length > 0 && owners.every((o) => listed.has(o.toLowerCase())),
        };
      } catch { /* not a Safe: a plain key or some other contract */ }
    }
    const fastKind = !hasFast ? null : safe ? 'safe' : soleValidatorIsFast ? 'sole_validator' : 'single_address';
    const fastOnline = safe
      ? `while ${safe.threshold} of the fast-confirm Safe's ${safe.owners.length} owners are online`
      : 'while the fast confirmer is online';
    const idle = ageSeconds != null && ageSeconds > IDLE_AFTER_SECONDS;
    const afkSeconds = Number(afkBlocks) * L1_SECONDS_PER_BLOCK;
    const confirmedAge = l1Now != null && confirmedNode ? Number(l1Now - confirmedNode.createdAtBlock) : null;

    Object.assign(value, {
      fast_confirmer: hasFast ? fastConfirmer : null,
      fast_confirmer_kind: fastKind,
      fast_confirmer_safe: safe,
      fast_confirmer_matches_deployment: hasFast && FAST_CONFIRM_SAFE ? fastConfirmer.toLowerCase() === FAST_CONFIRM_SAFE.toLowerCase() : null,
      fast_online: fastOnline,
      validators,
      fast_confirmer_is_the_only_validator: soleValidatorIsFast,
      validator_whitelist_disabled: whitelistOff,
      chain_owner: DEPLOY.owner || null,
      last_assertion: {
        hash: newest.hash,
        status: ASSERTION_STATUS[newest.status] || String(newest.status),
        created_at_l1_block: Number(newest.createdAtBlock),
        current_l1_block: l1Now != null ? Number(l1Now) : null,
        age_l1_blocks: ageBlocks,
        age_estimated: ageSeconds != null ? humanDuration(ageSeconds) : 'unknown',
        // Ages use 12 s per Ethereum block; missed slots make real time longer, so these are lower bounds.
        created_at_estimated: ageSeconds != null ? new Date(Number(head.timestamp) * 1000 - ageSeconds * 1000).toISOString() : null,
      },
      validator_idle: idle,
      idle_threshold: humanDuration(IDLE_AFTER_SECONDS),
      validator_whitelist: whitelistOff ? 'disabled: anyone can assert' : 'enabled: only the listed validators can assert',
      validator_afk_blocks: Number(afkBlocks),
      validator_afk: humanDuration(afkSeconds),
      whitelist_lifts_in_about: !whitelistOff && confirmedAge != null
        ? humanDuration(Math.max(0, (Number(afkBlocks) - confirmedAge) * L1_SECONDS_PER_BLOCK))
        : null,
    });

    const owner = DEPLOY.owner ? ` The chain owner key (${DEPLOY.owner}) can also upgrade the rollup contracts and force-confirm an assertion.` : '';
    const fastLine = !hasFast
      ? 'No fast confirmer is set, so every assertion waits the full window.'
      : safe
        ? `The fast confirmer is a ${safe.threshold}-of-${safe.owners.length} Safe (${fastConfirmer}) whose owners are ${safe.owners_are_validators ? 'the xGas validator keys' : `these keys: ${safe.owners.join(', ')}`}. ${fastOnline[0].toUpperCase()}${fastOnline.slice(1)}, an assertion is confirmed right after it is posted, so a withdrawal is usually claimable minutes after the next assertion that covers it. `
          + `That speed is a trust assumption, not a proof: any ${safe.threshold} of those ${safe.owners.length} keys can fast-confirm any assertion, including a wrong one, and a confirmed assertion is final, so nobody can challenge it afterwards.${owner}`
        : `A fast confirmer (${fastConfirmer}) can confirm an assertion immediately, so while it is online a withdrawal is usually claimable minutes after the next assertion that covers it. That one address can confirm any assertion, including a wrong one.${owner}`;
    const downLine = whitelistOff
      ? `Validation is permissionless: the validator whitelist is disabled, so anyone who runs a node and posts the stake can assert and can challenge an assertion that is not yet confirmed. If the xGas validators stop, exits do not depend on them coming back, but someone still has to post an assertion that covers them, and without the fast confirmer it confirms only after the full window of ${humanDuration(contractualSeconds)}.`
      : soleValidatorIsFast
        ? `That fast confirmer is also the only validator, and the whitelist is on, so nobody else can post assertions. If it is down, exits wait on it: nothing is asserted, nothing is confirmed. If the last confirmed assertion ever goes ${humanDuration(afkSeconds)} old (${Number(afkBlocks)} Ethereum blocks), the rollup lets anyone lift the whitelist and assert, and then the full window of ${humanDuration(contractualSeconds)} applies.`
        : `Only the listed validators can assert while the whitelist is on. If the fast confirmer is down, assertions still confirm, but only after the full window of ${humanDuration(contractualSeconds)}.`;
    const idleLine = idle
      ? `Right now the validators appear idle: the newest assertion this connector can see was at least ${humanDuration(ageSeconds)} ago (Ethereum block ${newest.createdAtBlock}). Exits are waiting on an assertion, and no quote here can say when one will be posted.`
      : ageSeconds != null
        ? `The last assertion was about ${humanDuration(ageSeconds)} ago, so the validators look active.`
        : 'Could not tell how long ago the last assertion was.';
    value.summary = `The contractual challenge window is ${humanDuration(contractualSeconds)}: ${Number(confirmBlocks)} Ethereum blocks at about ${L1_SECONDS_PER_BLOCK} s each, counted from the assertion that covers your withdrawal, not from the withdrawal. ${fastLine} ${downLine} ${idleLine}`;
  } catch (e) {
    value.liveness_error = `Could not read the validator and last assertion (${e.shortMessage || e.message}).`;
    value.fast_online = 'while the fast confirmer is online';
    value.summary = `The contractual challenge window is ${humanDuration(contractualSeconds)} (${Number(confirmBlocks)} Ethereum blocks at about ${L1_SECONDS_PER_BLOCK} s each), counted from the assertion that covers your withdrawal. It can be faster if the fast confirmer${FAST_CONFIRM_SAFE ? ` (a Safe of validator keys, ${FAST_CONFIRM_SAFE})` : ''} is online, and that speed rests on trusting its signers. This connector could not check whether the validators are currently asserting.`;
  }
  windowCache = { at: Date.now(), value };
  return value;
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const mins = Math.round(seconds / 60);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d} day${d === 1 ? '' : 's'}`;
  if (h === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${h}h${m ? ` ${m}m` : ''}`;
}


const exitTimeline = (w) => [
  'burned_on_xgas: ArbSys.withdrawEth burns your native $xMoney and emits L2ToL1Tx (minutes)',
  w?.contractual
    ? `asserted: a validator posts an assertion on the parent that covers your withdrawal. This is the slow leg and it has no fixed ETA: it happens only when a validator is running${w.validator_idle ? `, and right now they appear idle (last assertion at least ${w.last_assertion.age_estimated} ago)` : ''}`
    : 'asserted: a validator posts an assertion on the parent that covers your withdrawal; this connector could not read the rollup, so it will not estimate when',
  w?.contractual
    ? `claimable_on_parent: about ${w.contractual} after that assertion (${w.confirm_period_blocks} Ethereum blocks at about ${w.l1_seconds_per_block} s), or usually minutes after it ${w.fast_online || 'while the fast confirmer is online'}`
    : 'claimable_on_parent: after the rollup\'s challenge window, which this connector could not read',
  'outbox_executed: anyone can call Outbox.executeTransaction. You can do it from your own wallet (needs parent gas), or ask the xGas host to do it with claim_exit, which POSTs /api/withdrawals/execute. The host only acts when that request is made; nothing executes it automatically',
  'usdg_redeemed: exitRollup burns the parent xMoney and pays USDG',
];

const enterTimeline = (early) => [
  early
    ? 'minted_and_sent: the parent transaction confirms; EarlyDepositor has pulled your USDG, minted $xMoney from the vault and handed it to the xGas inbox'
    : 'vault_locked: the parent transaction confirms and USDG is in the vault',
  `ticket_created: ${early ? 'EarlyDepositor' : 'the vault'} creates an auto-redeeming retryable ticket to your address on xGas`,
  'landed_on_xgas: ~1 minute later the $xMoney arrives as native gas; unused L3 gas is refunded to you',
];

export const tools = [
  {
    name: 'quote_enter',
    description: 'Quote USDG → $xMoney on xGas: which route deposits take right now (EarlyDepositor until the vault switch, vault.enterRollup after), the USDG rake, the entry burn, the pre-switch inbox transfer tax, the L3 gas, and the $xMoney that lands as native gas. Read-only, nothing is signed.',
    inputSchema: { type: 'object', properties: { usdg_amount: amount('USDG to bridge in, e.g. "250" or "250.50".') }, required: ['usdg_amount'], additionalProperties: false },
    async handler({ usdg_amount }) {
      const q = await enterQuote(parseUsdg(usdg_amount));
      const route = q.route;
      const via = q.early ? `EarlyDepositor ${EARLY_DEPOSITOR}` : q.path === 'vault' ? `vault.enterRollup (${L3.xMoney})` : 'no route (see vault_route)';
      const data = {
        route: q.path,
        via,
        you_pay: `${fmtUsdg(q.usdgWei)} USDG`,
        you_receive: creditLine(q),
        fees: Object.fromEntries(creditFees(q).map((f) => [f.label, `${f.amount}${f.note ? ` (${f.note})` : ''}`])),
        amounts: {
          minted_xmoney: fmtXMoney(q.net),
          inbox_transfer_tax: fmtXMoney(q.inboxTax),
          deposited_to_xgas: fmtXMoney(q.l3Deposit),
          l3_gas_prepay: q.gasPrepay != null ? fmtXMoney(q.gasPrepay) : null,
          guaranteed_credit: q.guaranteed != null ? fmtXMoney(q.guaranteed) : null,
          estimated_credit: q.about != null ? fmtXMoney(q.about) : null,
        },
        vault_state: { usdg_reserve: fmtUsdg(q.usdgReserve), circulating_xmoney: fmtXMoney(q.circulating) },
        eta: '~1 minute to land on xGas',
        vault_route: route,
        deposits_paused: DEPOSITS_PAUSED,
        smart_account_warning: ALIAS_WARNING,
        raw: {
          net_minted_wei: q.net, l3_deposit_wei: q.l3Deposit, guaranteed_wei: q.guaranteed, estimated_wei: q.about,
          gross_wei: q.gross, usdg_rake_raw: q.usdgRake,
        },
      };
      return reply(
        `Pay ${fmtUsdg(q.usdgWei)} USDG → receive ${creditLine(q)}, ~1 minute. Route: ${via}.\n`
          + `Fees: ${fmtUsdg(q.usdgRake)} USDG to the Fanout, ${fmtXMoney(q.entryBurn)} xMoney entry burn`
          + (q.early ? `, ${fmtXMoney(q.inboxTax)} xMoney transfer tax into the inbox (until the vault switch)` : '')
          + `, and the L3 gas for the auto-redeem${q.redeemFee != null ? ` (about ${fmtXMoney(q.redeemFee)})` : ''}.\n`
          + 'You arrive holding gas; there is no faucet step.'
          + (q.path == null ? `\nNot open right now: ${route.note}` : q.early ? `\n${route.note}` : '')
          + (DEPOSITS_PAUSED ? `\n${DEPOSITS_PAUSED_MSG}` : '')
          + '\nBridge through prepare_enter (it names the recipient explicitly), not a direct inbox deposit: from a smart account or EIP-7702 wallet a direct deposit lands at an aliased address.',
        data,
      );
    },
  },

  {
    name: 'prepare_enter',
    description: 'Prepare the unsigned transactions for USDG → $xMoney. Until the XMoney vault\'s timelocked switch to this chain\'s inbox, that is USDG.approve(EarlyDepositor, exact amount) then EarlyDepositor.deposit(amount, recipient); after it, USDG.approve(vault) then vault.enterRollup(amount, recipient). The approve is skipped when allowance already covers the amount. Both name the recipient explicitly (safe from smart accounts and EIP-7702 wallets, unlike a direct inbox deposit). Refuses when no route reaches this chain. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        usdg_amount: amount('USDG to bridge in.'),
        from: { ...addr, description: 'The address that will sign and hold the USDG.' },
        l3_recipient: { ...addr, description: 'Who receives $xMoney on xGas. Defaults to `from`. Must be an EOA or an EIP-7702 delegated EOA: a contract wallet address (Safe or similar) has no key on xGas, and EarlyDepositor rejects it.' },
      },
      required: ['usdg_amount', 'from'],
      additionalProperties: false,
    },
    async handler({ usdg_amount, from, l3_recipient }) {
      if (DEPOSITS_PAUSED) throw new Error(DEPOSITS_PAUSED_MSG);
      if (!isAddress(from)) throw new Error(`from is not an address: ${from}`);
      const explicitRecipient = !!(l3_recipient && l3_recipient !== ZERO);
      const recipient = explicitRecipient ? l3_recipient : from;
      if (!isAddress(recipient)) throw new Error(`l3_recipient is not an address: ${l3_recipient}`);
      const usdgWei = parseUsdg(usdg_amount);

      const route = await vaultRoute();
      if (route.path == null) {
        return reply(`Nothing prepared. ${route.note}`, { blocked: 'no_route_to_this_chain', ...route });
      }
      const early = route.path === 'early_depositor';
      const spender = early ? EARLY_DEPOSITOR : L3.xMoney;

      const [balance, allowance, fromKind, recipientKind] = await Promise.all([
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'balanceOf', args: [from] }),
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'allowance', args: [from, spender] }),
        accountKind(from),
        explicitRecipient ? accountKind(recipient) : null,
      ]);
      const rKind = explicitRecipient ? recipientKind : fromKind;
      if (fromKind === 'contract' && !explicitRecipient) {
        return reply(
          `Nothing prepared. ${from} is a contract wallet on the parent chain, and the same address on xGas is not necessarily controlled by you. Pass l3_recipient explicitly (an EOA you control on xGas).`,
          { blocked: 'contract_sender_needs_explicit_recipient', from, from_kind: fromKind },
        );
      }
      if (early && rKind === 'contract') {
        return reply(
          `Nothing prepared. ${recipient} is a contract on the parent chain (not an EOA or an EIP-7702 delegated EOA). EarlyDepositor rejects it (RecipientIsContract), because a contract address has no key on xGas and funds sent there would be unreachable. Pass an EOA you control as l3_recipient.`,
          { blocked: 'recipient_is_contract', recipient, recipient_kind: rKind },
        );
      }
      if (rKind === 'unknown') {
        return reply(`Nothing prepared. Could not read ${recipient}'s code on the parent chain, so this connector cannot tell whether it is a contract that has no key on xGas. Retry.`,
          { blocked: 'recipient_kind_unknown', recipient });
      }
      if (balance < usdgWei) {
        return reply(`${from} holds ${fmtUsdg(balance)} USDG on the parent chain but this enter needs ${fmtUsdg(usdgWei)}. Nothing prepared.`,
          { blocked: 'insufficient_usdg', holds: fmtUsdg(balance), needs: fmtUsdg(usdgWei) });
      }

      const q = await enterQuote(usdgWei, route);
      if (q.tooSmall) {
        return reply(`Nothing prepared. ${fmtUsdg(usdgWei)} USDG deposits ${fmtXMoney(q.l3Deposit)} xMoney, which does not cover the L3 gas prepayment of ${fmtXMoney(q.gasPrepay)}; the deposit would revert. Deposit more.`,
          { blocked: 'deposit_too_small', l3_deposit: fmtXMoney(q.l3Deposit), gas_prepay: fmtXMoney(q.gasPrepay) });
      }
      // Through the vault, the Inbox aliases the refund addresses of a recipient with code; EarlyDepositor never does.
      const refundAliased = !early && ['eip7702', 'contract'].includes(rKind);

      const steps = [];
      if (allowance < usdgWei) {
        steps.push({
          label: `Approve ${early ? 'EarlyDepositor' : 'the vault'} to spend exactly ${fmtUsdg(usdgWei)} USDG`,
          chainId: PARENT_CHAIN_ID,
          to: L3.usdg,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, usdgWei] }),
          value: 0n,
        });
      }
      steps.push(early
        ? {
          label: `EarlyDepositor.deposit ${fmtUsdg(usdgWei)} USDG to ${recipient} on xGas ${XGAS_CHAIN_ID}`,
          chainId: PARENT_CHAIN_ID,
          to: EARLY_DEPOSITOR,
          data: encodeFunctionData({ abi: EARLY_DEPOSITOR_ABI, functionName: 'deposit', args: [usdgWei, recipient] }),
          value: 0n,
        }
        : {
          label: `enterRollup ${fmtUsdg(usdgWei)} USDG to ${recipient}`,
          chainId: PARENT_CHAIN_ID,
          to: L3.xMoney,
          data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'enterRollup', args: [usdgWei, recipient] }),
          value: 0n,
        });

      const p = prepared({
        action: 'Bridge in: USDG → $xMoney on xGas L4',
        asset: 'USDG (parent chain) → native $xMoney (xGas L4)',
        amount: `${fmtUsdg(usdgWei)} USDG in`,
        counterparty: early
          ? `EarlyDepositor ${EARLY_DEPOSITOR} (no owner, holds nothing between calls), minting from the XMoney vault ${L3.xMoney}`
          : `XMoney vault ${L3.xMoney}`,
        fees: creditFees(q),
        net: creditLine(q, { refundAliased }),
        timeline: enterTimeline(early),
        irreversible: `${early ? 'EarlyDepositor.deposit' : 'enterRollup'} locks your USDG in the vault. Getting it back means the full exit path (withdraw on xGas, wait for the assertion window on the parent, execute the Outbox, then exitRollup).`,
        notes: [
          allowance < usdgWei
            ? `Two signatures: the approve (exact amount, not unlimited) must confirm before ${early ? 'deposit' : 'enterRollup'} is sent.`
            : 'Allowance is already sufficient; one signature.',
          ...(early ? [route.note, 'EarlyDepositor sends the minted $xMoney to the xGas inbox; until the vault switch that transfer pays the 0.01% xMoney tax, shown in the fees.'] : []),
          `The $xMoney is credited to ${recipient} on xGas ${XGAS_CHAIN_ID}: ${early ? 'EarlyDepositor' : 'enterRollup'} names it as the ticket destination, so the deposit itself is not aliased.`,
          ...(fromKind === 'eip7702' ? [`${from} is an EIP-7702 delegated account. ${ALIAS_WARNING}`] : []),
          ...(early && rKind === 'eip7702'
            ? [`${recipient} is an EIP-7702 delegated account. EarlyDepositor opens the ticket with unaliased refund addresses, so the gas refund also goes to ${recipient}, which the same key controls on xGas.`]
            : []),
          ...(refundAliased
            ? [`${recipient} has code on the parent chain, so the Inbox aliases the ticket's refund addresses: the small unused-gas refund goes to the aliased address, and if the auto-redeem ever fails only the aliased address can cancel the ticket. Anyone can still redeem it, which delivers to ${recipient}.`]
            : []),
        ],
        steps,
      });
      p.route = route.path;
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_enter',
    description: 'Broadcast the signed enter transactions in order (approve, then EarlyDepositor.deposit or vault.enterRollup, as prepare_enter returned them). The idempotency key makes a retry return the first result instead of sending twice.',
    inputSchema: {
      type: 'object',
      properties: {
        signed_txs: { type: 'array', items: { type: 'string' }, description: 'Raw signed transactions from your wallet, in the order prepare_enter returned them.' },
        idempotency_key: { type: 'string' },
      },
      required: ['signed_txs', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ signed_txs, idempotency_key }) {
      if (DEPOSITS_PAUSED) throw new Error(DEPOSITS_PAUSED_MSG);
      const res = await submitBatch({ chainId: PARENT_CHAIN_ID, signedTxs: signed_txs, idempotencyKey: idempotency_key, kind: 'enter' });
      const last = res.hash;
      return reply(
        res.replayed
          ? `Already submitted under this key; no second transaction was sent. Parent tx ${last}.`
          : `Sent. Parent tx ${last}. Track it with get_enter_status.`,
        res,
      );
    },
  },

  {
    name: 'get_enter_status',
    description: 'Where a USDG → $xMoney bridge-in stands: vault_locked, ticket_created, landed_on_xgas. Reads both routes (EarlyDepositor.deposit and vault.enterRollup). Pass the recipient balance you recorded before entering to get proof of landing rather than a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'The deposit (EarlyDepositor.deposit or enterRollup) transaction hash on the parent chain.' },
        balance_before_wei: { type: 'string', description: "Optional: the recipient's xGas balance in wei just before entering. Without it the connector reports the ticket but will not claim the funds landed." },
      },
      required: ['tx_hash'],
      additionalProperties: false,
    },
    async handler({ tx_hash, balance_before_wei }) {
      let receipt;
      try { receipt = await parent.getTransactionReceipt({ hash: tx_hash }); }
      catch { return reply(`No receipt for ${tx_hash} on the parent chain yet. It is still pending or the hash is wrong.`, { status: 'pending_inclusion', tx_hash }); }
      if (receipt.status !== 'success') return reply(`Parent tx ${tx_hash} reverted. No USDG was locked.`, { status: 'reverted', tx_hash });

      let entered = null;
      let early = null;
      for (const log of receipt.logs) {
        const at = log.address.toLowerCase();
        try {
          if (at === EARLY_DEPOSITOR.toLowerCase()) {
            const d = decodeEventLog({ abi: EARLY_DEPOSITOR_ABI, data: log.data, topics: log.topics });
            if (d.eventName === 'EarlyDeposit') early = d.args;
          } else if (at === L3.xMoney.toLowerCase()) {
            const d = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
            if (d.eventName === 'RollupEntered') entered = d.args;
          }
        } catch { /* not our event */ }
      }
      // An EarlyDepositor tx also carries the vault's RollupEntered, but that one names the helper as recipient.
      const norm = early
        ? {
          route: 'early_depositor', recipient: early.l3Recipient, expected: early.l2CallValue, ticket: early.ticketId,
          usdg_in: fmtUsdg(early.usdgIn), minted: fmtXMoney(early.xMoneyMinted), deposited: fmtXMoney(early.l3Deposit),
          raked: entered ? fmtUsdg(entered.usdgRaked) : null, burned: entered ? fmtXMoney(entered.xMoneyBurned) : null,
          ticketed: true,
        }
        : entered
          ? {
            route: 'vault', recipient: entered.l3Recipient, expected: entered.xMoneyBridged, ticket: entered.retryableTicketId,
            usdg_in: fmtUsdg(entered.usdgIn), minted: null, deposited: null,
            raked: fmtUsdg(entered.usdgRaked), burned: fmtXMoney(entered.xMoneyBurned),
            ticketed: !!(entered.retryableTicketId && entered.retryableTicketId !== 0n),
          }
          : null;
      if (!norm) return reply(`Parent tx ${tx_hash} succeeded but carries neither an EarlyDeposit nor a RollupEntered event, so it is not a deposit.`, { status: 'not_an_enter', tx_hash });

      const live = await xgas.getBalance({ address: norm.recipient });
      const before = balance_before_wei ? BigInt(balance_before_wei) : null;
      const landed = before !== null && live - before >= norm.expected;
      const status = norm.ticketed ? (landed ? 'landed_on_xgas' : 'ticket_created') : 'vault_locked';
      const data = {
        status,
        route: norm.route,
        tx_hash,
        recipient: norm.recipient,
        usdg_in: norm.usdg_in,
        xmoney_minted: norm.minted,
        xmoney_deposited_to_xgas: norm.deposited,
        xmoney_bridged_call_value: fmtXMoney(norm.expected),
        usdg_raked: norm.raked,
        xmoney_burned: norm.burned,
        retryable_ticket_id: norm.ticket,
        recipient_xgas_balance: fmtXMoney(live),
        proof: before === null
          ? 'No balance_before_wei was given, so landing is unverified. Call again with the pre-enter balance, or just check get_balance.'
          : landed ? `Balance rose by at least ${fmtXMoney(norm.expected)}.` : 'Balance has not risen by the bridged amount yet; the auto-redeem usually takes about a minute.',
      };
      return reply(`${status}: ${norm.usdg_in} USDG in via ${norm.route === 'early_depositor' ? 'EarlyDepositor' : 'the vault'}, at least ${fmtXMoney(norm.expected)} $xMoney to ${norm.recipient}. ${data.proof}`, data);
    },
  },

  {
    name: 'quote_exit',
    description: 'Quote $xMoney on xGas → USDG on the parent chain, end to end: the bridge-exit burn, the NAV redemption, the USDG rake, the contractual challenge window in Ethereum blocks, who can fast-confirm (a Safe of validator keys on 466302) and what that trusts, and whether the validators are currently asserting. Read-only.',
    inputSchema: { type: 'object', properties: { xmoney_amount: amount('Native $xMoney to withdraw, e.g. "25".') }, required: ['xmoney_amount'], additionalProperties: false },
    async handler({ xmoney_amount }) {
      const [m, w] = await Promise.all([exitMath(parseXMoney(xmoney_amount)), assertionWindow()]);
      const data = {
        you_burn: `${fmtXMoney(m.xWei)} $xMoney on xGas`,
        you_receive: `${fmtUsdg(m.usdgOut)} USDG on the parent chain`,
        fees: {
          bridge_exit_transfer_burn: `${fmtXMoney(m.bridgeExitBurn)} xMoney (0.01%, charged when the Outbox pays out of the bridge)`,
          usdg_rake_to_fanout: `${fmtUsdg(m.usdgRake)} USDG (0.01% on exitRollup)`,
        },
        arrives_on_parent_as_erc20: fmtXMoney(m.arrivesOnParent),
        assertion_window: w,
        timeline: exitTimeline(w),
        honesty: w.summary
          ? `${w.summary} If you want dollars today rather than whenever a validator asserts and the assertion confirms, quote the OTC route with ramp_quote instead.`
          : `${w.error || 'The exit wait could not be read.'} If you want dollars today, quote the OTC route with ramp_quote instead.`,
        raw: { usdg_out_raw: m.usdgOut, gross_raw: m.gross },
      };
      return reply(
        `Burn ${fmtXMoney(m.xWei)} $xMoney → ${fmtUsdg(m.usdgOut)} USDG on the parent chain.\n` +
        `Fees: ${fmtXMoney(m.bridgeExitBurn)} xMoney burned on the way out of the bridge, then ${fmtUsdg(m.usdgRake)} USDG raked on redemption.\n` +
        (w.contractual
          ? `Timing: the contractual window is ${w.contractual} (${w.confirm_period_blocks} Ethereum blocks) after an assertion covering your withdrawal is posted. It is usually minutes after the next assertion ${w.fast_online || 'while the fast confirmer is online'}.` +
            (w.fast_confirmer_safe
              ? ` That fast path trusts the Safe: any ${w.fast_confirmer_safe.threshold} of its ${w.fast_confirmer_safe.owners.length} keys can confirm, and a confirmed assertion is final.`
              : '') +
            (w.validator_whitelist_disabled ? ' Validation is permissionless, so anyone can assert if the xGas validators stop.' : '') +
            (w.validator_idle
              ? `\nWarning: the validators appear idle. The last assertion was at least ${w.last_assertion.age_estimated} ago, and exits are waiting on one. There is no ETA until one is posted.`
              : w.last_assertion ? ` Last assertion: about ${w.last_assertion.age_estimated} ago.` : '')
          : `Timing: unknown. ${w.error || ''}`) +
        `\nAfter it is claimable, someone has to execute it on the Outbox: you from your own wallet, or the xGas host if you ask with claim_exit.`,
        data,
      );
    },
  },

  {
    name: 'prepare_exit',
    description: 'Prepare the unsigned ArbSys.withdrawEth on xGas, leg 1 of $xMoney → USDG. You sign it with the gas you already hold. Signs nothing here.',
    inputSchema: {
      type: 'object',
      properties: {
        xmoney_amount: amount('Native $xMoney to withdraw.'),
        destination: { ...addr, description: 'Parent-chain address to receive the xMoney ERC-20. Usually your own.' },
      },
      required: ['xmoney_amount', 'destination'],
      additionalProperties: false,
    },
    async handler({ xmoney_amount, destination }) {
      if (!isAddress(destination)) throw new Error(`destination is not an address: ${destination}`);
      const xWei = parseXMoney(xmoney_amount);
      const [m, w] = await Promise.all([exitMath(xWei), assertionWindow()]);
      const p = prepared({
        action: 'Bridge out, leg 1: burn $xMoney on xGas (ArbSys.withdrawEth)',
        chainId: XGAS_CHAIN_ID,
        to: L4.arbSys,
        data: encodeFunctionData({ abi: ARBSYS_ABI, functionName: 'withdrawEth', args: [destination] }),
        value: xWei,
        asset: 'native $xMoney on xGas L4',
        amount: `${fmtXMoney(xWei)} $xMoney`,
        counterparty: `ArbSys ${L4.arbSys} → ${destination} on the parent chain`,
        fees: [
          { label: 'xGas gas', amount: 'paid in the $xMoney you already hold' },
          { label: 'Bridge-exit transfer burn', amount: `${fmtXMoney(m.bridgeExitBurn)} xMoney`, note: '0.01%, charged later when the Outbox pays out' },
        ],
        net: `${fmtXMoney(m.arrivesOnParent)} xMoney (ERC-20) on the parent chain, redeemable for about ${fmtUsdg(m.usdgOut)} USDG via exitRollup`,
        timeline: exitTimeline(w),
        irreversible: `This burns your $xMoney on xGas immediately. The funds are unreachable until an assertion covering the withdrawal is posted and confirmed on the parent chain. There is no cancel and no way to speed it up.${w.validator_idle ? ` The validators appear idle right now (last assertion at least ${w.last_assertion.age_estimated} ago), so this withdrawal will wait until one is posted.` : ''}`,
        notes: ['After this lands, use get_exit_status to watch it. Once it is claimable, execute it on the Outbox yourself or ask the host to with claim_exit; nothing claims it automatically.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_exit',
    description: 'Broadcast the signed ArbSys withdrawal on xGas.',
    inputSchema: {
      type: 'object',
      properties: { ...submitFields },
      required: ['signed_tx', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ signed_tx, idempotency_key }) {
      const res = await submitRaw({ chainId: XGAS_CHAIN_ID, signedTx: signed_tx, idempotencyKey: idempotency_key, kind: 'exit' });
      return reply(res.replayed ? `Already submitted under this key: ${res.hash}.` : `Sent on xGas: ${res.hash}. Watch it with get_exit_status.`, res);
    },
  },

  {
    name: 'get_exit_status',
    description: 'Every $xMoney → parent withdrawal for an address, with its stage: pending (waiting on an assertion), claimable, or executed. Read-only.',
    inputSchema: { type: 'object', properties: { address: { ...addr, description: 'The address that withdrew, or the destination.' } }, required: ['address'], additionalProperties: false },
    async handler({ address }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      try {
        const res = await fetch(`${XGAS_API}/api/withdrawals/${address}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`host returned ${res.status}`);
        const body = await res.json();
        const ws = body.withdrawals || [];
        if (!ws.length) return reply(`No withdrawals found for ${address}.`, { ...body, address });
        const win = await assertionWindow();
        // The host tracks the retired chain too; its entries carry chainId and legacy: true. Positions restart per
        // chain, so pass chain_id to claim_exit for a legacy one.
        const lines = ws.map((w) => `  #${w.position}${w.legacy ? ` (retired chain ${w.chainId})` : ''} ${w.amount} xMoney → ${w.destination}: ${w.status}${w.executedTx ? ` (executed ${w.executedTx})` : ''}`);
        const pending = ws.filter((w) => w.status === 'pending' && !w.legacy).length;
        const legacyPending = ws.filter((w) => w.status === 'pending' && w.legacy).length;
        return reply(
          `${ws.length} withdrawal(s) for ${address}:\n${lines.join('\n')}\n` +
          `Confirmed sends on the parent: ${body.confirmedSendCount}. "Claim for me" is ${body.executorEnabled ? 'available' : 'not configured on the host, so claim from your own wallet'}.` +
          (pending && win.contractual
            ? `\nThe ${pending} pending one(s) wait on an assertion that covers them, then about ${win.contractual} (usually minutes ${win.fast_online || 'while the fast confirmer is online'}).` +
              (win.validator_idle ? ` The validators appear idle (last assertion at least ${win.last_assertion.age_estimated} ago), so they are waiting on an assertion.` : '')
            : '') +
          (legacyPending ? `\n${legacyPending} pending withdrawal(s) are on the retired chain; they confirm on its own rollup, and the estimate above does not apply to them.` : ''),
          { ...body, address, assertion_window: win },
        );
      } catch (e) {
        // The host tracks these; without it, say so rather than invent a state machine.
        return reply(
          `Could not reach the xGas host's withdrawal tracker (${e.message}). The Outbox itself is still readable: pass a position to check isSpent directly, or retry.`,
          { status: 'tracker_unreachable', address, outbox: L3.outbox },
        );
      }
    },
  },

  {
    name: 'claim_exit',
    description: 'Ask the xGas host to execute a claimable withdrawal on the Outbox for you by POSTing /api/withdrawals/execute. The host acts only on this request, never on its own. Outbox execution is permissionless, so you can also do it from your own wallet with parent gas. Fails loudly if the assertion has not confirmed yet.',
    inputSchema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'The xGas withdrawal transaction hash.' },
        position: { type: 'string', description: 'The L2ToL1Tx position, as shown by get_exit_status.' },
        chain_id: { type: 'number', description: `Optional: the chain the withdrawal was made on. Defaults to any tracked chain; pass it for a withdrawal on the retired chain (${LEGACY?.chainId ?? 'legacy'}), since positions restart per chain.` },
      },
      additionalProperties: false,
    },
    async handler({ tx_hash, position, chain_id }) {
      if (!tx_hash && !position) throw new Error('Give a tx_hash or a position.');
      const res = await fetch(`${XGAS_API}/api/withdrawals/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: tx_hash, position, ...(chain_id != null && { chainId: chain_id }) }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return reply(`The host would not execute it: ${body.error || res.status}${body.status ? ` (status ${body.status})` : ''}.`, body);
      return reply(body.alreadyExecuted ? 'Already executed. Your xMoney is on the parent chain.' : `Executed on the Outbox: ${body.txHash}. Your xMoney (ERC-20) is on the parent chain; redeem it with prepare_redeem.`, body);
    },
  },

  {
    name: 'prepare_redeem',
    description: 'Prepare the unsigned exitRollup on the parent chain, the last leg: burn parent xMoney, receive USDG at NAV minus the 0.01% rake.',
    inputSchema: {
      type: 'object',
      properties: {
        xmoney_amount: amount('Parent-chain xMoney (ERC-20) to redeem.'),
        from: { ...addr, description: 'The address holding it.' },
      },
      required: ['xmoney_amount', 'from'],
      additionalProperties: false,
    },
    async handler({ xmoney_amount, from }) {
      if (!isAddress(from)) throw new Error(`from is not an address: ${from}`);
      const xWei = parseXMoney(xmoney_amount);
      const held = await parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [from] });
      if (held < xWei) {
        return reply(`${from} holds ${fmtXMoney(held)} xMoney on the parent chain, short of the ${fmtXMoney(xWei)} you asked to redeem. Nothing prepared.`,
          { blocked: 'insufficient_xmoney', holds: fmtXMoney(held), needs: fmtXMoney(xWei) });
      }
      const [, usdgReserve, circulating] = await parent.readContract({ address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV' });
      const gross = circulating === 0n ? 0n : (xWei * usdgReserve) / circulating;
      const rake = (gross * FANOUT_RAKE_BPS) / BPS;
      const out = gross - rake;

      const p = prepared({
        action: 'Redeem: parent xMoney → USDG (exitRollup)',
        chainId: PARENT_CHAIN_ID,
        to: L3.xMoney,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'exitRollup', args: [xWei] }),
        value: 0n,
        asset: 'xMoney (ERC-20, parent) → USDG',
        amount: `${fmtXMoney(xWei)} xMoney burned`,
        counterparty: `XMoney vault ${L3.xMoney}`,
        fees: [{ label: 'USDG rake to the Fanout', amount: `${fmtUsdg(rake)} USDG`, note: '0.01%' }],
        net: `${fmtUsdg(out)} USDG`,
        timeline: ['One parent-chain transaction. USDG lands in the same transaction.'],
        irreversible: 'Your xMoney is burned. USDG is not dollars in a bank; redeeming USDG for fiat is a separate off-chain step (Paxos redemption or a venue that buys it).',
        notes: ['exitRollup burns from your balance directly, so no approval is needed.'],
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_redeem',
    description: 'Broadcast the signed exitRollup on the parent chain.',
    inputSchema: {
      type: 'object',
      properties: { ...submitFields },
      required: ['signed_tx', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ signed_tx, idempotency_key }) {
      const res = await submitRaw({ chainId: PARENT_CHAIN_ID, signedTx: signed_tx, idempotencyKey: idempotency_key, kind: 'redeem' });
      return reply(res.replayed ? `Already submitted under this key: ${res.hash}.` : `Sent on the parent chain: ${res.hash}.`, res);
    },
  },
];

export { enterMath, enterQuote, exitMath, vaultRoute };
