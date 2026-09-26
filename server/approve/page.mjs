// The page behind https://xgas.dev/approve/<id>: where the owner of an agent wallet sees exactly what their agent
// wants to send and decides. Server-rendered, no script at all (the CSP forbids it), every value escaped: step labels
// and arguments can carry third-party text such as an X handle read off the escrow.
//
// Everything prominent here is built from what the policy decoded: the function, the destination's label (the policy's
// own words for an allowlisted contract, never the agent's), and the USD it counts as. Step labels and the terms'
// action are strings the agent chose through its tool arguments ("Refund 480 USDG to your wallet (safe)" is one
// argument away), so they appear only as quoted, secondary text marked as written by the agent.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? 'not priced' : `$${Number(n).toFixed(2)}`);
const utc = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : '');

const EXPLORERS = { 4663: 'https://robinhoodchain.blockscout.com/tx/' };

const CSS = `
:root{--bg:#0b0e17;--card:#10141f;--line:#1e2538;--text:#e2e8f0;--muted:#94a3b8;--ok:#34d399;--ok-ink:#04110b;--warn:#fbbf24;--bad:#f87171;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}
.brand{font:700 12px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ok)}
h1{font-size:24px;line-height:1.25;margin:6px 0 4px}
h2{font:700 11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
p{margin:0 0 10px}
.muted{color:var(--muted)}.warn{color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:14px}
.row{display:grid;grid-template-columns:130px 1fr;gap:4px 14px;padding:6px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row>dt{color:var(--muted);font-size:13px}
.row>dd{margin:0;min-width:0;overflow-wrap:anywhere}
.mono{font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.pill{display:inline-block;font:700 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.muted{color:var(--muted)}
ul{margin:0;padding-left:18px}
li{margin:3px 0}
.reasons li{color:var(--warn)}
.problems{margin-top:8px;color:var(--warn);font-size:14px}
.headline{font-size:17px;font-weight:600;margin:0 0 6px}
.agent{font-size:13px;color:var(--muted);margin:0 0 10px}
.agent q{color:var(--text);font-style:italic}
.danger{border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.07)}
.total{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:baseline}
.total strong{font-size:22px}
details{margin-top:10px}
summary{cursor:pointer;color:var(--muted);font-size:13px}
pre{white-space:pre-wrap;word-break:break-all;font:12px/1.45 var(--mono);color:var(--muted);margin:8px 0 0}
form{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button,.btn{display:inline-block;font:700 15px system-ui,sans-serif;border-radius:12px;padding:12px 20px;cursor:pointer;border:1px solid var(--line);text-decoration:none}
.approve{background:var(--ok);color:var(--ok-ink);border-color:var(--ok)}
.reject{background:transparent;color:var(--text)}
button:focus-visible,a:focus-visible{outline:2px solid var(--ok);outline-offset:2px}
a{color:var(--ok)}
.notice{border-color:rgba(251,191,36,.45);background:rgba(251,191,36,.07)}
@media (max-width:520px){.row{grid-template-columns:1fr}.row>dt{padding-top:2px}h1{font-size:21px}button{flex:1 1 100%}}
`;

function shell(title, body, { refresh } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex,nofollow">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body><main><div class="brand">xgas.dev</div>${body}</main></body></html>`;
}

const STATUS = {
  pending: ['warn', 'Waiting for you'],
  executing: ['warn', 'Sending'],
  executed: ['ok', 'Sent'],
  failed: ['bad', 'Failed'],
  interrupted: ['bad', 'Interrupted'],
  rejected: ['muted', 'Rejected'],
  expired: ['muted', 'Expired'],
};

// How the policy classed each destination. A curve someone else launched is decodable, not trusted.
const TRUST = {
  allowlisted: ['ok', 'allowlisted'],
  this_wallet: ['ok', 'this wallet'],
  own_curve: ['ok', 'curve this wallet launched'],
  third_party_curve: ['warn', 'third-party curve'],
  display_only: ['bad', 'not on allowlist'],
  unknown: ['bad', 'not on allowlist'],
};
const trustOf = (s) => TRUST[s.trust] || (s.allowlisted ? TRUST.allowlisted : TRUST.unknown);

/** The step's headline, from decoded facts only: what it calls, where, and what it counts as. */
function stepHeadline(s) {
  const where = s.to_label || 'unknown address';
  const what = s.function === '(plain transfer)' ? `Send ${s.native_value || 'value'} to ${where}`
    : s.function ? `Call ${s.function} on ${where}`
      : `Unreadable call to ${where}`;
  return `${what}, counted as ${money(s.usd)}`;
}

