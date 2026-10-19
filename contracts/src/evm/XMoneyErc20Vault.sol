// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title XMoneyErc20Vault
 * @notice $xMoney as an ERC-20, backed by a reserve stablecoin, for chains where
 *         $xMoney is not the gas token (Plasma, Tempo). Same economics as
 *         XMoney.enterRollupToL3 / exitRollup on Robinhood:
 *         - 1 bp of the reserve received is raked to `fanout` on enter and exit
 *         - 1 bp of the xMoney minted on entry is burned (to 0xdead, or split
 *           with an optional bridge buffer)
 *         - 1 bp of every ordinary transfer is burned
 *         Transfers into an optional bridge system are untaxed. Leaving that
 *         system unset (the deploy on Plasma and Tempo) makes the exemption a no-op.
 *
 *         No function is payable. Nothing here reads msg.value or address.balance.
 *         The reserve's decimals are read once in the constructor and frozen into
 *         `scaleFactor` (10^(18 - decimals)), so a 6-decimal token scales like USDG
 *         and an 18-decimal token does not get the 1e12 USDG factor applied by mistake.
 *
 *         The amount that backs a mint is the reserve that actually stayed in the
 *         contract after the rake, not the nominal `amount` argument. A fee-on-transfer
 *         reserve therefore cannot mint unbacked xMoney.
 */
contract XMoneyErc20Vault is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant BURN_BPS = 1;
    uint256 public constant FANOUT_RAKE_BPS = 1;

    IERC20 public immutable reserve;
    address public immutable fanout;
    uint8 public immutable reserveDecimals;
    uint256 public immutable scaleFactor;

    address public inbox;
    address public bridge;
    mapping(address => bool) public isBridgeSystem;

    uint256 public totalXMoneyBurned;
    uint256 public totalReserveRakedToFanout;
    uint256 public totalReserveDeposited;
    uint256 public totalBridgeBuffer;

    event Entered(
        address indexed user,
        address indexed recipient,
        uint256 reserveIn,
        uint256 xMoneyMinted,
        uint256 reserveRaked,
        uint256 xMoneyBurned
    );
    event Exited(address indexed user, uint256 xMoneyBurned, uint256 reserveReturned, uint256 reserveRaked);
    event SupplyBurn(address indexed from, uint256 xMoneyBurned);
    event BridgeSystemSet(address inbox, address bridge);

    error ZeroAddress();
    error UnsupportedDecimals(uint8 decimals_);
    error InvalidAmount();
    error InsufficientBalance();

    constructor(IERC20 reserve_, address fanout_, address owner_) ERC20("X Money", "xMoney") Ownable(owner_) {
        if (address(reserve_) == address(0) || fanout_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (address(reserve_).code.length == 0) revert ZeroAddress();
        uint8 d = IERC20Metadata(address(reserve_)).decimals();
        if (d > 18) revert UnsupportedDecimals(d);
        reserve = reserve_;
        fanout = fanout_;
        reserveDecimals = d;
        scaleFactor = 10 ** (18 - uint256(d));
    }

    /// @notice Optional. Marks the Orbit-style inbox and bridge as untaxed recipients.
    ///         Never called by the Plasma or Tempo deploy. Only the timelocked owner.
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

    /// @notice Pull `amount` of the reserve, rake 1 bp to the fanout, mint the rest as $xMoney.
    function enter(uint256 amount, address recipient) public returns (uint256 minted) {
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
        totalReserveDeposited += received;

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
        if (bufferToBridge > 0) {
            totalBridgeBuffer += bufferToBridge;
            _mint(bridge, bufferToBridge);
        }
        if (minted > 0) _mint(to, minted);

        emit Entered(msg.sender, to, received, minted, rake, burnToDead + bufferToBridge);
    }

    /// @notice Burn $xMoney and return the pro-rata reserve, after a 1 bp rake.
    function exit(uint256 xMoneyAmount) public returns (uint256 reserveOut) {
        if (xMoneyAmount == 0 || balanceOf(msg.sender) < xMoneyAmount) revert InsufficientBalance();

        uint256 circulating = totalSupply() - balanceOf(DEAD);
        uint256 reserveBal = reserve.balanceOf(address(this));
        uint256 grossReserve = (xMoneyAmount * reserveBal) / circulating;
        uint256 rake = (grossReserve * FANOUT_RAKE_BPS) / 10_000;
        reserveOut = grossReserve - rake;
        totalReserveRakedToFanout += rake;

        _burn(msg.sender, xMoneyAmount);
        if (rake > 0) reserve.safeTransfer(fanout, rake);
        if (reserveOut > 0) reserve.safeTransfer(msg.sender, reserveOut);

        emit Exited(msg.sender, xMoneyAmount, reserveOut, rake);
    }

    function getReserveNAV() external view returns (uint256 navRay, uint256 reserveBalance, uint256 circulatingXMoney) {
        reserveBalance = reserve.balanceOf(address(this));
        circulatingXMoney = totalSupply() - balanceOf(DEAD);
        if (circulatingXMoney == 0) return (1e18, reserveBalance, 0);
        navRay = (reserveBalance * scaleFactor * 1e18) / circulatingXMoney;
    }

    function _grossFor(uint256 netReserve) internal view returns (uint256) {
        uint256 reserveBefore = reserve.balanceOf(address(this)) - netReserve;
        uint256 circulating = totalSupply() - balanceOf(DEAD);
        if (circulating == 0 || reserveBefore == 0) return netReserve * scaleFactor;
        return (netReserve * circulating) / reserveBefore;
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
