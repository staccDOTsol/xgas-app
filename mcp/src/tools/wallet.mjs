import { formatEther } from 'viem';
import { PARENT_CHAIN_ID, XGAS_CHAIN_ID, parent, xgas, L3 } from '../config.mjs';
import { ERC20_ABI } from '../abis.mjs';
import { fmtUsdg, fmtXMoney } from '../money.mjs';
import { reply } from '../approval.mjs';
import { agentWallet, createAgentWallet, privyConfigured, NOT_CONFIGURED } from '../privy.mjs';
import { actorLabel, currentActor } from '../actor.mjs';
import { policySnapshot, usd } from '../walletPolicy.mjs';
import { walletExecute, walletApprovalStatus, approvalsAvailable } from '../walletApprovals.mjs';

const CUSTODY_NOTE =
  'This wallet is held by Privy, not by you in a browser. Signing in with X is what reaches it, so it is as '
  + 'safe as that login and no safer. Keep in it what you are willing to have an agent spend. An agent can only '
  + 'spend it on its own within this host\'s caps (wallet_status lists them); anything else waits for you to approve it in a browser.';
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
      const policy = { ...policySnapshot(w.address), approval_page: approvalsAvailable() };
      const data = {
        configured: true,
        wallet: { address: w.address, id: w.id, source: w.source, owner: w.owner || null },
        balances: { xgas_native_xmoney: formatEther(native), parent_usdg: fmtUsdg(usdg), parent_xmoney: fmtXMoney(xm) },
        custody: CUSTODY_NOTE,
        policy,
      };
      return reply(
        `${whose()}: ${w.address} (Privy, ${w.source}).\n`
        + `  xGas L4: ${formatEther(native)} $xMoney, which pays gas for everything on ${XGAS_CHAIN_ID}\n`
        + `  Parent:  ${fmtUsdg(usdg)} USDG, ${fmtXMoney(xm)} xMoney\n${CUSTODY_NOTE}\n`
        + `Policy: up to ${usd(policy.per_transaction_usd)} per transaction and ${usd(policy.per_24h_usd)} per 24 hours without asking `
        + `(${usd(policy.spent_24h_usd)} used), only to xgas contracts, NGU curves this wallet launched, and sells of NGU tokens it holds`
        + `${policy.approve_all ? '; this host asks you to approve every transaction' : ''}. Donations, buys on someone else's NGU curve`
        + `${policy.third_party_ngu_usd > 0 ? ` over ${usd(policy.third_party_ngu_usd)}` : ''} and XSwap always need you. `
        + (policy.approval_page ? 'Anything else returns a link for you to approve.' : 'Anything else is refused here: this connector has no approval page for this wallet.'),
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
      'Run a prepare_* tool with your own wallet: Privy signs each step and this connector broadcasts it. '
      + 'A server-side policy decides what runs: small transactions to xgas contracts (per-transaction and 24-hour caps in USD, '
      + 'a contract allowlist; on NGU, buys only on curves this wallet launched and sells of tokens it holds) go out when confirm is true. '
      + 'Donations, buys on anyone else\'s curve, anything bigger, or anything to another address returns a one-time approval link '
      + 'that expires in 10 minutes and that only the wallet owner, signed in with X in a browser, can approve. You cannot approve it; '
      + 'give the person the link and follow it with wallet_approval_status. Sent transactions cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Any prepare_* / post_* / take_* / launch_* tool, e.g. prepare_enter, take_ask, prepare_ngu_buy.' },
        args: { type: 'object', description: "That tool's arguments. Omit `from`; the agent wallet's address is filled in." },
        idempotency_key: { type: 'string', description: 'Required. A repeat with the same key returns the first result (or the approval already filed) instead of sending again.' },
        confirm: { type: 'boolean', description: 'Without it you get the terms and the policy decision, and nothing is sent. With it, a transaction inside the policy is sent and anything else becomes an approval link for the owner.' },
      },
      required: ['tool', 'idempotency_key'],
      additionalProperties: false,
    },
    handler: (input) => walletExecute(input),
  },

  {
    name: 'wallet_approval_status',
    description: 'Where an approval link from wallet_execute stands: pending (with its expiry), sending, sent (with hashes), failed, rejected or expired. Only your own wallet\'s approvals. Read-only; it cannot approve anything.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The approval id wallet_execute returned.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (input) => walletApprovalStatus(input),
  },
];
