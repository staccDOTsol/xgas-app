import { json } from './money.mjs';

/**
 * The connector never signs. Every write comes back as this envelope: an unsigned
 * transaction the user's own wallet signs, alongside the approval screen the Muse
 * ToS requires — exact action, amounts, every fee, the net, the finality timeline,
 * and an explicit word on what cannot be undone.
 */
export function prepared({ action, chainId, to, data, value = 0n, asset, amount, counterparty, fees = [], net, timeline = [], irreversible, notes = [], steps }) {
  const txs = steps || [{ label: action, chainId, to, data, value }];
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
    next: `Review the terms above. Nothing is signed yet — sign the transaction${txs.length > 1 ? 's' : ''} in your own wallet, then call the matching submit_* tool with the signed payload and an idempotency key.`,
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
  p.transactions.forEach((t, i) => L.push(`  ${i + 1}. ${t.label} — chain ${t.chainId}, to ${t.to}, value ${t.value}`));
  L.push('');
  L.push(p.next);
  return L.join('\n');
}

/** MCP tool result: readable text first, exact data after. */
export function reply(text, data) {
  const body = data === undefined ? text : `${text}\n\n\`\`\`json\n${json(data)}\n\`\`\``;
  return { content: [{ type: 'text', text: body }] };
}

export const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
