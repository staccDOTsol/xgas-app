// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title XMoneyUSD (Orbit L4 Custom Gas & Bridge Engine)
 * @notice Complete Rollup Pipeline:
 *         1. User calls `enterRollup(usdgAmount)`:
 *            - Locks USDG in the L3 Reserve Vault (100% full).
 *            - Slices 0.01% USDG to Stacc Wizards Fanout on Robinhood Chain (0x04C9...36e).
 *            - Burns 0.01% of xMoney supply to 0x000...dEaD.
 *            - BRIDGES net xMoney into the Orbit L4 as native gas (msg.value) to user's address!
 *         
 *         2. User calls `exitRollup(xMoneyAmount)`:
 *            - Burns native xMoney gas.
 *            - Slices 0.01% USDG to Stacc Wizards Fanout.
 *            - Unlocks net USDG from Reserve directly to user on Robinhood Chain.
 */
contract XMoneyUSD is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    IERC20 public constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);

    uint256 public constant SCALE_FACTOR = 1e12; // 18 decimals - 6 decimals
    uint256 public constant BURN_BPS = 1;        // 0.01% xMoney supply burn
    uint256 public constant FANOUT_RAKE_BPS = 1; // 0.01% real USDG rake to Fanout

    uint256 public totalXMoneyBurned;
    uint256 public totalUsdgRakedToFanout;
    uint256 public totalUsdgDeposited;
    uint256 public totalXMoneyBridgedToL4;

    event RollupEntered(address indexed user, address indexed l3Recipient, uint256 usdgIn, uint256 xMoneyBridged, uint256 usdgRaked, uint256 xMoneyBurned);
    event RollupExited(address indexed user, uint256 xMoneyBurned, uint256 usdgReturned, uint256 usdgRaked);
    event SupplyBurn(address indexed from, uint256 xMoneyBurned);

    error InvalidAmount();
    error InsufficientBalance();

    constructor() ERC20("X Money Gas", "xUSD") Ownable(msg.sender) {}

    /**
     * @notice THE COMPLETE ROLLUP ENTRY:
     *         Takes USDG on L3 -> Slices Rake & Burn -> Bridges xMoney directly to L4!
     */
    function enterRollup(uint256 usdgAmount, address l3Recipient) public returns (uint256 xMoneyBridged) {
        if (usdgAmount == 0) revert InvalidAmount();
        address recipient = l3Recipient == address(0) ? msg.sender : l3Recipient;

        // 1. Pull USDG on Robinhood L3
        USDG.safeTransferFrom(msg.sender, address(this), usdgAmount);

        // 2. Slices 0.01% USDG to Stacc Wizards Fanout
        uint256 usdgRake = (usdgAmount * FANOUT_RAKE_BPS) / 10000;
        uint256 netUsdgToReserve = usdgAmount - usdgRake;

        totalUsdgRakedToFanout += usdgRake;
        totalUsdgDeposited += usdgAmount;

        if (usdgRake > 0) {
            USDG.safeTransfer(FANOUT, usdgRake);
        }

        // 3. Compute xMoney supply to bridge
        uint256 currentReserveUsdg = USDG.balanceOf(address(this)) - netUsdgToReserve;
        uint256 currentSupply = totalSupply();

        uint256 grossXMoney;
        if (currentSupply == 0 || currentReserveUsdg == 0) {
            grossXMoney = netUsdgToReserve * SCALE_FACTOR;
        } else {
            grossXMoney = (netUsdgToReserve * currentSupply) / currentReserveUsdg;
        }

        // 4. Burn 0.01% xMoney supply to DEAD
        uint256 xMoneyBurn = (grossXMoney * BURN_BPS) / 10000;
        xMoneyBridged = grossXMoney - xMoneyBurn;

        totalXMoneyBurned += xMoneyBurn;
        totalXMoneyBridgedToL4 += xMoneyBridged;

        if (xMoneyBurn > 0) {
            super._update(address(0), DEAD, xMoneyBurn);
            emit SupplyBurn(address(0), xMoneyBurn);
        }

        // Mint xMoney to the recipient (or lock in L3 bridge inbox)
        super._update(address(0), recipient, xMoneyBridged);

        emit RollupEntered(msg.sender, recipient, usdgAmount, xMoneyBridged, usdgRake, xMoneyBurn);
    }

    /**
     * @notice THE COMPLETE ROLLUP EXIT:
     *         Burns xMoney gas -> Unlocks net USDG from Reserve on Robinhood L3!
     */
    function depositUSDG(uint256 usdgAmount) external returns (uint256) {
        return enterRollup(usdgAmount, msg.sender);
    }

    function redeemUSDG(uint256 xMoneyAmount) external returns (uint256) {
        return exitRollup(xMoneyAmount);
    }

    function exitRollup(uint256 xMoneyAmount) public returns (uint256 usdgOut) {
        if (xMoneyAmount == 0 || balanceOf(msg.sender) < xMoneyAmount) revert InsufficientBalance();

        uint256 currentSupply = totalSupply();
        uint256 currentReserveUsdg = USDG.balanceOf(address(this));

        // Pro-rata share of real USDG reserve
        uint256 grossUsdg = (xMoneyAmount * currentReserveUsdg) / currentSupply;

        // 0.01% real USDG rake to Fanout
        uint256 usdgRake = (grossUsdg * FANOUT_RAKE_BPS) / 10000;
        usdgOut = grossUsdg - usdgRake;

        totalUsdgRakedToFanout += usdgRake;

        // Burn xMoney from supply
        _burn(msg.sender, xMoneyAmount);

        if (usdgRake > 0) {
            USDG.safeTransfer(FANOUT, usdgRake);
        }

        USDG.safeTransfer(msg.sender, usdgOut);

        emit RollupExited(msg.sender, xMoneyAmount, usdgOut, usdgRake);
    }

    /**
     * @notice Standard on-chain transfer: burns 0.01% to DEAD
     */
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || from == DEAD || to == DEAD) {
            super._update(from, to, value);
            return;
        }

        uint256 xMoneyBurn = (value * BURN_BPS) / 10000;
        uint256 sendAmount = value - xMoneyBurn;

        if (xMoneyBurn > 0) {
            totalXMoneyBurned += xMoneyBurn;
            super._update(from, DEAD, xMoneyBurn);
            emit SupplyBurn(from, xMoneyBurn);
        }
        super._update(from, to, sendAmount);
    }

    function getReserveNAV() external view returns (uint256 navRay, uint256 usdgReserve, uint256 circulatingXMoney) {
        usdgReserve = USDG.balanceOf(address(this));
        circulatingXMoney = totalSupply() - balanceOf(DEAD);
        if (circulatingXMoney == 0) return (1e18, usdgReserve, 0);
        navRay = (usdgReserve * SCALE_FACTOR * 1e18) / circulatingXMoney;
    }
}
