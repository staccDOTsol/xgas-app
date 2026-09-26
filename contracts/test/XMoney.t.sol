// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {XMoney} from "../src/XMoney.sol";
import {XMoneyUSD} from "../src/XMoneyUSD.sol";
import {MockUSDG} from "./MockUSDG.sol";

/// Minimal stand-ins for the Orbit ERC20Inbox / ERC20Bridge token flow (inbox pulls diff from sender,
/// then the bridge pulls the full amount from the inbox), exactly as nitro-contracts v3.2 does.
contract MockBridge {
    address public nativeToken;
    constructor(address t) { nativeToken = t; }
    function enqueue(address inbox, uint256 amount) external {
        XMoney(nativeToken).transferFrom(inbox, address(this), amount);
    }
    function release(address to, uint256 value) external { XMoney(nativeToken).transfer(to, value); }
}
contract MockInbox {
    MockBridge public bridge; XMoney public token; uint256 public lastL3CallValue; address public lastTo;
    constructor(MockBridge b, XMoney t) { bridge = b; token = t; token.approve(address(b), type(uint256).max); }
    function createRetryableTicket(address to, uint256 l3CallValue, uint256, address, address, uint256, uint256, uint256 tokenTotalFeeAmount, bytes calldata) external returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        if (bal < tokenTotalFeeAmount) token.transferFrom(msg.sender, address(this), tokenTotalFeeAmount - bal);
        bridge.enqueue(address(this), tokenTotalFeeAmount);
        lastTo = to; lastL3CallValue = l3CallValue;
        return 1;
    }
}

contract XMoneyTest is Test {
    XMoney token; MockUSDG usdg; MockBridge bridge; MockInbox inbox; XMoneyUSD legacy;
    address alice = address(0xA11CE); address bob = address(0xB0B);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant USDG_ADDRESS = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant LEGACY_ADDRESS = 0xa72Ab0874A57Ab0F950Bf61B096b01b183A3CB7c;

    function setUp() public {
        vm.etch(USDG_ADDRESS, address(new MockUSDG()).code); usdg = MockUSDG(USDG_ADDRESS);
        vm.etch(LEGACY_ADDRESS, address(new XMoneyUSD()).code); legacy = XMoneyUSD(LEGACY_ADDRESS);
        token = new XMoney();
        bridge = new MockBridge(address(token));
        inbox = new MockInbox(bridge, token);
        token.setBridgeSystem(address(inbox), address(bridge));
        usdg.mint(alice, 1_000_000e6); usdg.mint(bob, 1_000_000e6);
        vm.prank(alice); usdg.approve(address(token), type(uint256).max);
        vm.prank(bob); usdg.approve(address(token), type(uint256).max);
    }

    function test_enterRollupBridgesFullAmountAndBridgeIsSolvent() public {
        vm.prank(alice);
        uint256 bridged = token.enterRollup(1000e6, alice);
        // net = 999.9 USDG worth -> 999.9e18 gross -> minus 0.01% entry burn
        uint256 gross = 999_900_000e12;
        uint256 entryBurn = gross / 10000;
        // the L4 gas prepay is paid out of the depositor's own net, not minted on top
        uint256 fee = token.l4GasLimit() * token.l4MaxFeePerGas();
        assertEq(bridged, gross - entryBurn - fee);
        assertEq(inbox.lastTo(), alice);
        assertEq(inbox.lastL3CallValue(), bridged);
        // bridge holds l3CallValue + L4 fee prefund + half the entry burn buffer: NOT taxed on the way in
        assertEq(token.balanceOf(address(bridge)), bridged + fee + entryBurn / 2);
        assertEq(token.balanceOf(DEAD), entryBurn - entryBurn / 2);
        assertEq(token.balanceOf(address(inbox)), 0);
        assertEq(token.balanceOf(address(token)), 0);
        assertEq(usdg.balanceOf(address(token)), 999_900_000); // 999.9 USDG reserve
    }

    function test_withdrawalOutOfBridgeIsTaxedAndExitReturnsUsdg() public {
        vm.prank(alice); uint256 bridged = token.enterRollup(1000e6, alice);
        // simulate the Outbox releasing the withdrawn amount to alice: taxed 0.01%
        bridge.release(alice, bridged);
        uint256 got = token.balanceOf(alice);
        assertEq(got, bridged - bridged / 10000);
        // bridge still backs everything else it owes (buffer + fee prefund remain)
        assertGe(token.balanceOf(address(bridge)), 0);
        uint256 usdgBefore = usdg.balanceOf(alice);
        vm.prank(alice); uint256 out = token.exitRollup(got);
        assertEq(usdg.balanceOf(alice) - usdgBefore, out);
        assertGt(out, 999_000_000); // ~999.7 USDG back (rakes + burns are tiny)
        // NAV ratcheted above 1.0 because burned supply never redeems
        (uint256 nav,,) = token.getReserveNAV();
        assertGt(nav, 1e18);
    }

    function test_plainTransferIsTaxed() public {
        vm.prank(alice); token.enterRollupToL3(100e6);
        uint256 bal = token.balanceOf(alice);
        vm.prank(alice); token.transfer(bob, bal);
        assertEq(token.balanceOf(bob), bal - bal / 10000);
    }

    function test_migrateFromLegacy() public {
        // alice holds legacy xMoney backed by USDG in the legacy vault
        vm.prank(alice); usdg.approve(LEGACY_ADDRESS, type(uint256).max);
        vm.prank(alice); legacy.enterRollup(500e6, alice);
        uint256 legacyBal = legacy.balanceOf(alice);
        vm.prank(alice); legacy.approve(address(token), type(uint256).max);
        vm.prank(alice); uint256 out = token.migrate(legacyBal, alice);
        assertGt(out, 499e18);
        assertEq(inbox.lastL3CallValue(), out);
        assertEq(legacy.balanceOf(alice), 0);
        assertGt(usdg.balanceOf(address(token)), 499e6); // reserve moved over
    }

    function test_enterRevertsWithoutBridge() public {
        XMoney fresh = new XMoney();
        vm.prank(alice); usdg.approve(address(fresh), type(uint256).max);
        vm.prank(alice); vm.expectRevert(XMoney.BridgeNotSet.selector); fresh.enterRollup(1e6, alice);
    }
}
