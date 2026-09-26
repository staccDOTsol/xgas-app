// Fully functional smart contract ABIs for staccpad on Robinhood Chain (#4663)
// Runtime values dumped from Fly.io staccpad-amm container

export const CONTRACT_ADDRESSES = {
  ROBINHOOD_CHAIN_ID: 4663,
  ROBINHOOD_RPC: 'https://staccpad.fun/rpc',
  APP_URL: 'https://staccpad.fun',
  STACCPAD_FACTORY: '0x9f6AE7690d77a8FAb18Ba42fA064FBf0c4791E14',
  STACCPAD_VAULT_ROUTER: '0xB1361c3Ebb45c9827c85e770B55f97C228513B5B', // NEXT_PUBLIC_ROUTER_ADDRESS
  CLMM_HOOK: '0xcFEC18Db9C2aC4812800D7b181Cb3Fb2d82a8044', // NEXT_PUBLIC_HOOK_ADDRESS
  LAUNCHPAD: '0x7F96fD3572E281704C40118eB078BbcCD48c462b', // NEXT_PUBLIC_LAUNCHPAD_ADDRESS
  NGU_BONDING_CURVE: '0x7F96fD3572E281704C40118eB078BbcCD48c462b',
  POOL_MANAGER: '0x38bB0B3644E83CF828D2D15A1AF9E75FA3aDe82b', // Verified on-chain active v4 PoolManager from Factory
  POSITION_NFT: '0x6f5493e2D89F8facc5734923f0557b197DE0e718', // NEXT_PUBLIC_POSITION_NFT_ADDRESS
  HOMECOMING_COLLECTION: '0x7c165Ae6E7BFD939Fee1ACA99Ca5aeDf85c52dD4',
  HOMECOMING_VAULT_WETH: '0xC0e154909476f5e1a0c881d10989151577C7eAb9', // 105 NFTs locked in Vault
  HOMECOMING_VAULT_USDG: '0x6ca49c1777775E81aA08bd656783C7baDAd68149',
  HOMECOMING_WETH_POOL_ID: '0x7cae5e1f0dfd7f0376a5330658f53d9a0f8297c68e5a440bbcdf272a0b2a3727',
  HOMECOMING_USDG_POOL_ID: '0xa718eea2ae28b1062dfc4740ed5e1a974e9a82b1b614692477da8a3cbf810399',
  CCFF00_COLLECTION: '0x505A22Ffed8d37ebE580FfD98d2Cdb0021189146',
  CCFF00_VAULT_WETH: '0x144e73359476Cb496bC538Eb91dB8172604038B1', // 3 NFTs locked in Vault
  CCFF00_WETH_POOL_ID: '0x49dced8013c9a66e1fc8e810832ae396aeec86331bba36f4effd9c8527286ca2',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // NEXT_PUBLIC_WETH_ADDRESS
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // NEXT_PUBLIC_USDG_ADDRESS
  // xgas Orbit L4 — a real Arbitrum Orbit (AnyTrust) chain settling on Robinhood Chain #4663.
  // Every address below comes from src/contracts/l4-deployment.json (written by the rollup deployment).
  ORBIT_L4_CHAIN_ID: 466301,
  ORBIT_L4_RPC: 'https://xgas.dev/rpc',
  ORBIT_L4_WS: '',
  /** The xMoney vault + gas token on Robinhood (tax token; USDG reserve; bridge-aware). */
  XMONEY_USD_L3: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E',
  XMONEY_LEGACY_L3: '0xa72Ab0874A57Ab0F950Bf61B096b01b183A3CB7c',
  ORBIT_ROLLUP: '0x5Ba539b34b9F33036CC4788225149ce07Ba183a8',
  ORBIT_INBOX: '0x67E524A7349ccB4a2d59D6256c51cf20586687b4',
  ORBIT_OUTBOX: '0x4d4757f0cB643d97B779ee4DD5512C6c2383E78f',
  ORBIT_BRIDGE: '0x8b58B2f893770E57e16D8c7551f2E405E9A94E5f',
  ORBIT_SEQUENCER_INBOX: '0x16Daa2551d41243C82366c8b94Dc11418Ac0AeD7',
  XMONEY_TIMELOCK: '0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B',
  ORBIT_DEPLOY_TX: '0xa49321744d16391e315e4202f576768247c3f60bd79b64dc837ef61fb2f0afc5',
  XMONEY_ESCROW_L4: '0xBCa24A0f7E43bCFa944c490D66470f3A03bbEcC8', // v4 (2026-09-26): 0.01% → FanoutSink 0x6521…9b4B, 0.02% → buyback sink 0xa924…a97E → XgasDevBuyback on Robinhood
  FOMO_ATTRITION_L4: '0xec342a426c6CB512c75Fe34DaCE455e9cFeC6582',
  XGAS_ROUTER: '0xfeb38ce50e1F49438acAa39b2Da513d2F1DE548f',
  ARB_SYS: '0x0000000000000000000000000000000000000064',
  FEE_FANOUT: '0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e',
  /** XGAS.DEV on Robinhood: the 0.02% leg of every L4 fee path buys it and burns it (XgasDevBuyback). */
  XGAS_DEV: '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3',
} as const;

