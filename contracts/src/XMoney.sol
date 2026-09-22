// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20Inbox {
    function createRetryableTicket(
        address to,
        uint256 l3CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        uint256 tokenTotalFeeAmount,
        bytes calldata data
    ) external returns (uint256);
}

interface ILegacyXMoney is IERC20 {
    function exitRollup(uint256 xMoneyAmount) external returns (uint256 usdgOut);
}

/**
 * @title XMoney — native gas token of the xgas Orbit L4, vaulted 100% by USDG on Robinhood Chain
 * @notice A TAX TOKEN: every transfer burns 0.01% to 0x…dEaD.
 *         The one exception is transfers INTO the Orbit bridge system (Inbox / Bridge): there the
 *         0.01% is not burned but retained by the bridge as backing, so that for every deposit the
 *         bridge holds exactly what the L4 mints. Withdrawals OUT of the bridge burn as usual.
 *         On top of that, half of the vault's entry burn is minted to the bridge as a permanent
 *         solvency buffer instead of going to 0xdead.
 *
 *         enterRollup: USDG in → 0.01% USDG rake to Fanout → xMoney minted → bridged to the L4 as
 *         native gas via a retryable ticket to the recipient, in ONE transaction.
 *         exitRollup:  xMoney (withdrawn from the L4 through the Outbox) → 0.01% USDG rake → USDG out.
 */
