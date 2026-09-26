// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title FomoAttritionL4 (xgas Orbit L4)
 * @notice FOMO3D War of Attrition Engine 100% denominated and settled in NATIVE $xMoney,
 *         the Orbit L4 gas token.
 *         Keys are bought with $xMoney (msg.value).
 *         Dividends are paid in $xMoney.
 *         Grand Jackpot is held and awarded in $xMoney.
 *
 *         On key buys, dividend claims, and jackpot wins:
 *         - 0.01% (1 bp) $xMoney burned permanently to 0x000...dEaD
 *         - 0.01% (1 bp) $xMoney raked to the FanoutSink, which bridges it to the Stacc Wizards Fee Fanout on Robinhood
 *         - 0.02% (2 bp) $xMoney to the buyback sink, which bridges it to XgasDevBuyback (buys + burns XGAS.DEV)
 *
 *         Key buy split: 55% dividends to every key in the round (the buyer's own keys included),
 *         35% to this round's jackpot, 4 bp fees, and the rest (9.96%) carried into the NEXT
 *         round's jackpot. Ledger: balance == jackpotPot + nextRoundSeed + dividendReserve.
 */
contract FomoAttritionL4 {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable FANOUT;
    address public immutable BUYBACK;

    uint256 public constant SCALE = 1e18;
    uint256 public constant MAX_TIME_BUFFER = 24 hours;
    uint256 public constant TIME_PER_KEY = 30 seconds;
    uint256 public constant BURN_BPS = 1;        // 0.01%
    uint256 public constant FANOUT_RAKE_BPS = 1; // 0.01%
    uint256 public constant BUYBACK_BPS = 2;     // 0.02%

    uint256 public roundId;
    uint256 public roundDeadline;
    address public currentLeader;
    string public currentLeaderXHandle;
    uint256 public jackpotPot; // In $xMoney (18 decimals)
    uint256 public totalKeys;
    uint256 public accDividendPerKey;
    uint256 public totalBurned;
    uint256 public totalFanoutRaked;
    uint256 public totalBuyback;
    /// @notice Carried remainder of this round's buys; becomes the next round's opening jackpot.
    uint256 public nextRoundSeed;
    /// @notice Dividends funded and not yet claimed, across all rounds. Every claimable balance
    ///         is paid from here; per-player rounding always leaves dust here, never a shortfall.
    uint256 public dividendReserve;

    struct Player {
        uint256 keys;
        uint256 rewardDebt;
        uint256 pendingDividends;
        string xHandle;
    }

    /// @dev Player state is scoped per round; a finished round's accumulator is frozen so its
    ///      dividends stay claimable forever (see claimDividendsForRound).
    mapping(uint256 => mapping(address => Player)) internal _players;
    mapping(uint256 => uint256) public roundAccDividendPerKey; // frozen at round end

    function players(address player) external view returns (uint256 keys, uint256 rewardDebt, uint256 pendingDividends, string memory xHandle) {
        Player storage p = _players[roundId][player];
        return (p.keys, p.rewardDebt, p.pendingDividends, p.xHandle);
    }

    function playersInRound(uint256 round, address player) external view returns (uint256 keys, uint256 rewardDebt, uint256 pendingDividends, string memory xHandle) {
        Player storage p = _players[round][player];
        return (p.keys, p.rewardDebt, p.pendingDividends, p.xHandle);
    }

    event KeysPurchased(address indexed buyer, string xHandle, uint256 keysBought, uint256 costXMoney, uint256 newDeadline);
    event DividendsClaimed(address indexed player, uint256 amountXMoney);
    event JackpotAwarded(address indexed winner, string xHandle, uint256 jackpotAmountXMoney, uint256 newRoundId);
    event JackpotSeeded(uint256 indexed roundId, uint256 amountXMoney);
    event JackpotDonated(address indexed from, uint256 amountXMoney);

    error RoundExpired();
    error RoundNotExpired();
    error InsufficientPayment();
    error NoDividendsToClaim();
    error TransferFailed();

    constructor(address fanout_, address buyback_) {
        require(fanout_ != address(0), "fanout");
        require(buyback_ != address(0), "buyback");
        FANOUT = fanout_;
        BUYBACK = buyback_;
        _startNewRound();
    }

    function getKeyPrice() public view returns (uint256) {
        // Base price 1.00 $xMoney + 0.001 $xMoney per key minted
        return 1 ether + (totalKeys * 0.001 ether);
    }

    function pendingDividendsOf(address player) external view returns (uint256) {
        return _owed(roundId, player);
    }

    function pendingDividendsOfRound(uint256 round, address player) external view returns (uint256) {
        return _owed(round, player);
    }

    function _accFor(uint256 round) internal view returns (uint256) {
        return round == roundId ? accDividendPerKey : roundAccDividendPerKey[round];
    }

    function _owed(uint256 round, address player) internal view returns (uint256) {
        Player storage p = _players[round][player];
        return _accrued(p.keys, _accFor(round), p.rewardDebt) + p.pendingDividends;
    }

    /// @dev Earned since the debt was set: accumulated rounds DOWN and debt rounds UP, so no
    ///      holder is ever credited more than their exact share (saturates at 0).
    function _accrued(uint256 keys, uint256 acc, uint256 debt) internal pure returns (uint256) {
        uint256 accumulated = (keys * acc) / SCALE;
        return accumulated > debt ? accumulated - debt : 0;
    }

    function _debt(uint256 keys, uint256 acc) internal pure returns (uint256) {
        return (keys * acc + SCALE - 1) / SCALE;
    }

    function buyKeys(string calldata xHandle, uint256 keyCount) external payable {
        if (keyCount == 0) revert InsufficientPayment();
        if (block.timestamp > roundDeadline && totalKeys > 0) revert RoundExpired();

        uint256 price = getKeyPrice();
        uint256 totalCost = price * keyCount;
        if (msg.value < totalCost) revert InsufficientPayment();

        Player storage p = _players[roundId][msg.sender];
        uint256 accBefore = accDividendPerKey;
        if (p.keys > 0) p.pendingDividends += _accrued(p.keys, accBefore, p.rewardDebt);

        p.keys += keyCount;
        // Debt is pinned to the index BEFORE this buy's raise, so the buyer's keys (old and new)
        // earn their pro-rata share of this purchase's dividend instead of it being stranded.
        p.rewardDebt = _debt(p.keys, accBefore);
        p.xHandle = xHandle;
        totalKeys += keyCount;

        currentLeader = msg.sender;
        currentLeaderXHandle = xHandle;

        uint256 timeAdded = keyCount * TIME_PER_KEY;
        uint256 maxPossibleDeadline = block.timestamp + MAX_TIME_BUFFER;
        uint256 base = roundDeadline > block.timestamp ? roundDeadline : block.timestamp;
        if (base + timeAdded > maxPossibleDeadline) {
            roundDeadline = maxPossibleDeadline;
        } else {
            roundDeadline = base + timeAdded;
        }

        (uint256 burnAmount, uint256 rakeAmount, uint256 buybackAmount) = _splitBuy(totalCost);

        emit KeysPurchased(msg.sender, xHandle, keyCount, totalCost, roundDeadline);

        if (burnAmount > 0) _send(DEAD, burnAmount);
        if (rakeAmount > 0) _send(FANOUT, rakeAmount);
        if (buybackAmount > 0) _send(BUYBACK, buybackAmount);

        uint256 refund = msg.value - totalCost;
        if (refund > 0) _send(msg.sender, refund);
    }

    /// @dev Splits in $xMoney: 55% to Dividends, 35% to Grand Jackpot, 0.01% burn, 0.01% Fanout,
    ///      0.02% buyback, remainder (9.96%) seeds the next round's jackpot. Books everything but
    ///      the three fee transfers, which the caller makes.
    function _splitBuy(uint256 totalCost) internal returns (uint256 burnAmount, uint256 rakeAmount, uint256 buybackAmount) {
        burnAmount = (totalCost * BURN_BPS) / 10000;
        rakeAmount = (totalCost * FANOUT_RAKE_BPS) / 10000;
        buybackAmount = (totalCost * BUYBACK_BPS) / 10000;
        uint256 divAmount = (totalCost * 5500) / 10000;
        uint256 jackpotAmount = (totalCost * 3500) / 10000;

        // Reserve what the index raise can ever pay out (rounded up, still <= divAmount); the
        // truncation dust joins the carried remainder instead of sitting unowned in the contract.
        uint256 keys = totalKeys;
        uint256 perKey = (divAmount * SCALE) / keys;
        uint256 divReserved = (perKey * keys + SCALE - 1) / SCALE;
        accDividendPerKey += perKey;

        totalBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalBuyback += buybackAmount;
        jackpotPot += jackpotAmount;
        dividendReserve += divReserved;
        nextRoundSeed += totalCost - burnAmount - rakeAmount - buybackAmount - jackpotAmount - divReserved;
    }

    function claimDividends() external {
        _claim(roundId);
    }

    /// @notice Claim dividends earned in a finished round.
    function claimDividendsForRound(uint256 round) external {
        _claim(round);
    }

    function _claim(uint256 round) internal {
        Player storage p = _players[round][msg.sender];
        uint256 acc = _accFor(round);
        uint256 owed = _accrued(p.keys, acc, p.rewardDebt) + p.pendingDividends;
        if (owed == 0) revert NoDividendsToClaim();

        p.pendingDividends = 0;
        p.rewardDebt = _debt(p.keys, acc);
        dividendReserve -= owed;

        uint256 burnAmount = (owed * BURN_BPS) / 10000;
        uint256 rakeAmount = (owed * FANOUT_RAKE_BPS) / 10000;
        uint256 buybackAmount = (owed * BUYBACK_BPS) / 10000;
        uint256 netPayout = owed - burnAmount - rakeAmount - buybackAmount;

        totalBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalBuyback += buybackAmount;

        emit DividendsClaimed(msg.sender, netPayout);

        if (burnAmount > 0) _send(DEAD, burnAmount);
        if (rakeAmount > 0) _send(FANOUT, rakeAmount);
        if (buybackAmount > 0) _send(BUYBACK, buybackAmount);
        _send(msg.sender, netPayout);
    }

    function claimJackpot() external {
        if (block.timestamp <= roundDeadline) revert RoundNotExpired();
        if (currentLeader == address(0)) revert RoundNotExpired();

        address winner = currentLeader;
        string memory winnerHandle = currentLeaderXHandle;
        uint256 prize = jackpotPot;

        jackpotPot = 0;
        _startNewRound();

        uint256 burnAmount = (prize * BURN_BPS) / 10000;
        uint256 rakeAmount = (prize * FANOUT_RAKE_BPS) / 10000;
        uint256 buybackAmount = (prize * BUYBACK_BPS) / 10000;
        uint256 netJackpot = prize - burnAmount - rakeAmount - buybackAmount;

        totalBurned += burnAmount;
        totalFanoutRaked += rakeAmount;
        totalBuyback += buybackAmount;

        emit JackpotAwarded(winner, winnerHandle, prize, roundId);

        if (burnAmount > 0) _send(DEAD, burnAmount);
        if (rakeAmount > 0) _send(FANOUT, rakeAmount);
        if (buybackAmount > 0) _send(BUYBACK, buybackAmount);
        if (netJackpot > 0) _send(winner, netJackpot);
    }

    function _startNewRound() internal {
        if (roundId > 0) roundAccDividendPerKey[roundId] = accDividendPerKey; // freeze the finished round
        roundId++;
        // The previous round's carried remainder opens this round's jackpot.
        uint256 seed = nextRoundSeed;
        nextRoundSeed = 0;
        jackpotPot += seed;
        if (seed > 0) emit JackpotSeeded(roundId, seed);
        totalKeys = 0;
        accDividendPerKey = 0;
        currentLeader = address(0);
        currentLeaderXHandle = "";
        roundDeadline = block.timestamp + 1 hours;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Plain $xMoney sent here is a donation to the current round's jackpot.
    receive() external payable {
        jackpotPot += msg.value;
        emit JackpotDonated(msg.sender, msg.value);
    }
}
