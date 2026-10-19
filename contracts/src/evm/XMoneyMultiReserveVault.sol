// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title XMoneyMultiReserveVault
 * @notice Child-chain $xMoney backed by more than one 6-decimal reserve.
 *         On the Plasma Orbit child those reserves are the bridged USDT0 and
 *         USDC (L1ERC20Gateway.calculateL2TokenAddress). Both are 6 decimals,
 *         so each unit mints and redeems at the same 1e12 scale as USDG.
 *         Enter and exit name which reserve moves. The 1 bp rake, 1 bp entry
 *         burn, and 1 bp transfer burn match XMoneyErc20Vault.
 */
contract XMoneyMultiReserveVault is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BURN_BPS = 1;
    uint256 public constant FANOUT_RAKE_BPS = 1;
    uint256 public constant SCALE = 1e12;

    address public immutable fanout;
    address[] public reserves;
    mapping(address => bool) public isReserve;

    address public inbox;
    address public bridge;
    mapping(address => bool) public isBridgeSystem;

    uint256 public totalXMoneyBurned;
    uint256 public totalReserveRakedToFanout;

    event Entered(
        address indexed reserve,
        address indexed user,
        address indexed recipient,
        uint256 reserveIn,
        uint256 xMoneyMinted,
        uint256 reserveRaked,
        uint256 xMoneyBurned
    );
    event Exited(address indexed reserve, address indexed user, uint256 xMoneyBurned, uint256 reserveReturned, uint256 reserveRaked);
    event SupplyBurn(address indexed from, uint256 xMoneyBurned);
    event BridgeSystemSet(address inbox, address bridge);

    error ZeroAddress();
    error NotReserve(address token);
    error UnsupportedDecimals(address token, uint8 decimals_);
    error DuplicateReserve(address token);
    error InvalidAmount();
    error InsufficientBalance();
    error InsufficientReserve(address token, uint256 have, uint256 need);

    constructor(IERC20[] memory reserves_, address fanout_, address owner_) ERC20("X Money", "xMoney") Ownable(owner_) {
        if (fanout_ == address(0) || owner_ == address(0) || reserves_.length == 0) revert ZeroAddress();
        fanout = fanout_;
        for (uint256 i = 0; i < reserves_.length; i++) {
            address token = address(reserves_[i]);
            if (token == address(0) || token.code.length == 0) revert ZeroAddress();
            if (isReserve[token]) revert DuplicateReserve(token);
            uint8 d = IERC20Metadata(token).decimals();
            if (d != 6) revert UnsupportedDecimals(token, d);
            isReserve[token] = true;
            reserves.push(token);
        }
    }

    function reserveCount() external view returns (uint256) {
        return reserves.length;
    }

    function setBridgeSystem(address _inbox, address _bridge) external onlyOwner {
        if (inbox != address(0)) {
            isBridgeSystem[inbox] = false;
            isBridgeSystem[bridge] = false;
        }
        inbox = _inbox;
        bridge = _bridge;
        isBridgeSystem[_inbox] = true;
        isBridgeSystem[_bridge] = true;
        emit BridgeSystemSet(_inbox, _bridge);
    }

    /// @notice Pull `amount` of `reserve`, rake 1 bp to the fanout, mint the rest as $xMoney.
    function enter(IERC20 reserve, uint256 amount, address recipient) public returns (uint256 minted) {
        if (!isReserve[address(reserve)]) revert NotReserve(address(reserve));
        if (amount == 0) revert InvalidAmount();
        address to = recipient == address(0) ? msg.sender : recipient;

        uint256 balBefore = reserve.balanceOf(address(this));
        reserve.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = reserve.balanceOf(address(this)) - balBefore;
        if (received == 0) revert InvalidAmount();

        uint256 rake = (received * FANOUT_RAKE_BPS) / 10_000;
        if (rake > 0) reserve.safeTransfer(fanout, rake);
        uint256 netReserve = reserve.balanceOf(address(this)) - balBefore;
        if (netReserve == 0) revert InvalidAmount();
        totalReserveRakedToFanout += rake;

        uint256 gross = _grossFor(netReserve);
        uint256 entryBurn = (gross * BURN_BPS) / 10_000;
        minted = gross - entryBurn;

        uint256 bufferToBridge = bridge != address(0) ? entryBurn / 2 : 0;
        uint256 burnToDead = entryBurn - bufferToBridge;
        if (burnToDead > 0) {
            totalXMoneyBurned += burnToDead;
            _mint(DEAD, burnToDead);
            emit SupplyBurn(address(0), burnToDead);
        }
        if (bufferToBridge > 0) _mint(bridge, bufferToBridge);
        if (minted > 0) _mint(to, minted);

        emit Entered(address(reserve), msg.sender, to, received, minted, rake, burnToDead + bufferToBridge);
    }

    /// @notice Burn $xMoney and return value from `reserve` only. The other reserve stays put.
    function exit(IERC20 reserve, uint256 xMoneyAmount) public returns (uint256 reserveOut) {
        if (!isReserve[address(reserve)]) revert NotReserve(address(reserve));
        if (xMoneyAmount == 0 || balanceOf(msg.sender) < xMoneyAmount) revert InsufficientBalance();

        uint256 circulating = totalSupply() - balanceOf(DEAD);
        uint256 valueBefore = totalReserveValue();
        uint256 grossValue = (xMoneyAmount * valueBefore) / circulating;
        uint256 grossReserve = grossValue / SCALE;
        uint256 rake = (grossReserve * FANOUT_RAKE_BPS) / 10_000;
        reserveOut = grossReserve - rake;
        uint256 have = reserve.balanceOf(address(this));
        if (have < grossReserve) revert InsufficientReserve(address(reserve), have, grossReserve);

        totalReserveRakedToFanout += rake;
        _burn(msg.sender, xMoneyAmount);
        if (rake > 0) reserve.safeTransfer(fanout, rake);
        if (reserveOut > 0) reserve.safeTransfer(msg.sender, reserveOut);

        emit Exited(address(reserve), msg.sender, xMoneyAmount, reserveOut, rake);
    }

    function totalReserveValue() public view returns (uint256 value) {
        for (uint256 i = 0; i < reserves.length; i++) {
            value += IERC20(reserves[i]).balanceOf(address(this)) * SCALE;
        }
    }

    function getReserveNAV() external view returns (uint256 navRay, uint256 reserveValue, uint256 circulatingXMoney) {
        reserveValue = totalReserveValue();
        circulatingXMoney = totalSupply() - balanceOf(DEAD);
        if (circulatingXMoney == 0) return (1e18, reserveValue, 0);
        navRay = (reserveValue * 1e18) / circulatingXMoney;
    }

    function _grossFor(uint256 netReserve) internal view returns (uint256) {
        uint256 netValue = netReserve * SCALE;
        uint256 valueBefore = totalReserveValue() - netValue;
        uint256 circulating = totalSupply() - balanceOf(DEAD);
        if (circulating == 0 || valueBefore == 0) return netValue;
        return (netValue * circulating) / valueBefore;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0) || from == DEAD || to == DEAD || isBridgeSystem[to]) {
            super._update(from, to, value);
            return;
        }
        uint256 tax = (value * BURN_BPS) / 10_000;
        if (tax > 0) {
            totalXMoneyBurned += tax;
            super._update(from, DEAD, tax);
            emit SupplyBurn(from, tax);
        }
        super._update(from, to, value - tax);
    }
}
