import { formatEther } from 'viem';
import { PARENT_CHAIN_ID, XGAS_CHAIN_ID, parent, xgas, clientFor, L3 } from '../config.mjs';
import { ERC20_ABI } from '../abis.mjs';
import { fmtUsdg, fmtXMoney } from '../money.mjs';
import { reply } from '../approval.mjs';
import { agentWallet, createAgentWallet, signStep, privyConfigured, NOT_CONFIGURED } from '../privy.mjs';
import { actorLabel, currentActor } from '../actor.mjs';
import { record, recorded, submitRaw } from '../idempotency.mjs';

const CUSTODY_NOTE =
  'This wallet is held by Privy, not by you in a browser. Signing in with X is what reaches it, so it is as '
  + 'safe as that login and no safer. Keep in it what you are willing to have an agent spend.';
/** Whose wallet this call is about, said plainly, because two people must never see each other\'s. */
const whose = () => (currentActor().kind === 'user' ? `${actorLabel()}'s wallet` : 'the operator wallet');

export const tools = [
  {
    name: 'wallet_status',
    description: 'Your wallet on this connector: whether Privy is configured, the address it signs as, and what it holds on both chains. Signed in with X, that is your own wallet and nobody else can reach it. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      if (!privyConfigured()) return reply(NOT_CONFIGURED, { configured: false, wallet: null });
      const w = await agentWallet();
      if (!w) return reply(`Privy is configured but there is no wallet for ${currentActor().kind === 'user' ? actorLabel() : 'the operator'} yet. Call wallet_create to make one.`, { configured: true, wallet: null, actor: currentActor().kind });
      const [native, usdg, xm] = await Promise.all([
        xgas.getBalance({ address: w.address }),
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'balanceOf', args: [w.address] }),
        parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [w.address] }),
      ]);
      const data = {
        configured: true,
        wallet: { address: w.address, id: w.id, source: w.source, owner: w.owner || null },
        balances: { xgas_native_xmoney: formatEther(native), parent_usdg: fmtUsdg(usdg), parent_xmoney: fmtXMoney(xm) },
        custody: CUSTODY_NOTE,
      };
      return reply(
        `${whose()}: ${w.address} (Privy, ${w.source}).\n`
        + `  xGas L4: ${formatEther(native)} $xMoney, which pays gas for everything on ${XGAS_CHAIN_ID}\n`
        + `  Parent:  ${fmtUsdg(usdg)} USDG, ${fmtXMoney(xm)} xMoney\n${CUSTODY_NOTE}`,
        data,
      );
    },
  },

  {
    name: 'wallet_create',
    description: 'Create your Privy wallet on this connector, once. Returns the address to fund. Does nothing if you already have one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      if (!privyConfigured()) return reply(NOT_CONFIGURED, { configured: false });
      const w = await createAgentWallet();
      return reply(
        w.created
          ? `Created ${w.address}.\nIt holds nothing yet. It needs native $xMoney on xGas (${XGAS_CHAIN_ID}) for gas before it can do anything there, and ETH on the parent (${PARENT_CHAIN_ID}) for anything on that side.\n${CUSTODY_NOTE}`
          : `You already have one: ${w.address}. Nothing created.`,
        w,
      );
    },
  },

  {
    name: 'wallet_execute',
    description:
      'Run a prepare_* tool and actually execute it with your own wallet: Privy signs each step, this connector broadcasts it. '
      + 'The approval terms are returned with the result, and confirm must be true, because there is no way to undo a sent transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Any prepare_* / post_* / take_* / launch_* tool, e.g. prepare_enter, take_ask, prepare_ngu_buy.' },
        args: { type: 'object', description: "That tool's arguments. Omit `from`; the agent wallet's address is filled in." },
        idempotency_key: { type: 'string', description: 'Required. A repeat with the same key returns the first result instead of sending again.' },
        confirm: { type: 'boolean', description: 'Must be true. Without it you get the approval terms and nothing is sent.' },
      },
      required: ['tool', 'idempotency_key'],
      additionalProperties: false,
    },
    async handler({ tool, args = {}, idempotency_key, confirm }) {
      if (!privyConfigured()) return reply(NOT_CONFIGURED, { configured: false });
      const w = await agentWallet();
      if (!w) return reply('No wallet yet. Call wallet_create first.', { wallet: null });

      const prior = recorded(idempotency_key);
      if (prior) return reply(`Already executed under this key; nothing re-sent. ${JSON.stringify(prior.hashes || prior.hash)}`, { ...prior, replayed: true });

      // lazy: the registry imports this module, so importing it at load time would cycle
      const { TOOLS_BY_NAME, unwrap } = await import('../registry.mjs');
      const target = TOOLS_BY_NAME.get(tool);
      if (!target) return reply(`No such tool: ${tool}`, { blocked: 'unknown_tool' });
      if (!/^(prepare_|post_|take_|launch_|release_|cancel_|reclaim_)/.test(tool)) {
        return reply(`${tool} is not something to execute. Pass a tool that prepares a transaction.`, { blocked: 'not_executable' });
      }

      const filled = { ...args };
      for (const k of ['from', 'to', 'destination', 'l3_recipient', 'holder', 'address']) {
        if (k in (target.inputSchema.properties || {}) && filled[k] === undefined) filled[k] = w.address;
      }
      const out = unwrap(await target.handler(filled));
      const env = out.data;
      if (!env || env.kind !== 'unsigned') {
        return reply(`${tool} did not produce a transaction:\n${out.summary}`, { ...out, executed: false });
      }
      if (!confirm) {
        return reply(`${out.summary}\n\nNothing was sent. Call again with confirm: true to execute as ${w.address}.`, { ...env, executed: false, awaiting_confirmation: true });
      }

      const hashes = [];
      for (const [i, step] of env.transactions.entries()) {
        let signed;
        try {
          signed = await signStep({ chainId: step.chainId, to: step.to, data: step.data, value: BigInt(step.value) });
        } catch (e) {
          return reply(
            `Step ${i + 1} (${step.label}) could not be signed: ${e.message}\n`
            + (hashes.length ? `Earlier steps already went through: ${hashes.join(', ')}. Those cannot be undone.` : 'Nothing was sent.'),
            { executed: false, failed_step: i + 1, hashes },
          );
        }
        const res = await submitRaw({ chainId: step.chainId, signedTx: signed.signedTransaction, kind: `wallet_execute:${tool}` });
        hashes.push(res.hash);
        const rc = await clientFor(step.chainId).waitForTransactionReceipt({ hash: res.hash, timeout: 180_000 });
        if (rc.status !== 'success') {
          return reply(`Step ${i + 1} (${step.label}) reverted on chain: ${res.hash}. Later steps were not sent.`, { executed: false, hashes, reverted: res.hash });
        }
      }
      record(idempotency_key, { hashes, hash: hashes[hashes.length - 1], tool, wallet: w.address, kind: 'wallet_execute' });
      return reply(
        `Executed ${tool} as ${w.address}.\n${out.summary.split('\n')[0]}\nTransactions: ${hashes.join(', ')}`,
        { executed: true, tool, wallet: w.address, hashes, approval: env.approval },
      );
    },
  },
];
