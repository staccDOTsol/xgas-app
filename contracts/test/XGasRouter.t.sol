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

    function setUp() public {
        FANOUT = address(new FanoutSink(PARENT_FANOUT));
        router = new XGasRouter(payable(FANOUT));
        vm.deal(alice, 100 ether);
    }

    function test_sendValueWithBurnAndFanoutRake() public {
        uint256 bobBefore = bob.balance;
        uint256 deadBefore = DEAD.balance;
        uint256 fanoutBefore = FANOUT.balance;

        // Alice routes 10 native gas to Bob
        // 1 bp (0.01%) = 0.001 ether burned to DEAD
        // 1 bp (0.01%) = 0.001 ether raked to FANOUT
        // 9.998 ether delivered to Bob
        vm.prank(alice);
        (uint256 net, uint256 burn, uint256 rake) = router.sendValue{value: 10 ether}(bob, "p2p_payment");

        assertEq(burn, 0.001 ether);
        assertEq(rake, 0.001 ether);
        assertEq(net, 9.998 ether);
        assertEq(DEAD.balance - deadBefore, 0.001 ether);
        assertEq(FANOUT.balance - fanoutBefore, 0.001 ether);
        assertEq(bob.balance - bobBefore, 9.998 ether);
        assertEq(router.totalNativeBurned(), 0.001 ether);
        assertEq(router.totalFanoutRaked(), 0.001 ether);
        assertEq(router.totalNativeRouted(), 10 ether);
    }
}