/** Live xgas Orbit L4 contract addresses (mutable; refreshed from /api/l4-info at boot). */
export const l4Addresses = {
  escrow: CONTRACT_ADDRESSES.XMONEY_ESCROW_L4 as string,
  fomo: CONTRACT_ADDRESSES.FOMO_ATTRITION_L4 as string,
  router: CONTRACT_ADDRESSES.XGAS_ROUTER as string,
  /** NGU launcher on xGas L4. Empty until deployed; refreshed from /api/l4-info at boot. */
  nguLauncher: '' as string,
  /** The first NGU launcher (0.01% + 0.01%, no XGAS.DEV buyback). Listed, never launched on. Empty if absent. */
  legacyNguLauncher: '' as string,
  ready: false,
};

// 1. STACCPAD FACTORY ABI (Zero creation fee, instant market creation)
export const STACCPAD_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'maxSupply', type: 'uint256' },
      { name: 'initialFloorWei', type: 'uint256' },
      { name: 'lockedLpBps', type: 'uint256' },
      { name: 'quoteToken', type: 'address' }
    ],
    outputs: [
      { name: 'collection', type: 'address' },
      { name: 'vault', type: 'address' },
      { name: 'marketId', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'getMarket',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [
      { name: 'collection', type: 'address' },
      { name: 'vault', type: 'address' },
      { name: 'nguCurve', type: 'address' },
      { name: 'floorPrice', type: 'uint256' },
      { name: 'active', type: 'bool' }
    ]
  },
  {
    type: 'function',
    name: 'getMarketByCollection',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'vault', type: 'address' },
      { name: 'nguCurve', type: 'address' },
      { name: 'floorPrice', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'totalMarkets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'count', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'creationFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'homecomingDividendVault',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'event',
    name: 'MarketCreated',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'collection', type: 'address', indexed: true },
      { name: 'vault', type: 'address', indexed: false },
      { name: 'nguCurve', type: 'address', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'lockedLpBps', type: 'uint256', indexed: false }
    ]
  }
] as const;

// 2. STACCPAD VAULT / CLMM UNISWAP V4 HOOK ABI
export const STACCPAD_VAULT_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactETHForNFT',
    stateMutability: 'payable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'minNFTOut', type: 'uint256' },
      { name: 'maxTickSlippage', type: 'int24' }
    ],
    outputs: [
      { name: 'nftsOut', type: 'uint256' },
      { name: 'ethSpent', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'swapExactNFTForETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'tokenIds', type: 'uint256[]' },
      { name: 'minETHOut', type: 'uint256' }
    ],
    outputs: [{ name: 'ethOut', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'sweepFloor',
    stateMutability: 'payable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'count', type: 'uint256' },
      { name: 'maxETH', type: 'uint256' }
    ],
    outputs: [
      { name: 'tokenIds', type: 'uint256[]' },
      { name: 'refund', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'depositNFTForClaims',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'tokenIds', type: 'uint256[]' }
    ],
    outputs: [{ name: 'claimsMinted', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'redeemClaimsForNFT',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'amountClaims', type: 'uint256' }
    ],
    outputs: [{ name: 'tokenIds', type: 'uint256[]' }]
  },
  {
    type: 'function',
    name: 'getFloorPrice',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [{ name: 'floorWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'getQuote',
    stateMutability: 'view',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'nftCount', type: 'uint256' },
      { name: 'isBuy', type: 'bool' }
    ],
    outputs: [
      { name: 'quoteAmountWei', type: 'uint256' },
      { name: 'feeAmountWei', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'getTickDepth',
    stateMutability: 'view',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }
    ],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'ethLocked', type: 'uint256' },
      { name: 'nftsLocked', type: 'uint256' }
    ]
  },
  {
    type: 'event',
    name: 'FloorSwept',
    inputs: [
      { name: 'collection', type: 'address', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'count', type: 'uint256', indexed: false },
      { name: 'totalCostWei', type: 'uint256', indexed: false }
    ]
  }
] as const;