const agentText = (label, text) => (text ? `<p class="agent">${esc(label)}: <q>${esc(text)}</q> (written by your agent, not checked)</p>` : '');

function stepCard(s, total, tx) {
  const args = (s.args || []).map((a) => `${esc(a.name)}: ${esc(typeof a.value === 'object' ? JSON.stringify(a.value) : a.value)}${a.label ? ` <span class="${a.label === 'not on the allowlist' ? 'warn' : 'muted'}">(${esc(a.label)})</span>` : ''}`).join(', ');
  const counted = (s.counted || []).map((c) => `<li>${esc(c.amount)} <span class="muted">(${esc(c.kind)})</span>: ${money(c.usd)}</li>`).join('');
  const [tone, word] = trustOf(s);
  return `<section class="card"><h2>Step ${s.index} of ${total} &middot; ${esc(s.chain)}</h2>`
    + `<p class="headline">${esc(stepHeadline(s))}</p>`
    + agentText('Your agent\'s label for this step', s.label)
    + '<dl>'
    + `<div class="row"><dt>To</dt><dd>${esc(s.to_label)} <span class="pill ${tone}">${esc(word)}</span><div class="mono">${esc(s.to)}</div></dd></div>`
    + `<div class="row"><dt>Call</dt><dd class="mono">${esc(s.function || 'unknown')}(${args})</dd></div>`
    + `<div class="row"><dt>Sends</dt><dd class="mono">${esc(s.native_value || '0')}</dd></div>`
    + `<div class="row"><dt>Counts as</dt><dd>${counted ? `<ul>${counted}</ul>` : '<span class="muted">nothing beyond gas</span>'}</dd></div>`
    + '</dl>'
    + (s.problems?.length ? `<ul class="problems">${s.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '')
    + (tx ? `<details><summary>Raw transaction</summary><pre>chain ${esc(tx.chainId)}\nto    ${esc(tx.to)}\nvalue ${esc(tx.value)} wei\ndata  ${esc(tx.data)}</pre></details>` : '')
    + '</section>';
}

function termsCard(t) {
  if (!t) return '';
  const row = (k, v) => (v ? `<div class="row"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');
  const fees = (t.fees || []).length
    ? `<ul>${t.fees.map((f) => `<li>${esc(f.label)}: ${esc(f.amount)}${f.note ? ` <span class="muted">(${esc(f.note)})</span>` : ''}</li>`).join('')}</ul>`
    : 'none on this action';
  const list = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `<section class="card"><h2>What the preparing tool says</h2>`
    + agentText('Your agent\'s title for this request', t.action)
    + '<p class="agent">The tool built these terms from arguments your agent chose, so names and descriptions in them are not checked. The decoded steps above are what actually runs.</p><dl>'
    + row('Asset', esc(t.asset)) + row('Amount', esc(t.amount))
    + row('Counterparty', t.counterparty ? esc(t.counterparty) : '') + row('Fees', fees) + row('You receive', esc(t.net))
    + row('Timeline', list(t.timeline)) + row('Notes', list(t.notes))
    + '</dl></section>'
    + (t.irreversible ? `<section class="card danger"><h2>Cannot be undone</h2><p>${esc(t.irreversible)}</p></section>` : '');
}

function header(v, now) {
  const [tone, word] = STATUS[v.status] || ['muted', v.status];
  const mins = Math.max(0, Math.ceil((Date.parse(v.expires_at) - now) / 60000));
  const when = v.status === 'pending' ? ` <span class="muted">Expires ${esc(utc(v.expires_at))}, in about ${mins} minute${mins === 1 ? '' : 's'}.</span>` : '';
  return `<p><span class="pill ${tone}">${esc(word)}</span>${when}</p>`
    + `<section class="card"><h2>Requested by your agent</h2><dl>`
    + `<div class="row"><dt>Wallet</dt><dd class="mono">${esc(v.wallet)}</dd></div>`
    + `<div class="row"><dt>Owner</dt><dd>${esc(v.owner)}</dd></div>`
    + `<div class="row"><dt>Tool</dt><dd class="mono">${esc(v.tool)}</dd></div>`
    + `<div class="row"><dt>Filed</dt><dd>${esc(utc(v.created_at))}</dd></div>`
    + '</dl></section>';
}

/** One line per step, from the decoded calls only, and the total: the part of the page to read first. */
function summaryCard(v) {
  const steps = v.steps || [];
  if (!steps.length) return '';
  const items = steps.map((s) => {
    const [tone, word] = trustOf(s);
    return `<li>${esc(stepHeadline(s))} <span class="muted">on ${esc(s.chain)}</span> <span class="pill ${tone}">${esc(word)}</span></li>`;
  }).join('');
  return `<section class="card"><h2>What it sends</h2><ul>${items}</ul>`
    + `<p class="muted" style="margin-top:8px">Total counted against your caps: <strong>${money(v.total_usd)}</strong>, plus network gas.</p></section>`;
}

function hashesCard(v) {
  if (!v.hashes?.length) return '';
  const items = v.hashes.map((h, i) => {
    const chain = v.transactions?.[i]?.chainId;
    const base = EXPLORERS[chain];
    return `<li class="mono">${base ? `<a href="${esc(base + h)}" rel="noopener noreferrer" target="_blank">${esc(h)}</a>` : esc(h)}</li>`;
  }).join('');
  return `<section class="card"><h2>Transactions</h2><ul>${items}</ul></section>`;
}

export function renderApprovalPage({ state, view, user, csrf, loginHref, xConfigured = true, message, now = Date.now() } = {}) {
  if (state === 'signin') {
    return shell('Sign in to review', `<h1>Sign in to review this request</h1>`
      + '<p class="muted">Your agent asked to send something from your xgas wallet that needs your say-so. Only the wallet\'s owner, signed in with X, can see and decide on it.</p>'
      + (xConfigured ? `<p style="margin-top:18px"><a class="btn approve" href="${esc(loginHref)}">Sign in with X</a></p>`
        : '<p class="notice card">Sign in with X is not configured on this host.</p>'));
  }
  if (state === 'not_found') {
    return shell('Not found', '<h1>No such approval</h1><p class="muted">The link is wrong, or the request is older than a week. Nothing was sent. Ask your agent to prepare it again if you still want it.</p>');
  }
  if (state === 'wrong_user') {
    return shell('Another account', `<h1>This request is for another account</h1><p class="muted">You are signed in as @${esc(user?.handle)}. Only the wallet's owner can see or decide on it. Nothing was sent.</p>`);
  }
  if (state === 'error') {
    return shell('Not approved', `<h1>Nothing was approved</h1><p class="muted">${esc(message)}</p>`);
  }

  const v = view;
  const steps = (v.steps || []).map((s, i) => stepCard(s, v.steps.length, v.transactions?.[i])).join('');
  const notice = message ? `<section class="card notice"><p>${esc(message)}</p></section>` : '';
  const total = `<section class="card"><div class="total"><span class="muted">Total counted against your caps</span><strong>${money(v.total_usd)}</strong></div>`
    + (v.total_notes || []).map((n) => `<p class="muted">${esc(n)}</p>`).join('')
    + '<p class="muted">Network gas comes on top, paid from the wallet in the chain\'s native token.</p></section>';

  if (state === 'review') {
    return shell('Approve a wallet transaction', `<h1>Approve a wallet transaction</h1>`
      + header(v, now) + notice
      + summaryCard(v)
      + `<section class="card"><h2>Why this needs you</h2><ul class="reasons">${(v.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>`
      + steps + termsCard(v.terms) + total
      + `<form method="post" action="/approve/${esc(v.id)}"><input type="hidden" name="csrf" value="${esc(csrf)}">`
      + '<button class="approve" type="submit" name="decision" value="approve">Approve and send</button>'
      + '<button class="reject" type="submit" name="decision" value="reject">Reject</button></form>'
      + `<p class="muted" style="margin-top:14px">Approve only if you asked your agent for exactly this. Approving sends ${v.steps?.length > 1 ? 'these transactions' : 'this transaction'} from your wallet at once, and it cannot be undone. This link works once.</p>`);
  }

  // Everything after the decision: sending, sent, failed, rejected, expired.
  const outcome = v.result?.error ? `<section class="card ${v.status === 'rejected' || v.status === 'expired' ? '' : 'danger'}"><p>${esc(v.result.error)}</p></section>`
    : v.status === 'executed' ? '<section class="card"><p>Every step went through.</p></section>'
      : v.status === 'executing' ? '<section class="card"><p>Sending now. This page refreshes on its own.</p></section>'
        : v.status === 'expired' ? '<section class="card"><p>Nobody decided within the time limit, so nothing was sent.</p></section>' : '';
  return shell('Wallet transaction', `<h1>Wallet transaction</h1>` + header(v, now) + notice + outcome + hashesCard(v) + steps + termsCard(v.terms) + total,
    { refresh: v.status === 'executing' ? 4 : 0 });
}
