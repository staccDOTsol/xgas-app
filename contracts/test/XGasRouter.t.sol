// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {XGasRouter} from "../src/XGasRouter.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

contract XGasRouterTest is Test {
    XGasRouter public router;
    address payable public alice = payable(address(0x1111));
    address payable public bob = payable(address(0x2222));
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The L4 rake lands in a FanoutSink that bridges to the Robinhood fanout; the sink IS the fanout here.
    address public constant PARENT_FANOUT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address public FANOUT;
    address public BUYBACK;

    function setUp() public {
        FANOUT = address(new FanoutSink(PARENT_FANOUT));
        BUYBACK = address(new FanoutSink(makeAddr("xgasDevBuyback")));
        router = new XGasRouter(payable(FANOUT), payable(BUYBACK));
        vm.deal(alice, 100 ether);
    }

    function test_sendValueWithBurnAndFanoutRake() public {
        uint256 bobBefore = bob.balance;
        uint256 deadBefore = DEAD.balance;
        uint256 fanoutBefore = FANOUT.balance;

        // Alice routes 10 native gas to Bob
        // 1 bp (0.01%) = 0.001 ether burned to DEAD
        // 1 bp (0.01%) = 0.001 ether raked to FANOUT
        // 2 bp (0.02%) = 0.002 ether to the XGAS.DEV buyback sink
        // 9.996 ether delivered to Bob
        vm.prank(alice);
        (uint256 net, uint256 burn, uint256 rake, uint256 buyback) = router.sendValue{value: 10 ether}(bob, "p2p_payment");

        assertEq(burn, 0.001 ether);
        assertEq(rake, 0.001 ether);
        assertEq(buyback, 0.002 ether);
        assertEq(net, 9.996 ether);
        assertEq(DEAD.balance - deadBefore, 0.001 ether);
        assertEq(FANOUT.balance - fanoutBefore, 0.001 ether);
        assertEq(BUYBACK.balance, 0.002 ether);
        assertEq(bob.balance - bobBefore, 9.996 ether);
        assertEq(router.totalNativeBurned(), 0.001 ether);
        assertEq(router.totalFanoutRaked(), 0.001 ether);
        assertEq(router.totalBuyback(), 0.002 ether);
        assertEq(router.totalNativeRouted(), 10 ether);
    }

    function test_plainTransferRevertsAndTrapsNothing() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(ret), XGasRouter.UseSendValue.selector);
        assertEq(address(router).balance, 0);
        assertEq(alice.balance, 100 ether);
        assertEq(router.totalNativeRouted(), 0);
        assertEq(DEAD.balance, 0);
        assertEq(FANOUT.balance, 0);
        assertEq(BUYBACK.balance, 0);

        // Unknown calldata has no fallback either.
        vm.prank(alice);
        (ok, ) = address(router).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(router).balance, 0);
    }

    function test_sendValueToRouterItselfReverts() public {
        vm.prank(alice);
        vm.expectRevert(XGasRouter.TransferFailed.selector);
        router.sendValue{value: 1 ether}(payable(address(router)), "loop");
        assertEq(address(router).balance, 0);
    }

    function testFuzz_sendValueLeavesNothingBehind(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(alice, amount);
        vm.prank(alice);
        (uint256 net, uint256 burn, uint256 rake, uint256 buyback) = router.sendValue{value: amount}(bob, "");
        assertEq(net + burn + rake + buyback, amount);
        assertEq(address(router).balance, 0);
        assertEq(buyback, (uint256(amount) * 2) / 10000);
    }
}