// 3. NGU (NUMBERS GO UP) BONDING CURVE ABI
export const NGU_BONDING_CURVE_ABI = [
  {
    type: 'function',
    name: 'mintNGU',
    stateMutability: 'payable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'recipient', type: 'address' }
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'newFloor', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'getCurrentFloor',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [{ name: 'floorWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'getNextMintPrice',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [{ name: 'mintPriceWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'getLockedLpBps',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [{ name: 'lockedLpBps', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'getCurveProgress',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [
      { name: 'minted', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
      { name: 'currentFloorWei', type: 'uint256' },
      { name: 'nextFloorWei', type: 'uint256' },
      { name: 'totalLockedETH', type: 'uint256' }
    ]
  },
  {
    type: 'event',
    name: 'NGUMinted',
    inputs: [
      { name: 'collection', type: 'address', indexed: true },
      { name: 'minter', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: false },
      { name: 'paidPriceWei', type: 'uint256', indexed: false },
      { name: 'lockedToLPWei', type: 'uint256', indexed: false }
    ]
  }
] as const;

// 4. HOMECOMING DIVIDEND FANOUT ABI (0.50% volume fee distribution to 10,000 shares)
export const HOMECOMING_DIVIDENDS_ABI = [
  {
    type: 'function',
    name: 'claimDividends',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [{ name: 'claimedWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'pendingDividends',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'pendingWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'totalShares',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'sharesOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'totalFeePot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'totalPotWei', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'feeShareBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }] // 50 bps = 0.50%
  },
  {
    type: 'event',
    name: 'DividendsClaimed',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amountWei', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'event',
    name: 'FeesDeposited',
    inputs: [
      { name: 'source', type: 'address', indexed: true },
      { name: 'amountWei', type: 'uint256', indexed: false },
      { name: 'newTotalPotWei', type: 'uint256', indexed: false }
    ]
  }
] as const;

// 5. STANDARD ERC20 / WETH / USDG ABI
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: []
  }
] as const;

// 6. STANDARD ERC721 NFT ABI
export const ERC721_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

// 6. UNISWAP V4 POOL MANAGER ABI (0x8366a39CC670B4001A1121B8F6A443A643e40951)
export const UNISWAP_V4_POOL_MANAGER_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' }
        ]
      },
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'hookData', type: 'bytes' }
    ],
    outputs: [{ name: 'tick', type: 'int24' }]
  },
  {
    type: 'function',
    name: 'unlock',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [{ name: '', type: 'bytes' }]
  },
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' }
    ]
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }]
  },
  {
    type: 'function',
    name: 'isUnlocked',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'unlocked', type: 'bool' }]
  }
] as const;

// 7. CLMM HOOK ABI (0xcFEC18Db9C2aC4812800D7b181Cb3Fb2d82a8044)
export const CLMM_HOOK_ABI = [
  {
    type: 'function',
    name: 'vaultRouter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'getCollectionPoolId',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [{ name: 'poolId', type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'getFeeDistribution',
    stateMutability: 'view',
    inputs: [{ name: 'collection', type: 'address' }],
    outputs: [
      { name: 'lockedLpBps', type: 'uint256' },
      { name: 'homecomingBps', type: 'uint256' },
      { name: 'creatorBps', type: 'uint256' }
    ]
  }
] as const;

// 8. POSITION NFT ABI (0x6f5493e2D89F8facc5734923f0557b197DE0e718)
export const POSITION_NFT_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }]
  },
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' }
    ]
  }
] as const;

