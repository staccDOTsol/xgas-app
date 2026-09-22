// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {XMoneyUSD} from "../src/XMoneyUSD.sol";
import {MockUSDG} from "./MockUSDG.sol";

contract XMoneyUSDTest is Test {
    XMoneyUSD public token;
    MockUSDG public mockUsdg;

    address payable public alice = payable(address(0x1111));
    address payable public bob = payable(address(0x2222));
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    address public constant USDG_ADDRESS = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function setUp() public {
        MockUSDG impl = new MockUSDG();
        vm.etch(USDG_ADDRESS, address(impl).code);
        mockUsdg = MockUSDG(USDG_ADDRESS);

        token = new XMoneyUSD();

        mockUsdg.mint(alice, 10_000 * 1e6);
        vm.prank(alice);
        mockUsdg.approve(address(token), type(uint256).max);
    }

    function test_enterRollupBridgesToL4() public {
        uint256 fanoutBefore = mockUsdg.balanceOf(FANOUT);

        // Alice enters rollup with 1,000 USDG
        vm.prank(alice);
        uint256 bridged = token.enterRollup(1000 * 1e6, alice);

        // 1. Fanout gets 0.01% USDG rake
        assertEq(mockUsdg.balanceOf(FANOUT) - fanoutBefore, 100000);
        // 2. Reserve has 999.9 USDG
        assertEq(mockUsdg.balanceOf(address(token)), 999900000);
        // 3. Alice gets bridged xMoney
        assertEq(token.balanceOf(alice), bridged);
        // 4. Dead has 0.01% xMoney burn
        assertTrue(token.balanceOf(DEAD) > 0);
    }

    function test_exitRollupReturnsReserve() public {
        vm.prank(alice);
        uint256 bridged = token.enterRollup(1000 * 1e6, alice);

        uint256 aliceUsdgBefore = mockUsdg.balanceOf(alice);

        // Alice exits rollup with half of her gas
        vm.prank(alice);
        uint256 usdgOut = token.exitRollup(bridged / 2);

        assertTrue(usdgOut > 0);
        assertTrue(mockUsdg.balanceOf(alice) > aliceUsdgBefore);
    }
}
