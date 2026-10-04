import { parseAbi } from 'viem';

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

export const VAULT_ABI = parseAbi([
  'function enterRollup(uint256 usdgAmount, address l3Recipient) returns (uint256 xMoneyBridged)',
  'function enterRollupToL3(uint256 usdgAmount) returns (uint256 xMoneyMinted)',
  'function exitRollup(uint256 xMoneyAmount) returns (uint256 usdgOut)',
  'function getReserveNAV() view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function bridge() view returns (address)',
  'function inbox() view returns (address)',
  'function l4GasLimit() view returns (uint256)',
  'function l4MaxFeePerGas() view returns (uint256)',
  // The deployed vault (0xa924…a97E) names its retryable gas params l3*, not l4*.
  'function l3GasLimit() view returns (uint256)',
  'function l3MaxFeePerGas() view returns (uint256)',
  'function totalXMoneyBurned() view returns (uint256)',
  'function totalUsdgRakedToFanout() view returns (uint256)',
  'function totalUsdgDeposited() view returns (uint256)',
  'function totalXMoneyBridgedToL4() view returns (uint256)',
  'function totalBridgeBuffer() view returns (uint256)',
  'event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned, uint256 retryableTicketId)',
  'event RollupExited(address indexed user, uint256 xMoneyBurned, uint256 usdgReturned, uint256 usdgRaked)',
]);

// EarlyDepositor on Robinhood: USDG -> vault.enterRollupToL2 -> this chain's ERC20Inbox, one retryable to the
// recipient (never aliased). Source: relaunch-466302/early/src/EarlyDepositor.sol.
export const EARLY_DEPOSITOR_ABI = parseAbi([
  'function deposit(uint256 usdgAmount, address l3Recipient) returns (uint256 ticketId)',
  'function INBOX() view returns (address)',
  'function defaultGasLimit() view returns (uint256)',
  'function defaultMaxFeePerGas() view returns (uint256)',
  'function bridgeDeficit() view returns (uint256)',
  'event EarlyDeposit(address indexed sender, address indexed l3Recipient, uint256 indexed ticketId, uint256 usdgIn, uint256 xMoneyMinted, uint256 l3Deposit, uint256 l2CallValue, uint256 bridgeReceived, uint256 gasLimit, uint256 maxFeePerGas)',
  'error RecipientIsContract(address recipient)',
  'error DepositTooSmall(uint256 l3Deposit, uint256 gasPrepay)',
]);

export const ARBSYS_ABI = parseAbi([
  'function withdrawEth(address destination) payable returns (uint256)',
  'event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)',
]);

export const OUTBOX_ABI = parseAbi([
  'function isSpent(uint256 index) view returns (bool)',
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)',
]);

export const ROLLUP_ABI = parseAbi([
  'function latestConfirmed() view returns (bytes32)',
  'function confirmPeriodBlocks() view returns (uint64)',
  'event AssertionConfirmed(bytes32 indexed assertionHash, bytes32 blockHash, bytes32 sendRoot)',
]);

export const ESCROW_ABI = parseAbi([
  'function orders(uint256) view returns (address maker, string makerXHandle, uint8 side, uint256 availableXMoney, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount, bool active)',
  'function trades(uint256) view returns (uint256 orderId, uint8 side, address seller, string sellerXHandle, address buyer, string buyerXHandle, uint256 xMoneyAmount, uint256 expectedCents, uint256 deadline, bool completed, bool cancelled)',
  'function nextOrderId() view returns (uint256)',
  'function nextTradeId() view returns (uint256)',
  'function totalXMoneyBurned() view returns (uint256)',
  'function totalXMoneyRakedToFanout() view returns (uint256)',
  'function totalXMoneyToBuyback() view returns (uint256)',
  'function totalSettledVolumeXMoney() view returns (uint256)',
  'function TRADE_TIMEOUT() view returns (uint256)',
  'function createSellAsk(string makerXHandle, uint256 xMoneyAmount, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount) payable returns (uint256 orderId)',
  'function createBuyBid(string makerXHandle, uint256 maxXMoneyWanted, uint256 fiatRateBps, uint256 minAmount, uint256 maxAmount) returns (uint256 orderId)',
  'function fillSellAsk(uint256 orderId, uint256 xMoneyAmount, string buyerXHandle) returns (uint256 tradeId)',
  'function fillBuyBid(uint256 orderId, uint256 xMoneyAmount, string sellerXHandle) payable returns (uint256 tradeId)',
  'function releaseTrade(uint256 tradeId)',
  'function cancelTradeTimeout(uint256 tradeId)',
  'function cancelOrder(uint256 orderId)',
]);

