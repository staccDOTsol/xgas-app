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
  // xgas Orbit L4: an Arbitrum Orbit rollup (every batch posted to Robinhood as calldata) settling on Robinhood Chain #4663.
  // Every address below comes from src/contracts/l4-deployment.json (written by the rollup deployment).
  ORBIT_L4_CHAIN_ID: 466302,
  /** The retired chain. Only its Outbox claims are still served (by the host, from legacy466301 in the deployment file). */
  ORBIT_L4_LEGACY_CHAIN_ID: 466301,
  ORBIT_L4_RPC: 'https://xgas.dev/rpc',
  ORBIT_L4_WS: '',
  /** The xMoney vault + gas token on Robinhood (tax token; USDG reserve; bridge-aware). */
  XMONEY_USD_L3: '0xa924C725B64cC346f275269EFA4Bd0538cfBa97E',
  XMONEY_LEGACY_L3: '0xa72Ab0874A57Ab0F950Bf61B096b01b183A3CB7c',
  ORBIT_ROLLUP: '0x5868266C0c0663f4bc39329B525884f137BAD93E',
  ORBIT_INBOX: '0xa7087693676F2Ca8e5e9563A6859952258688146',
  ORBIT_OUTBOX: '0xA6f07dd42CFE78EC8D88484b238b3B05149Eb2b3',
  ORBIT_BRIDGE: '0x2290f4505484f055B710e7Df37e2482c90B8B6fb',
  ORBIT_SEQUENCER_INBOX: '0xCA038a032154d0091b019A9104b369F94FD5c75F',
  ORBIT_UPGRADE_EXECUTOR: '0x43E881A831Ec5680aa6f63d2b48913050038b9F9',
  /** 2-of-3 Safe owned by the three validators; the rollup's fast confirmer. */
  ORBIT_FAST_CONFIRM_SAFE: '0x17fC7585A3c99ACC2A7CFC1842C119d7FBB12cBC',
  /** On the L4 itself: ArbOS network + infra fee accounts point here; it splits L4 fees across the validators. */
  VALIDATOR_FEE_SPLITTER_L4: '0xa924c725b64cc346f275269efa4bd0538cfba97e',
  ORBIT_OWNER: '0xC3D6cED85829b5FA236515C21B3161B7e2cEB14F',
  XMONEY_TIMELOCK: '0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B',
  ORBIT_DEPLOY_TX: '0x79e5c8e5e762cfee50360c708e003346b3aef3861beb690500ddae2500d36a4d',
  // PLACEHOLDER: the L4 app contracts are not deployed on 466302 yet. Fill these three from the deploy-l3-apps
  // broadcast (same values as l4.escrow / l4.fomo / l4.router in l4-deployment.json) before the site switch.
  // The live values also arrive from /api/l4-info at boot; these are only the compiled-in fallback.
  XMONEY_ESCROW_L4: '',
  FOMO_ATTRITION_L4: '',
  XGAS_ROUTER: '',
  ARB_SYS: '0x0000000000000000000000000000000000000064',
  FEE_FANOUT: '0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e',
  /** XGAS.DEV on Robinhood: the 0.02% leg of every L4 fee path buys it and burns it (XgasDevBuyback). */
  XGAS_DEV: '0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3',
  /**
   * RobinhoodEthOtc on Robinhood Chain #4663: P2P desk for dollars on X Money (off-chain) <-> native ETH (escrowed).
   * Empty until deployed. The live value comes from GET /api/robinhood/otc (l3.robinhoodOtc in l4-deployment.json);
   * this is only the compiled-in fallback.
   */
  ROBINHOOD_OTC: '0x534df478ea378C1B4A596a10f8d3b5659486a8Cb',
  /** OtcArbitration on Robinhood Chain #4663 (staked arbiters, commit-reveal). l3.otcArbitration; empty until deployed. */
  OTC_ARBITRATION: '0x16BCd95b5eB685DfaA04295462564d56979f35b4',
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


