import { isAddress } from 'viem';
import { DEPLOY, L3, L4, PARENT_CHAIN_ID, XGAS_CHAIN_ID, parent, xgas, parentChain, xgasChain, nguLauncher, DEAD, XGAS_DEV } from '../config.mjs';
import { ERC20_ABI, VAULT_ABI } from '../abis.mjs';
import { fmtNav, fmtUsdg, fmtXMoney } from '../money.mjs';
import { reply } from '../approval.mjs';

const addr = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };

async function vaultNav() {
  const [navRay, usdgReserve, circulating] = await parent.readContract({
    address: L3.xMoney, abi: VAULT_ABI, functionName: 'getReserveNAV',
  });
  return { navRay, usdgReserve, circulating };
}

export const FEE_SCHEDULE = {
  enter: {
    usdg_rake_bps: 1,
    usdg_rake_to: L3.fanout,
    xmoney_entry_burn_bps: 1,
    entry_burn_split: 'half to 0x…dEaD, half minted to the Orbit bridge as a permanent solvency buffer',
  },
  xmoney_transfer: {
    burn_bps: 1,
    note: 'xMoney on the parent chain is a tax token: every transfer burns 0.01%. Transfers INTO the bridge system (Inbox/Bridge) are exempt; transfers OUT of it burn as usual.',
  },
  otc_trade: { burn_bps: 1, fanout_rake_bps: 1, xgas_dev_buyback_bps: 2, net_to_buyer_bps: 9996, fanout_sink: L4.fanoutSink },
  exit: { usdg_rake_bps: 1, usdg_rake_to: L3.fanout },
  ngu: {
    burn_bps: 1, fanout_bps: 1, xgas_dev_buyback_bps: 2,
    applies_to: 'every buy and sell on the curve; launch and donate are free',
    note: 'Curves launched before the XGAS.DEV buyback keep 0.01% + 0.01% forever (no BUYBACK_BPS on the token). Quote the token to see its own fees.',
  },
  // The third leg of every L4 fee path. Sinks that are not deployed yet are left out rather than guessed.
  xgas_dev_buyback: {
    bps: 2,
    token: XGAS_DEV,
    token_chain_id: PARENT_CHAIN_ID,
    ...(L4.buybackSink && { buyback_sink: L4.buybackSink }),
    ...(L3.xgasDevBuyback && { buyback_contract: L3.xgasDevBuyback }),
    applies_to: 'OTC release; FOMO key buys, dividend claims and jackpot; XGasRouter.sendValue; NGU curve buys and sells',
    how: 'The L4 buyback sink bridges it to XgasDevBuyback on Robinhood, which redeems it for USDG, buys XGAS.DEV on Uniswap v4 and burns all of it.',
  },
};

