// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RobinhoodEthOtcFireball} from "../src/fireball/RobinhoodEthOtcFireball.sol";

contract MockFireballWeth is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
}

contract MockFireballFees {
    uint64 public registeredCount;
    mapping(address => bool) public isAssetActive;
    mapping(address => uint256) public booked;
    bool public failHarvest;

    function setOutputs(uint64 n) external { registeredCount = n; }
    function setFailHarvest(bool b) external { failHarvest = b; }
    function ensureAsset(address asset) external { isAssetActive[asset] = registeredCount != 0; }
    function harvest(address asset) external {
        require(!failHarvest, "harvest failed");
        booked[asset] = ERC20(asset).balanceOf(address(this));
    }
}

contract RobinhoodEthOtcFireballTest is Test {
    MockFireballWeth weth;
    MockFireballFees fanout;
    RobinhoodEthOtcFireball desk;
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockFireballWeth();
        fanout = new MockFireballFees();
        desk = new RobinhoodEthOtcFireball(address(weth), address(fanout), makeAddr("arbitration"));
        vm.deal(seller, 10 ether);
        vm.deal(buyer, 10 ether);
    }

    function _release() internal {
        vm.prank(seller);
        uint256 order = desk.postSell{value: 1 ether}("seller", 300_000, 0.1 ether, 1 ether);
        vm.prank(buyer);
        uint256 trade = desk.takeSell(order, 1 ether, "buyer");
        vm.prank(buyer);
        desk.markPaid(trade, "payment ref");
        vm.prank(seller);
        desk.release(trade);
    }

    function test_feeBooksAtomicallyWithBuyerRelease() public {
        fanout.setOutputs(2);
        _release();
        uint256 fee = 1 ether / 1000;
        assertEq(desk.pendingFanout(), 0);
        assertEq(weth.balanceOf(address(fanout)), fee);
        assertEq(fanout.booked(address(weth)), fee);
    }

    function test_feeDefersWithoutOutputsThenFlushes() public {
        _release();
        uint256 fee = 1 ether / 1000;
        assertEq(desk.pendingFanout(), fee);
        assertEq(weth.balanceOf(address(fanout)), 0);
        fanout.setOutputs(1);
        desk.flushFees();
        assertEq(desk.pendingFanout(), 0);
        assertEq(fanout.booked(address(weth)), fee);
    }

    function test_failedHarvestRollsBackWrapAndTransfer() public {
        fanout.setOutputs(1);
        fanout.setFailHarvest(true);
        _release();
        uint256 fee = 1 ether / 1000;
        assertEq(desk.pendingFanout(), fee);
        assertEq(weth.balanceOf(address(fanout)), 0);
        assertEq(weth.balanceOf(address(desk)), 0);
        fanout.setFailHarvest(false);
        desk.flushFees();
        assertEq(fanout.booked(address(weth)), fee);
    }
}
