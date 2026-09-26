import { json } from './money.mjs';
import { OPEN, UNTRUSTED_NOTE } from './untrusted.mjs';

/**
 * The connector never signs. Every write comes back as this envelope: an unsigned
 * transaction the user's own wallet signs, alongside the approval screen a
 * non-custodial connector owes you — exact action, amounts, every fee, the net, the finality timeline,
 * and an explicit word on what cannot be undone.
 */
export function prepared({ action, chainId, to, data, value = 0n, asset, amount, counterparty, fees = [], net, timeline = [], irreversible, notes = [], steps }) {
  const txs = steps || [{ label: action, chainId, to, data, value }];
  // A missing `to` would make the wallet deploy the calldata as a contract. That only happens when a
  // contract is absent from the deployment file (say, before the L4 apps are redeployed on a new chain).
  for (const t of txs) {
    if (!t.to || /^0x0{40}$/i.test(t.to)) {
      throw new Error(`Refusing to prepare "${t.label || action}": its target contract is not in the deployment file for chain ${t.chainId}. Nothing was prepared.`);
    }
  }
  return {
    kind: 'unsigned',
    action,
    approval: {
      action,
      asset,
      amount,
      counterparty: counterparty || null,
      fees,
      net,
      timeline,
      irreversible,
      notes,
    },
    transactions: txs.map((t) => ({
      label: t.label,
      chainId: t.chainId,
      to: t.to,
      data: t.data,
      value: (t.value ?? 0n).toString(),
    })),
    next: `Review the terms above. Nothing is signed yet. Sign the transaction${txs.length > 1 ? 's' : ''} in your own wallet, then call the matching submit_* tool with the signed payload and an idempotency key.`,
  };
}

/** Render an approval envelope as the text a person actually reads before signing. */
export function renderApproval(p) {
  const a = p.approval;
  const L = [];
  L.push(`**${a.action}**`);
  L.push(`Asset: ${a.asset}`);
  L.push(`Amount: ${a.amount}`);
  if (a.counterparty) L.push(`Counterparty: ${a.counterparty}`);
  if (a.fees.length) {
    L.push('Fees:');
    for (const f of a.fees) L.push(`  - ${f.label}: ${f.amount}${f.note ? ` (${f.note})` : ''}`);
  } else {
    L.push('Fees: none on this step');
  }
  if (a.net) L.push(`You receive: ${a.net}`);
  if (a.timeline.length) {
    L.push('Timeline:');
    for (const t of a.timeline) L.push(`  - ${t}`);
  }
  if (a.notes.length) for (const n of a.notes) L.push(`Note: ${n}`);
  if (a.irreversible) L.push(`IRREVERSIBLE: ${a.irreversible}`);
  L.push('');
  L.push(`${p.transactions.length} unsigned transaction${p.transactions.length > 1 ? 's' : ''} to sign in your wallet:`);
  p.transactions.forEach((t, i) => L.push(`  ${i + 1}. ${t.label}: chain ${t.chainId}, to ${t.to}, value ${t.value}`));
  L.push('');
  L.push(p.next);
  return L.join('\n');
}

/**
 * MCP tool result: readable text first, exact data after. When anything in it came from a third party (wrapped in
 * «» by untrusted.mjs), say so right under the text, before the JSON block, so unwrap() still finds the JSON.
 */
export function reply(text, data) {
  const payload = data === undefined ? '' : json(data);
  const flagged = String(text).includes(OPEN) || payload.includes(OPEN);
  const head = flagged ? `${text}\n\n${UNTRUSTED_NOTE}` : text;
  const body = data === undefined ? head : `${head}\n\n\`\`\`json\n${payload}\n\`\`\``;
  return { content: [{ type: 'text', text: body }] };
}

export const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * The two fields every submit_* tool takes. Shared, because the wording drifted:
 * xswap and wallet described them and bridge, otc and ngu shipped them bare, which
 * left a foreign model guessing at the one argument that makes a retry safe.
 */
export const submitFields = {
  signed_tx: { type: 'string', description: 'One raw signed transaction, hex, exactly as returned by your signer.' },
  idempotency_key: { type: 'string', description: 'Your own key for this submission. Strongly recommended: a repeat with the same key returns the first result instead of sending the transaction twice.' },
};
