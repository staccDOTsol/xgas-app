// Shared by the staccpad-fleet desks: every read and prepared transaction comes from the MCP connector tools
// (POST /api/connector/<tool>), and signing goes through the site's L4 send path.
import { sendL4Tx } from '../../contracts/gas';

export interface PreparedTx { label: string; chainId: number; to: string; data: string; value: string }

// Stranger-written names arrive wrapped in «» for models; the page shows them plain.
export const plain = (s: string) => String(s ?? '').replace(/[«»]/g, '').replace(/\*\*/g, '');

export async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<{ summary: string; data: T }> {
  const r = await fetch(`/api/connector/${name}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${name} failed (${r.status})`);
  return j;
}

export async function sendPrepared(data: { transactions?: PreparedTx[] }) {
  const txs = data?.transactions || [];
  if (!txs.length) throw new Error('Nothing to sign.');
  let last = '';
  for (const t of txs) {
    const r = await sendL4Tx({ to: t.to, data: t.data, valueWei: BigInt(t.value || '0'), waitForConfirmation: true });
    last = (r as any)?.hash || last;
  }
  return last;
}