export const tools = [
  {
    name: 'get_chain_info',
    description: 'The xGas stack: both chains, every contract address, the fee schedule, and whether the L4 sequencer is producing blocks right now. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const [parentBlock, xgasBlock, launcher] = await Promise.all([
        parent.getBlockNumber().catch((e) => `unreachable: ${e.shortMessage || e.message}`),
        xgas.getBlockNumber().catch((e) => `unreachable: ${e.shortMessage || e.message}`),
        nguLauncher(),
      ]);
      const data = {
        chains: [
          { layer: 'parent (L3)', name: parentChain.name, chainId: PARENT_CHAIN_ID, rpc: parentChain.rpcUrls.default.http[0], nativeCurrency: 'ETH', head: parentBlock },
          { layer: 'xGas (L4)', name: xgasChain.name, chainId: XGAS_CHAIN_ID, rpc: xgasChain.rpcUrls.default.http[0], nativeCurrency: '$xMoney', head: xgasBlock },
        ],
        parent_contracts: L3,
        xgas_contracts: { ...L4, nguLauncher: launcher },
        rollup: { createRollupTx: DEPLOY.createRollupTx, deployedAtBlock: DEPLOY.deployedAtBlock, owner: DEPLOY.owner, batchPoster: DEPLOY.batchPoster, validator: DEPLOY.validator },
        fees: FEE_SCHEDULE,
        ngu_launcher_status: launcher ? 'deployed' : 'not deployed yet — every ngu_* tool will say so rather than guess',
      };
      const text = [
        `Robinhood Chain (parent) #${PARENT_CHAIN_ID} — head ${parentBlock}`,
        `xGas Orbit L4 #${XGAS_CHAIN_ID} — head ${xgasBlock}, native gas is $xMoney`,
        `Vault ${L3.xMoney} holds USDG ${L3.usdg}; escrow ${L4.escrow} runs the OTC desk.`,
        launcher ? `NguLauncher ${launcher}.` : 'NguLauncher is not deployed; NGU tools are dark.',
      ].join('\n');
      return reply(text, data);
    },
  },

  {
    name: 'get_balance',
    description: 'Balances for one address: native $xMoney on xGas L4, plus USDG and xMoney (ERC-20) on the parent chain. Read-only.',
    inputSchema: { type: 'object', properties: { address: { ...addr, description: 'Address to read (same address on both chains).' } }, required: ['address'], additionalProperties: false },
    async handler({ address }) {
      if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
      const [native, usdgBal, xmoneyBal] = await Promise.all([
        xgas.getBalance({ address }),
        parent.readContract({ address: L3.usdg, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
        parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
      ]);
      const data = {
        address,
        xgas_l4: { chainId: XGAS_CHAIN_ID, native_xmoney: fmtXMoney(native), wei: native },
        parent: { chainId: PARENT_CHAIN_ID, usdg: fmtUsdg(usdgBal), usdg_raw: usdgBal, xmoney_erc20: fmtXMoney(xmoneyBal), xmoney_raw: xmoneyBal },
      };
      return reply(
        `${address}\n  xGas L4: ${fmtXMoney(native)} $xMoney (native gas)\n  Parent: ${fmtUsdg(usdgBal)} USDG, ${fmtXMoney(xmoneyBal)} xMoney (ERC-20)`,
        data,
      );
    },
  },

  {
    name: 'get_vault_nav',
    description: 'What $xMoney is actually worth: the vault\'s USDG reserve, circulating xMoney, and NAV per token from getReserveNAV(). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const { navRay, usdgReserve, circulating } = await vaultNav();
      // The deployed vault predates parts of contracts/src/XMoney.sol (no l4GasLimit,
      // no totalXMoneyBridgedToL4). Read the counters tolerantly rather than assume.
      const counters = ['totalXMoneyBurned', 'totalUsdgRakedToFanout', 'totalUsdgDeposited', 'totalXMoneyBridgedToL4', 'totalBridgeBuffer'];
      const settled = await Promise.all(counters.map((fn) =>
        parent.readContract({ address: L3.xMoney, abi: VAULT_ABI, functionName: fn }).catch(() => null)));
      const [burned, raked, deposited, bridged, buffer] = settled;
      const dead = await parent.readContract({ address: L3.xMoney, abi: ERC20_ABI, functionName: 'balanceOf', args: [DEAD] });
      const orNA = (v, f) => (v === null ? 'not exposed by the deployed vault' : f(v));
      const data = {
        vault: L3.xMoney,
        usdg_reserve: fmtUsdg(usdgReserve),
        circulating_xmoney: fmtXMoney(circulating),
        nav_usd_per_xmoney: fmtNav(navRay),
        nav_ray: navRay,
        lifetime: {
          usdg_deposited: orNA(deposited, fmtUsdg),
          usdg_raked_to_fanout: orNA(raked, fmtUsdg),
          xmoney_burned: orNA(burned, fmtXMoney),
          xmoney_bridged_to_l4: orNA(bridged, fmtXMoney),
          bridge_solvency_buffer: orNA(buffer, fmtXMoney),
          xmoney_held_by_dead: fmtXMoney(dead),
        },
      };
      return reply(
        `1 $xMoney = $${fmtNav(navRay)} (USDG reserve ${fmtUsdg(usdgReserve)} against ${fmtXMoney(circulating)} circulating).`,
        data,
      );
    },
  },

  {
    name: 'get_fee_schedule',
    description: 'Every fee in the system, in one place: entry rake and burn, the transfer tax, OTC burn, rake and XGAS.DEV buyback, exit rake, NGU curve fees. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      return reply(
        [
          'Enter (USDG → $xMoney): 0.01% USDG to the Fanout + 0.01% xMoney entry burn (half dead, half bridge buffer).',
          'Parent xMoney transfers: 0.01% burn. Into the bridge system: exempt. Out of it: burned as usual.',
          'OTC release: 0.01% burned + 0.01% to the FanoutSink + 0.02% XGAS.DEV buyback; 99.96% net to the buyer.',
          'Exit (xMoney → USDG): 0.01% USDG rake to the Fanout.',
          'NGU curve: 0.01% burn + 0.01% FanoutSink + 0.02% XGAS.DEV buyback on every buy and sell. Curves launched before the buyback pay 0.01% + 0.01% only. Launch and donate pay none of it.',
          `XGAS.DEV buyback: the 0.02% on every L4 fee path (OTC, FOMO, router, NGU) is bridged to Robinhood, where it buys and burns XGAS.DEV (${XGAS_DEV}).`,
        ].join('\n'),
        FEE_SCHEDULE,
      );
    },
  },
];

export { vaultNav };
