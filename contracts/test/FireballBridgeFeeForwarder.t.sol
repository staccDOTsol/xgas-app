// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FireballBridgeFeeForwarder} from "../src/fireball/FireballBridgeFeeForwarder.sol";
import {FanoutSink} from "../src/FanoutSink.sol";

contract MockBridgeXMoney is ERC20 {
    address public taxableDestination;

    constructor() ERC20("Bridge xMoney", "xM") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTaxDestination(address to) external { taxableDestination = to; }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to == taxableDestination) {
            uint256 tax = amount / 10_000;
            super._update(from, address(0xdead), tax);
            super._update(from, to, amount - tax);
        } else super._update(from, to, amount);
    }
}

contract MockProtocolFanout {
    uint64 public registeredCount;
    mapping(address => bool) public isAssetActive;
    mapping(address => uint256) public booked;
    bool public failHarvest;

    function setOutputs(uint64 count) external { registeredCount = count; }
    function setFailHarvest(bool fail) external { failHarvest = fail; }
    function ensureAsset(address token) external { isAssetActive[token] = registeredCount != 0; }
    function harvest(address token) external {
        require(!failHarvest, "harvest failed");
        booked[token] = ERC20(token).balanceOf(address(this));
    }
}

contract FireballBridgeFeeForwarderTest is Test {
    MockBridgeXMoney token;
    MockProtocolFanout fanout;
    FireballBridgeFeeForwarder forwarder;

    function setUp() public {
        token = new MockBridgeXMoney();
        fanout = new MockProtocolFanout();
        forwarder = new FireballBridgeFeeForwarder(address(token), address(fanout));
        token.setTaxDestination(address(fanout));
    }

    function test_booksOnlyDeliveredBytesAfterTransferTax() public {
        fanout.setOutputs(3);
        token.mint(address(forwarder), 10_000);
        (uint256 sent, uint256 credited) = forwarder.forward();
        assertEq(sent, 10_000);
        assertEq(credited, 9_999);
        assertEq(token.balanceOf(address(forwarder)), 0);
        assertEq(fanout.booked(address(token)), 9_999);
        assertEq(forwarder.totalForwarded(), 10_000);
        assertEq(forwarder.totalCredited(), 9_999);
    }

    function test_noBookingBeforeFirstOutputOrOutboxDelivery() public {
        token.mint(address(forwarder), 100);
        vm.expectRevert(FireballBridgeFeeForwarder.NoOutputs.selector);
        forwarder.forward();
        fanout.setOutputs(1);
        forwarder.forward();
        vm.expectRevert(FireballBridgeFeeForwarder.NothingToForward.selector);
        forwarder.forward();
    }

    function test_failedHarvestLeavesFundsAtForwarder() public {
        fanout.setOutputs(1);
        fanout.setFailHarvest(true);
        token.mint(address(forwarder), 10_000);
        vm.expectRevert("harvest failed");
        forwarder.forward();
        assertEq(token.balanceOf(address(forwarder)), 10_000);
        assertEq(token.balanceOf(address(fanout)), 0);
        assertEq(forwarder.totalForwarded(), 0);
    }

    function test_historicalSinkCannotBeRetargeted() public {
        address oldParent = makeAddr("old fanout");
        FanoutSink oldSink = new FanoutSink(oldParent);
        FanoutSink newSink = new FanoutSink(address(forwarder));
        assertEq(oldSink.fanout(), oldParent);
        assertEq(newSink.fanout(), address(forwarder));
    }
}