// ---------------------------------------------------------------------------
// RobinhoodEthOtc on Robinhood Chain #4663 (contracts/src/RobinhoodEthOtc.sol)
// Dollars on X Money (off-chain, X account to X account) <-> native ETH (escrowed here). Not the $xMoney token.
// ABI generated from the compiled contract (forge build); regenerate if the contract changes.
//   Side: 0 = Sell (maker escrows ETH, wants dollars), 1 = Buy (maker has dollars, wants ETH).
//   TradeStatus: 0 Open, 1 Paid, 2 Released, 3 Claimed, 4 CancelledUnpaid, 5 Disputed, 6 Resolved.
//   priceCentsPerEth = US cents per 1 ETH (1e18 wei). Order and trade ids are array indexes.
// ---------------------------------------------------------------------------
export const ROBINHOOD_OTC_SIDE = { SELL: 0, BUY: 1 } as const;
export const ROBINHOOD_OTC_STATUS = {
  OPEN: 0, PAID: 1, RELEASED: 2, CLAIMED: 3, CANCELLED_UNPAID: 4, DISPUTED: 5, RESOLVED: 6,
} as const;

// Generated from contracts/out/RobinhoodEthOtc.sol/RobinhoodEthOtc.json (functions, events, custom errors).
export const ROBINHOOD_OTC_ABI = [
  {"type":"constructor","inputs":[{"name":"weth_","type":"address","internalType":"address"},{"name":"feeFanout_","type":"address","internalType":"address"},{"name":"arbitration_","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"BOND_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"FEE_BPS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"MAX_HANDLE_BYTES","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"MAX_NOTE_BYTES","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"MAX_REASON_BYTES","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"MIN_BOND","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"PAY_WINDOW","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"PUSH_GAS","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"RELEASE_WINDOW","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"arbitration","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},
  {"type":"function","name":"bondFor","inputs":[{"name":"ethAmount","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},
  {"type":"function","name":"cancelOrder","inputs":[{"name":"orderId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"cancelUnpaid","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"claim","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"dispute","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"},{"name":"reason","type":"string","internalType":"string"}],"outputs":[],"stateMutability":"payable"},
  {"type":"function","name":"ethOwed","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"feeFanout","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},
  {"type":"function","name":"feeFor","inputs":[{"name":"ethAmount","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},
  {"type":"function","name":"flagged","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"flushFees","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"getOrder","inputs":[{"name":"orderId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"tuple","internalType":"struct RobinhoodEthOtc.Order","components":[{"name":"maker","type":"address","internalType":"address"},{"name":"side","type":"uint8","internalType":"enum RobinhoodEthOtc.Side"},{"name":"makerXHandle","type":"string","internalType":"string"},{"name":"priceCentsPerEth","type":"uint256","internalType":"uint256"},{"name":"remainingEth","type":"uint256","internalType":"uint256"},{"name":"minEth","type":"uint256","internalType":"uint256"},{"name":"maxEth","type":"uint256","internalType":"uint256"},{"name":"active","type":"bool","internalType":"bool"},{"name":"cancelled","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"getOrders","inputs":[{"name":"offset","type":"uint256","internalType":"uint256"},{"name":"limit","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"out","type":"tuple[]","internalType":"struct RobinhoodEthOtc.Order[]","components":[{"name":"maker","type":"address","internalType":"address"},{"name":"side","type":"uint8","internalType":"enum RobinhoodEthOtc.Side"},{"name":"makerXHandle","type":"string","internalType":"string"},{"name":"priceCentsPerEth","type":"uint256","internalType":"uint256"},{"name":"remainingEth","type":"uint256","internalType":"uint256"},{"name":"minEth","type":"uint256","internalType":"uint256"},{"name":"maxEth","type":"uint256","internalType":"uint256"},{"name":"active","type":"bool","internalType":"bool"},{"name":"cancelled","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"getTrade","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"tuple","internalType":"struct RobinhoodEthOtc.Trade","components":[{"name":"orderId","type":"uint256","internalType":"uint256"},{"name":"seller","type":"address","internalType":"address"},{"name":"buyer","type":"address","internalType":"address"},{"name":"sellerXHandle","type":"string","internalType":"string"},{"name":"buyerXHandle","type":"string","internalType":"string"},{"name":"ethAmount","type":"uint256","internalType":"uint256"},{"name":"expectedCents","type":"uint256","internalType":"uint256"},{"name":"openedAt","type":"uint64","internalType":"uint64"},{"name":"paidAt","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum RobinhoodEthOtc.TradeStatus"},{"name":"paymentNote","type":"string","internalType":"string"}]}],"stateMutability":"view"},
  {"type":"function","name":"getTrades","inputs":[{"name":"offset","type":"uint256","internalType":"uint256"},{"name":"limit","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"out","type":"tuple[]","internalType":"struct RobinhoodEthOtc.Trade[]","components":[{"name":"orderId","type":"uint256","internalType":"uint256"},{"name":"seller","type":"address","internalType":"address"},{"name":"buyer","type":"address","internalType":"address"},{"name":"sellerXHandle","type":"string","internalType":"string"},{"name":"buyerXHandle","type":"string","internalType":"string"},{"name":"ethAmount","type":"uint256","internalType":"uint256"},{"name":"expectedCents","type":"uint256","internalType":"uint256"},{"name":"openedAt","type":"uint64","internalType":"uint64"},{"name":"paidAt","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum RobinhoodEthOtc.TradeStatus"},{"name":"paymentNote","type":"string","internalType":"string"}]}],"stateMutability":"view"},
  {"type":"function","name":"markPaid","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"},{"name":"paymentNote","type":"string","internalType":"string"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"onDisputeResolved","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"},{"name":"outcome","type":"uint8","internalType":"enum Outcome"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"openTradeOf","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"ordersLength","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"pendingFanout","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"postBuy","inputs":[{"name":"makerXHandle","type":"string","internalType":"string"},{"name":"ethWanted","type":"uint256","internalType":"uint256"},{"name":"priceCentsPerEth","type":"uint256","internalType":"uint256"},{"name":"minEth","type":"uint256","internalType":"uint256"},{"name":"maxEth","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"orderId","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"postSell","inputs":[{"name":"makerXHandle","type":"string","internalType":"string"},{"name":"priceCentsPerEth","type":"uint256","internalType":"uint256"},{"name":"minEth","type":"uint256","internalType":"uint256"},{"name":"maxEth","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"orderId","type":"uint256","internalType":"uint256"}],"stateMutability":"payable"},
  {"type":"function","name":"release","inputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"takeBuy","inputs":[{"name":"orderId","type":"uint256","internalType":"uint256"},{"name":"sellerXHandle","type":"string","internalType":"string"}],"outputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"stateMutability":"payable"},
  {"type":"function","name":"takeSell","inputs":[{"name":"orderId","type":"uint256","internalType":"uint256"},{"name":"ethAmount","type":"uint256","internalType":"uint256"},{"name":"buyerXHandle","type":"string","internalType":"string"}],"outputs":[{"name":"tradeId","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"totalEthOwed","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"tradeOutcome","inputs":[{"name":"","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint8","internalType":"enum Outcome"}],"stateMutability":"view"},
  {"type":"function","name":"tradesLength","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"weth","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},
  {"type":"function","name":"withdrawEth","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"withdrawEthTo","inputs":[{"name":"to","type":"address","internalType":"address payable"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"wrapAndSendFee","inputs":[{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"event","name":"BuyerFlagged","inputs":[{"name":"buyer","type":"address","indexed":true,"internalType":"address"},{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"EthCredited","inputs":[{"name":"account","type":"address","indexed":true,"internalType":"address"},{"name":"amount","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"EthWithdrawn","inputs":[{"name":"account","type":"address","indexed":true,"internalType":"address"},{"name":"to","type":"address","indexed":true,"internalType":"address"},{"name":"amount","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"FeeDeferred","inputs":[{"name":"pendingFanout","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"FeeRouted","inputs":[{"name":"toFanoutWeth","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"OrderCancelled","inputs":[{"name":"orderId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"maker","type":"address","indexed":true,"internalType":"address"},{"name":"refundedEth","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"OrderPosted","inputs":[{"name":"orderId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"maker","type":"address","indexed":true,"internalType":"address"},{"name":"side","type":"uint8","indexed":false,"internalType":"enum RobinhoodEthOtc.Side"},{"name":"makerXHandle","type":"string","indexed":false,"internalType":"string"},{"name":"priceCentsPerEth","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"ethAmount","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"minEth","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"maxEth","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"OrderRefilled","inputs":[{"name":"orderId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"ethReturned","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"remainingEth","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"active","type":"bool","indexed":false,"internalType":"bool"}],"anonymous":false},
  {"type":"event","name":"TradeCancelled","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"ethReturned","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"returnedToOrder","type":"bool","indexed":false,"internalType":"bool"}],"anonymous":false},
  {"type":"event","name":"TradeClaimed","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"buyer","type":"address","indexed":true,"internalType":"address"},{"name":"netEth","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"fee","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"TradeDisputed","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"seller","type":"address","indexed":true,"internalType":"address"},{"name":"bond","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"reason","type":"string","indexed":false,"internalType":"string"}],"anonymous":false},
  {"type":"event","name":"TradeOpened","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"orderId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"seller","type":"address","indexed":true,"internalType":"address"},{"name":"buyer","type":"address","indexed":false,"internalType":"address"},{"name":"sellerXHandle","type":"string","indexed":false,"internalType":"string"},{"name":"buyerXHandle","type":"string","indexed":false,"internalType":"string"},{"name":"ethAmount","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"expectedCents","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"payBy","type":"uint64","indexed":false,"internalType":"uint64"}],"anonymous":false},
  {"type":"event","name":"TradePaid","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"buyer","type":"address","indexed":true,"internalType":"address"},{"name":"paymentNote","type":"string","indexed":false,"internalType":"string"},{"name":"claimableAt","type":"uint64","indexed":false,"internalType":"uint64"}],"anonymous":false},
  {"type":"event","name":"TradeReleased","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"buyer","type":"address","indexed":true,"internalType":"address"},{"name":"netEth","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"fee","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"TradeResolved","inputs":[{"name":"tradeId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"outcome","type":"uint8","indexed":false,"internalType":"enum Outcome"},{"name":"toBuyer","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"toSeller","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"fee","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"error","name":"BadOutcome","inputs":[]},
  {"type":"error","name":"BadStatus","inputs":[]},
  {"type":"error","name":"BuyerBusy","inputs":[]},
  {"type":"error","name":"FlaggedAddress","inputs":[]},
  {"type":"error","name":"InvalidAmount","inputs":[]},
  {"type":"error","name":"InvalidHandle","inputs":[]},
  {"type":"error","name":"InvalidPrice","inputs":[]},
  {"type":"error","name":"NothingOwed","inputs":[]},
  {"type":"error","name":"OrderNotActive","inputs":[]},
  {"type":"error","name":"OrderNotFound","inputs":[]},
  {"type":"error","name":"OutOfRange","inputs":[]},
  {"type":"error","name":"PayWindowClosed","inputs":[]},
  {"type":"error","name":"PayWindowOpen","inputs":[]},
  {"type":"error","name":"ReentrancyGuardReentrantCall","inputs":[]},
  {"type":"error","name":"ReleaseWindowClosed","inputs":[]},
  {"type":"error","name":"ReleaseWindowOpen","inputs":[]},
  {"type":"error","name":"SelfTrade","inputs":[]},
  {"type":"error","name":"TextTooLong","inputs":[]},
  {"type":"error","name":"TradeNotFound","inputs":[]},
  {"type":"error","name":"TransferFailed","inputs":[]},
  {"type":"error","name":"Unauthorized","inputs":[]},
  {"type":"error","name":"WrongBond","inputs":[]},
  {"type":"error","name":"WrongSide","inputs":[]},
  {"type":"error","name":"ZeroAddress","inputs":[]},
] as const;