contract XMoney is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    IERC20 public constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    ILegacyXMoney public constant LEGACY = ILegacyXMoney(0xa72Ab0874A57Ab0F950Bf61B096b01b183A3CB7c);

    uint256 public constant SCALE_FACTOR = 1e12;   // 6 -> 18 decimals
    uint256 public constant BURN_BPS = 1;          // 0.01% transfer tax + entry burn
    uint256 public constant FANOUT_RAKE_BPS = 1;   // 0.01% USDG rake to Fanout on entry/exit

    // xgas Orbit L4 bridge system on Robinhood Chain (set once after the rollup is created)
    address public inbox;
    address public bridge;
    mapping(address => bool) public isBridgeSystem;

    // Retryable params for the L4 leg of enterRollup (auto-redeemed on arrival; excess refunded to recipient)
    uint256 public l4GasLimit = 100_000;
    uint256 public l4MaxFeePerGas = 1 gwei;

    uint256 public totalXMoneyBurned;
    uint256 public totalUsdgRakedToFanout;
    uint256 public totalUsdgDeposited;
    uint256 public totalXMoneyBridgedToL4;
    uint256 public totalBridgeBuffer; // xMoney minted to the bridge as solvency buffer

    event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned, uint256 retryableTicketId);
    event RollupExited(address indexed user, uint256 xMoneyBurned, uint256 usdgReturned, uint256 usdgRaked);
    event SupplyBurn(address indexed from, uint256 xMoneyBurned);
    event BridgeSystemSet(address inbox, address bridge);
    event Migrated(address indexed user, uint256 legacyIn, uint256 usdgRecovered, uint256 xMoneyOut);

    error InvalidAmount();
    error InsufficientBalance();
    error BridgeNotSet();

    constructor() ERC20("X Money", "xMoney") Ownable(msg.sender) {}

    // ---------------------------------------------------------------- admin (one-time wiring)
    function setBridgeSystem(address _inbox, address _bridge) external onlyOwner {
        if (inbox != address(0)) { isBridgeSystem[inbox] = false; isBridgeSystem[bridge] = false; }
        inbox = _inbox;
        bridge = _bridge;
        isBridgeSystem[_inbox] = true;
        isBridgeSystem[_bridge] = true;
        emit BridgeSystemSet(_inbox, _bridge);
    }

    function setL4RetryableParams(uint256 gasLimit, uint256 maxFeePerGas) external onlyOwner {
        l4GasLimit = gasLimit;
        l4MaxFeePerGas = maxFeePerGas;
    }

    // ---------------------------------------------------------------- enter: USDG -> xMoney -> L4 native gas
    function enterRollup(uint256 usdgAmount, address l3Recipient) public returns (uint256 xMoneyBridged) {
        if (usdgAmount == 0) revert InvalidAmount();
        if (bridge == address(0)) revert BridgeNotSet();
        address recipient = l3Recipient == address(0) ? msg.sender : l3Recipient;

        (uint256 net, uint256 usdgRake, uint256 burnToDead, uint256 bufferToBridge) = _deposit(usdgAmount);
        xMoneyBridged = net;

        // The L4 leg: mint to ourselves, pre-fund the inbox (untaxed: bridge system), create the ticket.
        uint256 l4Fee = l4GasLimit * l4MaxFeePerGas;
        uint256 total = net + l4Fee;
        _mint(address(this), total);
        _transfer(address(this), inbox, total);
        uint256 ticket = IERC20Inbox(inbox).createRetryableTicket(
            recipient, net, 0, recipient, recipient, l4GasLimit, l4MaxFeePerGas, total, ""
        );
        totalXMoneyBridgedToL4 += net;

        emit RollupEntered(msg.sender, recipient, usdgAmount, net, usdgRake, burnToDead + bufferToBridge, ticket);
    }

    /// @notice Same as enterRollup but keeps the xMoney on Robinhood Chain (bridge it yourself via the Inbox).
    function enterRollupToL3(uint256 usdgAmount) external returns (uint256 xMoneyMinted) {
        if (usdgAmount == 0) revert InvalidAmount();
        (uint256 net, uint256 usdgRake, uint256 burnToDead, uint256 bufferToBridge) = _deposit(usdgAmount);
        _mint(msg.sender, net);
        emit RollupEntered(msg.sender, msg.sender, usdgAmount, net, usdgRake, burnToDead + bufferToBridge, 0);
        return net;
    }

    function _deposit(uint256 usdgAmount) internal returns (uint256 net, uint256 usdgRake, uint256 burnToDead, uint256 bufferToBridge) {
        USDG.safeTransferFrom(msg.sender, address(this), usdgAmount);

        usdgRake = (usdgAmount * FANOUT_RAKE_BPS) / 10000;
        uint256 netUsdgToReserve = usdgAmount - usdgRake;
        totalUsdgRakedToFanout += usdgRake;
        totalUsdgDeposited += usdgAmount;
        if (usdgRake > 0) USDG.safeTransfer(FANOUT, usdgRake);

        uint256 gross = _grossXMoneyFor(netUsdgToReserve);
        uint256 entryBurn = (gross * BURN_BPS) / 10000;
        net = gross - entryBurn;

        // half the entry burn to 0xdead, half to the bridge as a solvency buffer
        bufferToBridge = bridge != address(0) ? entryBurn / 2 : 0;
        burnToDead = entryBurn - bufferToBridge;
        if (burnToDead > 0) { totalXMoneyBurned += burnToDead; _mint(DEAD, burnToDead); emit SupplyBurn(address(0), burnToDead); }
        if (bufferToBridge > 0) { totalBridgeBuffer += bufferToBridge; _mint(bridge, bufferToBridge); }
    }

    function _grossXMoneyFor(uint256 netUsdgToReserve) internal view returns (uint256) {
        uint256 reserveBefore = USDG.balanceOf(address(this)) - netUsdgToReserve;
        uint256 circulating = totalSupply() - balanceOf(DEAD);
        if (circulating == 0 || reserveBefore == 0) return netUsdgToReserve * SCALE_FACTOR;
        return (netUsdgToReserve * circulating) / reserveBefore;
    }

    // ---------------------------------------------------------------- exit: xMoney (on L3) -> USDG
    function exitRollup(uint256 xMoneyAmount) public returns (uint256 usdgOut) {
        if (xMoneyAmount == 0 || balanceOf(msg.sender) < xMoneyAmount) revert InsufficientBalance();

        uint256 circulating = totalSupply() - balanceOf(DEAD);
        uint256 reserve = USDG.balanceOf(address(this));
        uint256 grossUsdg = (xMoneyAmount * reserve) / circulating;

        uint256 usdgRake = (grossUsdg * FANOUT_RAKE_BPS) / 10000;
        usdgOut = grossUsdg - usdgRake;
        totalUsdgRakedToFanout += usdgRake;

        _burn(msg.sender, xMoneyAmount);
        if (usdgRake > 0) USDG.safeTransfer(FANOUT, usdgRake);
        USDG.safeTransfer(msg.sender, usdgOut);

        emit RollupExited(msg.sender, xMoneyAmount, usdgOut, usdgRake);
    }

    // ---------------------------------------------------------------- migration from the legacy vault
    /// @notice Swap legacy xMoney (0xa72A…) for the new token: legacy claim is redeemed for its USDG,
    ///         which is deposited here at NAV. Approve LEGACY to this contract first.
    function migrate(uint256 legacyAmount, address l3Recipient) external returns (uint256 xMoneyOut) {
        if (legacyAmount == 0) revert InvalidAmount();
        LEGACY.transferFrom(msg.sender, address(this), legacyAmount);
        uint256 received = LEGACY.balanceOf(address(this)); // legacy taxes 0.01% on the way in
        uint256 usdg = LEGACY.exitRollup(received);          // legacy vault pays USDG to us

        // deposit the recovered USDG on the user's behalf (no second rake: it was raked on legacy exit)
        totalUsdgDeposited += usdg;
        uint256 gross = _grossXMoneyFor(usdg);
        uint256 entryBurn = (gross * BURN_BPS) / 10000;
        xMoneyOut = gross - entryBurn;
        uint256 bufferToBridge = bridge != address(0) ? entryBurn / 2 : 0;
        uint256 burnToDead = entryBurn - bufferToBridge;
        if (burnToDead > 0) { totalXMoneyBurned += burnToDead; _mint(DEAD, burnToDead); emit SupplyBurn(address(0), burnToDead); }
        if (bufferToBridge > 0) { totalBridgeBuffer += bufferToBridge; _mint(bridge, bufferToBridge); }

        address recipient = l3Recipient == address(0) ? msg.sender : l3Recipient;
        if (bridge != address(0)) {
            uint256 l4Fee = l4GasLimit * l4MaxFeePerGas;
            uint256 total = xMoneyOut + l4Fee;
            _mint(address(this), total);
            _transfer(address(this), inbox, total);
            IERC20Inbox(inbox).createRetryableTicket(recipient, xMoneyOut, 0, recipient, recipient, l4GasLimit, l4MaxFeePerGas, total, "");
            totalXMoneyBridgedToL4 += xMoneyOut;
        } else {
            _mint(msg.sender, xMoneyOut);
        }
        emit Migrated(msg.sender, legacyAmount, usdg, xMoneyOut);
    }

    // ---------------------------------------------------------------- the tax
    function _update(address from, address to, uint256 value) internal virtual override {
        // mints, burns, burn-sink traffic and deposits INTO the bridge system move in full
        if (from == address(0) || to == address(0) || from == DEAD || to == DEAD || isBridgeSystem[to]) {
            super._update(from, to, value);
            return;
        }
        uint256 tax = (value * BURN_BPS) / 10000;
        if (tax > 0) {
            totalXMoneyBurned += tax;
            super._update(from, DEAD, tax);
            emit SupplyBurn(from, tax);
        }
        super._update(from, to, value - tax);
    }

    function getReserveNAV() external view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney) {
        usdgReserve = USDG.balanceOf(address(this));
        circulatingXMoney = totalSupply() - balanceOf(DEAD);
        if (circulatingXMoney == 0) return (1e18, usdgReserve, 0);
        navRay = (usdgReserve * SCALE_FACTOR * 1e18) / circulatingXMoney;
    }
}