// NguToken: basePrice is uint256 in the Solidity source (src/contracts/nguAbis.ts declares
// it uint16, which would decode the low 16 bits of an 18-decimal price). uint256 here.
export const NGU_TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function basePrice() view returns (uint256)',
  'function betaBps() view returns (uint16)',
  'function stepBps() view returns (uint16)',
  'function floor() view returns (uint256)',
  'function nextPrice() view returns (uint256)',
  'function lastPrice() view returns (uint256)',
  'function reserve() view returns (uint256)',
  'function supply() view returns (uint256)',
  'function minted() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function maxLossBps() view returns (uint256)',
  'function BUYBACK_BPS() view returns (uint16)', // reverts on curves launched before the XGAS.DEV buyback
  'function seedQty() view returns (uint256)',
  'function quoteBuy(uint256 qty) view returns (uint256 cost)',
  'function quoteSell(uint256 qty) view returns (uint256 payout)',
  'function buy(uint256 qty, address to) payable returns (uint256 cost)',
  'function sell(uint256 qty, address to, uint256 minOut) returns (uint256 payout)',
  'function donate() payable',
]);

export const NGU_LAUNCHER_ABI = parseAbi([
  'function allTokens(uint256) view returns (address)',
  'function allTokensLength() view returns (uint256)',
  'function fanoutSink() view returns (address)',
  'function buybackSink() view returns (address)',
  'function isNguToken(address) view returns (bool)',
  'function launch(string name, string symbol, uint256 maxSupply, uint256 basePrice, uint16 stepBps, uint16 betaBps, uint256 seedQty) payable returns (address token)',
]);

// Curve limits, mirrored from NguToken.sol.
export const NGU_LIMITS = { MAX_STEP_BPS: 5000, MIN_BETA_BPS: 5000, MAX_BETA_BPS: 9500, MAX_PER_TX: 50 };

// XSwapIntents / XSwapAsks on the parent chain (Robinhood 4663): X Money in, anything on any EVM chain out,
// and the other direction. Kept in lockstep with staccpad's src/contracts/xswap.ts and xswap-solver.mjs.
export const XSWAP_INTENTS_ABI = parseAbi([
  'struct Policy { uint32 minFilled; uint16 maxFailBps; uint16 minBondBps; bool trustedOnly; }',
  'struct Intent { address user; uint256 amount; uint256 fee; uint64 deadline; uint64 bidEnds; uint64 claimedAt; address solver; uint256 ask; uint256 bond; uint8 state; bytes32 want; Policy policy; }',
  'function open(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string memo)',
  'function openWith(bytes32 id, uint256 amount, uint64 deadline, bytes32 want, string memo, Policy policy)',
  'function accept(bytes32 id)',
  'function confirm(bytes32 id)',
  'function dispute(bytes32 id, string reason)',
  'function refund(bytes32 id)',
  'function bid(bytes32 id, uint256 ask)',
  'function claim(bytes32 id, bytes32 proof)',
  'function settle(bytes32 id)',
  'function setPolicy(Policy p)',
  'function setTrusted(address solver, bool trusted)',
  'function withdraw() returns (uint256)',
  'function get(bytes32 id) view returns (Intent)',
  'function rep(address) view returns (uint64 filled, uint64 failed, uint64 opened, uint64 disputed, uint64 disputesLost, uint128 volume, uint64 since)',
  'function policyOf(address) view returns (uint32 minFilled, uint16 maxFailBps, uint16 minBondBps, bool trustedOnly)',
  'function canClaim(bytes32 id, address who) view returns (bool ok, string why, uint256 bond)',
  'function credit(address) view returns (uint256)',
  'function window() view returns (uint64)',
  'function bidding() view returns (uint64)',
  'function bondBps() view returns (uint16)',
  'function feeBps() view returns (uint16)',
  'function treasury() view returns (address)',
  'function xmoney() view returns (address)',
  'event Opened(bytes32 indexed id, address indexed user, uint256 amount, uint64 deadline, bytes32 want, string memo)',
  'event Bid(bytes32 indexed id, address indexed solver, uint256 ask, uint256 bond)',
  'event Claimed(bytes32 indexed id, address indexed solver, uint256 bond, bytes32 proof)',
  'event Settled(bytes32 indexed id, address indexed solver, uint256 paid, uint256 fee, uint256 backToUser)',
]);

export const XSWAP_ASKS_ABI = parseAbi([
  'struct Ask { address seller; uint256 floorPay; uint64 deadline; uint64 bidEnds; uint64 deliveredAt; address buyer; uint256 pay; uint256 bond; uint8 state; bytes32 give; }',
  'function ask(bytes32 id, uint256 floorPay, uint64 deadline, bytes32 give, string memo)',
  'function bid(bytes32 id, uint256 pay)',
  'function accept(bytes32 id)',
  'function delivered(bytes32 id, bytes32 proof)',
  'function confirm(bytes32 id)',
  'function settle(bytes32 id)',
  'function dispute(bytes32 id, string reason)',
  'function cancel(bytes32 id)',
  'function withdraw() returns (uint256)',
  'function get(bytes32 id) view returns (Ask)',
  'function credit(address) view returns (uint256)',
  'function window() view returns (uint64)',
  'function bidding() view returns (uint64)',
  'function bondBps() view returns (uint16)',
  'function feeBps() view returns (uint16)',
  'function treasury() view returns (address)',
  'event Asked(bytes32 indexed id, address indexed seller, uint256 floorPay, uint64 deadline, bytes32 give, string memo)',
  'event Bid(bytes32 indexed id, address indexed buyer, uint256 pay, uint256 bond)',
  'event Delivered(bytes32 indexed id, address indexed seller, bytes32 proof)',
  'event Settled(bytes32 indexed id, address indexed seller, uint256 paid, uint256 fee)',
]);