export type ContractKey = 
  | 'STACCPAD_FACTORY'
  | 'STACCPAD_VAULT_ROUTER'
  | 'CLMM_HOOK'
  | 'POOL_MANAGER'
  | 'POSITION_NFT'
  | 'NGU_BONDING_CURVE'
  | 'HOMECOMING_COLLECTION'
  | 'CCFF00_COLLECTION'
  | 'WETH'
  | 'USDG';

export interface ContractInfo {
  name: string;
  address: string;
  description: string;
  category: 'core' | 'clmm' | 'bonding' | 'tokens' | 'uniswap' | 'nft';
  abi: readonly any[];
}

export const CONTRACTS_CATALOG: Record<ContractKey, ContractInfo> = {
  STACCPAD_FACTORY: {
    name: 'StaccpadFactory',
    address: CONTRACT_ADDRESSES.STACCPAD_FACTORY,
    description: 'Deploys 0-fee NFT markets, initializes CLMM vault hooks & links NGU curves (vs Anvil 1 ETH gate)',
    category: 'core',
    abi: STACCPAD_FACTORY_ABI
  },
  STACCPAD_VAULT_ROUTER: {
    name: 'StaccpadVaultRouter',
    address: CONTRACT_ADDRESSES.STACCPAD_VAULT_ROUTER,
    description: 'Uniswap v4 CLMM Hook & 1 NFT ↔ 1e18 claim liquidity pool. Instant Ape & Floor Sweeper.',
    category: 'clmm',
    abi: STACCPAD_VAULT_ROUTER_ABI
  },
  CLMM_HOOK: {
    name: 'UniswapV4CLMMHook',
    address: CONTRACT_ADDRESSES.CLMM_HOOK,
    description: 'Uniswap v4 dynamic hook enforcing protocol fee cuts, locked LP splits, and Homecoming dividend fanout.',
    category: 'clmm',
    abi: CLMM_HOOK_ABI
  },
  POOL_MANAGER: {
    name: 'UniswapV4PoolManager',
    address: CONTRACT_ADDRESSES.POOL_MANAGER,
    description: 'Canonical Uniswap v4 singleton contract managing all pool state, singleton flash accounting, and locks.',
    category: 'uniswap',
    abi: UNISWAP_V4_POOL_MANAGER_ABI
  },
  POSITION_NFT: {
    name: 'StaccpadPositionNFT',
    address: CONTRACT_ADDRESSES.POSITION_NFT,
    description: 'ERC-721 token representing protocol-owned and provider concentrated liquidity LP positions.',
    category: 'clmm',
    abi: POSITION_NFT_ABI
  },
  NGU_BONDING_CURVE: {
    name: 'NGUBondingCurve',
    address: CONTRACT_ADDRESSES.NGU_BONDING_CURVE,
    description: 'One-way rising-only bonding curve. 20-100% of mint proceeds lock permanently into Uniswap v4 LP.',
    category: 'bonding',
    abi: NGU_BONDING_CURVE_ABI
  },
  HOMECOMING_COLLECTION: {
    name: "stacc's robinhood homecoming collection",
    address: CONTRACT_ADDRESSES.HOMECOMING_COLLECTION,
    description: 'On-chain NFT collection (Symbol: STACCSHOME, Supply: 8,010) on Robinhood Chain #4663.',
    category: 'nft',
    abi: ERC721_ABI
  },
  CCFF00_COLLECTION: {
    name: 'CCFF00',
    address: CONTRACT_ADDRESSES.CCFF00_COLLECTION,
    description: 'On-chain NFT collection (Symbol: CCFF00, Supply: 10,000, Robin Neon) on Robinhood Chain #4663.',
    category: 'nft',
    abi: ERC721_ABI
  },
  WETH: {
    name: 'WETH (Wrapped Ether)',
    address: CONTRACT_ADDRESSES.WETH,
    description: 'Primary quote asset for concentrated liquidity tick orders.',
    category: 'tokens',
    abi: ERC20_ABI
  },
  USDG: {
    name: 'USDG (Stable Quote)',
    address: CONTRACT_ADDRESSES.USDG,
    description: 'Secondary stable desk asset for cross-desk floor arbitrage.',
    category: 'tokens',
    abi: ERC20_ABI
  }
};
