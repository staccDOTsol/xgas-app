import { encodeFunctionData, decodeEventLog, isAddress, parseAbi } from 'viem';
import {
  L3, L4, PARENT_CHAIN_ID, XGAS_CHAIN_ID, XGAS_API, parent, xgas, ZERO,
  BURN_BPS, FANOUT_RAKE_BPS, SCALE_FACTOR,
} from '../config.mjs';
import { ERC20_ABI, VAULT_ABI, ARBSYS_ABI } from '../abis.mjs';
import { fmtUsdg, fmtXMoney, parseUsdg, parseXMoney } from '../money.mjs';
import { prepared, renderApproval, reply, submitFields } from '../approval.mjs';
import { submitBatch, submitRaw } from '../idempotency.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };
const amount = (d) => ({ type: 'string', description: d });
const BPS = 10000n;
// Deposits are paused while xgas moves to a new chain (exits here wait on a stalled validator). Set
// XGAS_DEPOSITS_PAUSED=0 to re-enable once the vault points at the new chain.
const DEPOSITS_PAUSED = process.env.XGAS_DEPOSITS_PAUSED !== '0';
const DEPOSITS_PAUSED_MSG = 'Deposits are paused while xgas moves to a new chain. Exits on this chain are waiting on a stalled validator, so no new money should go in. Existing holders are being refunded in USDG by the founder.';

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
    const idle = ageSeconds != null && ageSeconds > IDLE_AFTER_SECONDS;
    const afkSeconds = Number(afkBlocks) * L1_SECONDS_PER_BLOCK;
    const confirmedAge = l1Now != null && confirmedNode ? Number(l1Now - confirmedNode.createdAtBlock) : null;

    Object.assign(value, {
      fast_confirmer: hasFast ? fastConfirmer : null,
      validators,
      fast_confirmer_is_the_only_validator: soleValidatorIsFast,
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

    const fastLine = hasFast
      ? `A fast confirmer (${fastConfirmer}) can confirm an assertion immediately, so while it is online a withdrawal is usually claimable minutes after the next assertion that covers it.`
      : 'No fast confirmer is set, so every assertion waits the full window.';
    const downLine = soleValidatorIsFast
      ? `That fast confirmer is also the only validator, and the whitelist is on, so nobody else can post assertions. If it is down, exits wait on it: nothing is asserted, nothing is confirmed. If the last confirmed assertion ever goes ${humanDuration(afkSeconds)} old (${Number(afkBlocks)} Ethereum blocks), the rollup lets anyone lift the whitelist and assert, and then the full window of ${humanDuration(contractualSeconds)} applies.`
      : 'If the fast confirmer is down, assertions still confirm, but only after the full window.';
    const idleLine = idle
      ? `Right now the validator appears idle: its last assertion was at least ${humanDuration(ageSeconds)} ago (Ethereum block ${newest.createdAtBlock}). Exits are waiting on it, and no quote here can say when it will resume.`
      : ageSeconds != null
        ? `The last assertion was about ${humanDuration(ageSeconds)} ago, so the validator looks active.`
        : 'Could not tell how long ago the last assertion was.';
    value.summary = `The contractual challenge window is ${humanDuration(contractualSeconds)}: ${Number(confirmBlocks)} Ethereum blocks at about ${L1_SECONDS_PER_BLOCK} s each, counted from the assertion that covers your withdrawal, not from the withdrawal. ${fastLine} ${downLine} ${idleLine}`;
  } catch (e) {
    value.liveness_error = `Could not read the validator and last assertion (${e.shortMessage || e.message}).`;
    value.summary = `The contractual challenge window is ${humanDuration(contractualSeconds)} (${Number(confirmBlocks)} Ethereum blocks at about ${L1_SECONDS_PER_BLOCK} s each), counted from the assertion that covers your withdrawal. It can be faster if the fast confirmer is online. This connector could not check whether the validator is currently asserting.`;
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

const ENTER_TIMELINE = [
  'vault_locked: the parent transaction confirms and USDG is in the vault',
  'ticket_created: the vault creates an auto-redeeming retryable ticket to your address on xGas',
  'landed_on_xgas: ~1 minute later the $xMoney arrives as native gas; excess L4 gas is refunded to you',
];

const exitTimeline = (w) => [
  'burned_on_xgas: ArbSys.withdrawEth burns your native $xMoney and emits L2ToL1Tx (minutes)',
  w?.contractual
    ? `asserted: the validator posts an assertion on the parent that covers your withdrawal. This is the slow leg and it has no fixed ETA: it happens only when the validator is running${w.validator_idle ? `, and right now it appears idle (last assertion at least ${w.last_assertion.age_estimated} ago)` : ''}`
    : 'asserted: the validator posts an assertion on the parent that covers your withdrawal; this connector could not read the rollup, so it will not estimate when',
  w?.contractual
    ? `claimable_on_parent: about ${w.contractual} after that assertion (${w.confirm_period_blocks} Ethereum blocks at about ${w.l1_seconds_per_block} s), or usually minutes after it while the fast confirmer is online`
    : 'claimable_on_parent: after the rollup\'s challenge window, which this connector could not read',
  'outbox_executed: anyone can call Outbox.executeTransaction. You can do it from your own wallet (needs parent gas), or ask the xGas host to do it with claim_exit, which POSTs /api/withdrawals/execute. The host only acts when that request is made; nothing executes it automatically',
  'usdg_redeemed: exitRollup burns the parent xMoney and pays USDG',
];

export const tools = [
  {
    name: 'quote_enter',
    description: 'Quote USDG → $xMoney on xGas: the USDG rake, the entry burn and its split, and the net $xMoney that lands as native gas. Read-only, nothing is signed.',
    inputSchema: { type: 'object', properties: { usdg_amount: amount('USDG to bridge in, e.g. "250" or "250.50".') }, required: ['usdg_amount'], additionalProperties: false },
    async handler({ usdg_amount }) {
      const m = await enterMath(parseUsdg(usdg_amount));
      const data = {
        you_pay: `${fmtUsdg(m.usdgWei)} USDG`,
        you_receive: `${fmtXMoney(m.net)} $xMoney on xGas L4 (native gas)`,
        fees: {
          usdg_rake_to_fanout: `${fmtUsdg(m.usdgRake)} USDG (0.01%)`,
          xmoney_entry_burn: `${fmtXMoney(m.entryBurn)} xMoney (0.01%)`,
          burn_to_dead: fmtXMoney(m.burnToDead),
          minted_to_bridge_as_buffer: fmtXMoney(m.bufferToBridge),
        },
        vault_state: { usdg_reserve: fmtUsdg(m.usdgReserve), circulating_xmoney: fmtXMoney(m.circulating) },
        eta: '~1 minute to land on xGas',
        raw: { net_wei: m.net, gross_wei: m.gross, usdg_rake_raw: m.usdgRake },
      };
      return reply(
        `Pay ${fmtUsdg(m.usdgWei)} USDG → receive ${fmtXMoney(m.net)} $xMoney as native gas on xGas L4, ~1 minute.\nFees: ${fmtUsdg(m.usdgRake)} USDG to the Fanout, ${fmtXMoney(m.entryBurn)} xMoney entry burn (${fmtXMoney(m.burnToDead)} dead, ${fmtXMoney(m.bufferToBridge)} to the bridge buffer).\nYou arrive holding gas; there is no faucet step.`,
        data,
      );
    },
  },

  {
    name: 'prepare_enter',
    description: 'Prepare the unsigned transactions for USDG → $xMoney. Returns an ERC-20 approve first when allowance is short, then enterRollup. Signs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        usdg_amount: amount('USDG to bridge in.'),
        from: { ...addr, description: 'The address that will sign and hold the USDG.' },
        l3_recipient: { ...addr, description: 'Who receives $xMoney on xGas. Defaults to `from`.' },
      },
      required: ['usdg_amount', 'from'],
      additionalProperties: false,
    },
    async handler({ usdg_amount, from, l3_recipient }) {
      if (DEPOSITS_PAUSED) throw new Error(DEPOSITS_PAUSED_MSG);
      if (!isAddress(from)) throw new Error(`from is not an address: ${from}`);
      const recipient = l3_recipient && l3_recipient !== ZERO ? l3_recipient : from;
      if (!isAddress(recipient)) throw new Error(`l3_recipient is not an address: ${l3_recipient}`);
      const usdgWei = parseUsdg(usdg_amount);

      const [balance, allowance] = await Promise.all([
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'balanceOf', args: [from] }),
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'allowance', args: [from, L3.xMoney] }),
      ]);
      if (balance < usdgWei) {
        return reply(`${from} holds ${fmtUsdg(balance)} USDG on the parent chain but this enter needs ${fmtUsdg(usdgWei)}. Nothing prepared.`,
          { blocked: 'insufficient_usdg', holds: fmtUsdg(balance), needs: fmtUsdg(usdgWei) });
      }

      const m = await enterMath(usdgWei);
      const steps = [];
      if (allowance < usdgWei) {
        steps.push({
          label: `Approve the vault to spend ${fmtUsdg(usdgWei)} USDG`,
          chainId: PARENT_CHAIN_ID,
          to: L3.usdg,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [L3.xMoney, usdgWei] }),
          value: 0n,
        });
      }
      steps.push({
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
        counterparty: `XMoney vault ${L3.xMoney}`,
        fees: [
          { label: 'USDG rake to the Fanout', amount: `${fmtUsdg(m.usdgRake)} USDG`, note: '0.01%' },
          { label: 'xMoney entry burn', amount: `${fmtXMoney(m.entryBurn)} xMoney`, note: `0.01%: ${fmtXMoney(m.burnToDead)} to 0x…dEaD, ${fmtXMoney(m.bufferToBridge)} minted to the bridge as solvency buffer` },
        ],
        net: `${fmtXMoney(m.net)} $xMoney as native gas on xGas L4`,
        timeline: ENTER_TIMELINE,
        irreversible: 'enterRollup locks your USDG in the vault. Getting it back means the full exit path (withdraw on xGas, wait for the assertion window on the parent, execute the Outbox, then exitRollup).',
        notes: allowance < usdgWei
          ? ['Two signatures: the approve must confirm before enterRollup is sent.']
          : ['Allowance is already sufficient; one signature.'],
        steps,
      });
      return reply(renderApproval(p), p);
    },
  },

  {
    name: 'submit_enter',
    description: 'Broadcast the signed enter transactions in order (approve, then enterRollup). The idempotency key makes a retry return the first result instead of sending twice.',
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
    description: 'Where a USDG → $xMoney bridge-in stands: vault_locked, ticket_created, landed_on_xgas. Pass the recipient balance you recorded before entering to get proof of landing rather than a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'The enterRollup transaction hash on the parent chain.' },
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
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== L3.xMoney.toLowerCase()) continue;
        try {
          const d = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
          if (d.eventName === 'RollupEntered') entered = d.args;
        } catch { /* not our event */ }
      }
      if (!entered) return reply(`Parent tx ${tx_hash} succeeded but carries no RollupEntered event, so this is not an enterRollup.`, { status: 'not_an_enter', tx_hash });

      const recipient = entered.l3Recipient;
      const expected = entered.xMoneyBridged;
      const live = await xgas.getBalance({ address: recipient });
      const before = balance_before_wei ? BigInt(balance_before_wei) : null;
      const landed = before !== null && live - before >= expected;

      const status = entered.retryableTicketId && entered.retryableTicketId !== 0n
        ? (landed ? 'landed_on_xgas' : 'ticket_created')
        : 'vault_locked';
      const data = {
        status,
        tx_hash,
        recipient,
        usdg_in: fmtUsdg(entered.usdgIn),
        xmoney_bridged: fmtXMoney(expected),
        usdg_raked: fmtUsdg(entered.usdgRaked),
        xmoney_burned: fmtXMoney(entered.xMoneyBurned),
        retryable_ticket_id: entered.retryableTicketId,
        recipient_xgas_balance: fmtXMoney(live),
        proof: before === null
          ? 'No balance_before_wei was given, so landing is unverified. Call again with the pre-enter balance, or just check get_balance.'
          : landed ? `Balance rose by at least ${fmtXMoney(expected)}.` : 'Balance has not risen by the bridged amount yet; the auto-redeem usually takes about a minute.',
      };
      return reply(`${status}: ${fmtUsdg(entered.usdgIn)} USDG in, ${fmtXMoney(expected)} $xMoney to ${recipient}. ${data.proof}`, data);
    },
  },

  {
    name: 'quote_exit',
    description: 'Quote $xMoney on xGas → USDG on the parent chain, end to end: the bridge-exit burn, the NAV redemption, the USDG rake, the contractual challenge window in Ethereum blocks, and whether the validator is currently asserting. Read-only.',
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
          ? `${w.summary} If you want dollars today rather than whenever the validator asserts and confirms, quote the OTC route with ramp_quote instead.`
          : `${w.error || 'The exit wait could not be read.'} If you want dollars today, quote the OTC route with ramp_quote instead.`,
        raw: { usdg_out_raw: m.usdgOut, gross_raw: m.gross },
      };
      return reply(
        `Burn ${fmtXMoney(m.xWei)} $xMoney → ${fmtUsdg(m.usdgOut)} USDG on the parent chain.\n` +
        `Fees: ${fmtXMoney(m.bridgeExitBurn)} xMoney burned on the way out of the bridge, then ${fmtUsdg(m.usdgRake)} USDG raked on redemption.\n` +
        (w.contractual
          ? `Timing: the contractual window is ${w.contractual} (${w.confirm_period_blocks} Ethereum blocks) after an assertion covering your withdrawal is posted. With the fast confirmer online it is usually minutes after the next assertion.` +
            (w.validator_idle
              ? `\nWarning: the validator appears idle. Its last assertion was at least ${w.last_assertion.age_estimated} ago, and exits are waiting on it. There is no ETA until it resumes.`
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
        irreversible: `This burns your $xMoney on xGas immediately. The funds are unreachable until an assertion covering the withdrawal is posted and confirmed on the parent chain. There is no cancel and no way to speed it up.${w.validator_idle ? ` The validator appears idle right now (last assertion at least ${w.last_assertion.age_estimated} ago), so this withdrawal will wait until it resumes.` : ''}`,
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
        const lines = ws.map((w) => `  #${w.position} ${w.amount} xMoney → ${w.destination}: ${w.status}${w.executedTx ? ` (executed ${w.executedTx})` : ''}`);
        const pending = ws.filter((w) => w.status === 'pending').length;
        return reply(
          `${ws.length} withdrawal(s) for ${address}:\n${lines.join('\n')}\n` +
          `Confirmed sends on the parent: ${body.confirmedSendCount}. "Claim for me" is ${body.executorEnabled ? 'available' : 'not configured on the host, so claim from your own wallet'}.` +
          (pending && win.contractual
            ? `\nThe ${pending} pending one(s) wait on an assertion that covers them, then about ${win.contractual} (usually minutes with the fast confirmer online).` +
              (win.validator_idle ? ` The validator appears idle (last assertion at least ${win.last_assertion.age_estimated} ago), so they are waiting on it.` : '')
            : ''),
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
      },
      additionalProperties: false,
    },
    async handler({ tx_hash, position }) {
      if (!tx_hash && !position) throw new Error('Give a tx_hash or a position.');
      const res = await fetch(`${XGAS_API}/api/withdrawals/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash: tx_hash, position }),
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

export { enterMath, exitMath };