// Reviewed site-fee V2 escrows on Robinhood. Kept separate from the fee-free legacy ABI so a
// legacy bid(bytes32,uint256) can never be decoded as V2 bid(bytes32,uint256,uint256).
export const XSWAP_V2_INTENTS_ABI = parseAbi([
  'struct Policy { uint32 minFilled; uint16 maxFailBps; uint16 minBondBps; bool trustedOnly; }',
  'struct Intent { address user; uint256 amount; uint256 escrowed; uint16 protocolBps; uint16 openedBondBps; uint64 challengeWindow; address protocolTreasury; address siteFeeRecipient; uint16 siteFeeBps; uint64 deadline; uint64 bidEnds; uint64 claimedAt; address solver; uint256 ask; uint256 bond; uint8 state; bytes32 want; Policy policy; }',
  'function openWithSiteFee(bytes32 id,uint256 grossWalletDebit,uint256 escrowCeiling,uint64 deadline,bytes32 want,string memo,Policy policy,address siteFeeRecipient,uint16 siteFeeBps,bytes32 expectedTermsHash)',
  'function bid(bytes32 id,uint256 ask,uint256 maxBondGrossDebit)',
  'function accept(bytes32 id)', 'function claim(bytes32 id,bytes32 proof)',
  'function confirm(bytes32 id)', 'function dispute(bytes32 id,string reason)',
  'function refund(bytes32 id)', 'function settle(bytes32 id)', 'function withdraw() returns (uint256)',
  'function get(bytes32 id) view returns (Intent)',
  'function rep(address) view returns (uint64 filled,uint64 failed,uint64 opened,uint64 disputed,uint64 disputesLost,uint128 volume,uint64 since)',
  'function canClaim(bytes32 id,address who) view returns (bool ok,string why,uint256 bond)',
  'function credit(address) view returns (uint256)',
  'function owner() view returns (address)', 'function xmoney() view returns (address)',
  'function siteCollector() view returns (address)', 'function treasury() view returns (address)',
  'function window() view returns (uint64)', 'function bidding() view returns (uint64)',
  'function bondBps() view returns (uint16)', 'function feeBps() view returns (uint16)',
  'function termsHash() view returns (bytes32)',
  'event Opened(bytes32 indexed id,address indexed user,uint256 amount,uint64 deadline,bytes32 want,string memo)',
  'event SiteFeeBound(bytes32 indexed id,address indexed recipient,uint16 bps,uint256 escrowed,uint256 ceiling)',
]);

export const XSWAP_V2_ASKS_ABI = parseAbi([
  'struct Ask { address seller; uint256 floorPay; uint256 minSellerNet; uint16 protocolBps; uint16 openedBondBps; uint64 challengeWindow; address protocolTreasury; address siteFeeRecipient; uint16 siteFeeBps; uint64 deadline; uint64 bidEnds; uint64 deliveredAt; address buyer; uint256 pay; uint256 bond; uint8 state; bytes32 give; }',
  'function askWithSiteFee(bytes32 id,uint256 minSellerNet,uint64 deadline,bytes32 give,string memo,address siteFeeRecipient,uint16 siteFeeBps,bytes32 expectedTermsHash)',
  'function bid(bytes32 id,uint256 pay,uint256 maxWalletDebit)',
  'function accept(bytes32 id)', 'function delivered(bytes32 id,bytes32 proof)',
  'function confirm(bytes32 id)', 'function dispute(bytes32 id,string reason)',
  'function cancel(bytes32 id)', 'function settle(bytes32 id)', 'function withdraw() returns (uint256)',
  'function get(bytes32 id) view returns (Ask)', 'function credit(address) view returns (uint256)',
  'function owner() view returns (address)', 'function xmoney() view returns (address)',
  'function siteCollector() view returns (address)', 'function treasury() view returns (address)',
  'function window() view returns (uint64)', 'function bidding() view returns (uint64)',
  'function bondBps() view returns (uint16)', 'function feeBps() view returns (uint16)',
  'function termsHash() view returns (bytes32)',
  'event Asked(bytes32 indexed id,address indexed seller,uint256 floorPay,uint64 deadline,bytes32 give,string memo)',
  'event SiteFeeBound(bytes32 indexed id,address indexed recipient,uint16 bps,uint256 minSellerNet)',
]);
