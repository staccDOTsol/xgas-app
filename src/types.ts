export interface Market {
  id: string;
  name: string;
  ticker: string;
  collectionAddress: string;
  vaultAddress: string;
  image: string;
  description?: string;
  category?: 'vault' | 'curve' | 'graduated' | 'meme' | 'ai' | 'community';
  currentFloorETH: number;
  change24h: number;
  volume24hETH: number;
  marketCapETH: number;
  totalMinted: number;
  maxSupply: number;
  nguProgressPercent: number;
  mintPriceETH: number;
  nextFloorETH: number;
  lockedLpPercent: number;
  vaultInventory?: number;
  activeDesks: ('WETH' | 'USDG' | 'APE')[];
  ticks: ClmmTick[];
  candles: Candle[];
  homecomingFeeAccruedETH?: number;
  verified: boolean;
  creator: string;
  isKingOfTheHill?: boolean;
  replyCount?: number;
  holdersCount?: number;
  lastBumpTime?: number;
  lastBumpType?: 'BUY' | 'SELL' | 'MINT_NGU' | 'SWEEP';
  lastBumpAmount?: number;
  bumpCount?: number;
  createdAt?: string;
}

export interface ClmmTick {
  price: number;
  liquidity: number;
  isCurrent: boolean;
  type: 'bid' | 'ask';
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  id: string;
  marketId: string;
  ticker: string;
  type: 'BUY' | 'SELL' | 'MINT_NGU' | 'SWEEP';
  amountNFT: number;
  priceETH: number;
  totalETH: number;
  desk: 'WETH' | 'USDG';
  trader: string;
  timestamp: string;
  txHash: string;
  isWhale?: boolean;
}

export interface UserWallet {
  connected: boolean;
  address: string;
  balanceETH: number;
  balanceWETH: number;
  balanceUSDG: number;
  homecomingShares?: number;
  nftHoldings: { [marketId: string]: number };
}
