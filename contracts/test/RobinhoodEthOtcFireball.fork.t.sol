// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {OtcArbitration} from "../src/OtcArbitration.sol";
import {RobinhoodEthOtcFireball} from "../src/fireball/RobinhoodEthOtcFireball.sol";

interface ILiveProtocolFees {
    function registeredCount() external view returns (uint64);
    function isAssetActive(address token) external view returns (bool);
    function totalDeposited(address token) external view returns (uint256);
}

contract RobinhoodEthOtcFireballForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FANOUT = 0x0a87Da84277232720e0908CC7470e3A7f925748f;

    function test_newDeskBooksWethIntoLiveFanout() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(url);
        assertEq(block.chainid, 4663);
        ILiveProtocolFees f = ILiveProtocolFees(FANOUT);
        assertGt(f.registeredCount(), 0);
        assertTrue(f.isAssetActive(WETH));

        OtcArbitration arb = new OtcArbitration();
        RobinhoodEthOtcFireball desk = new RobinhoodEthOtcFireball(WETH, FANOUT, address(arb));
        arb.bind(address(desk));
        address seller = makeAddr("new desk seller");
        address buyer = makeAddr("new desk buyer");
        vm.deal(seller, 2 ether);
        vm.deal(buyer, 1 ether);
        uint256 beforeBooked = f.totalDeposited(WETH);

        vm.prank(seller);
        uint256 order = desk.postSell{value: 1 ether}("seller", 300_000, 0.1 ether, 1 ether);
        vm.prank(buyer);
        uint256 trade = desk.takeSell(order, 1 ether, "buyer");
        vm.prank(buyer);
        desk.markPaid(trade, "payment ref");
        vm.prank(seller);
        desk.release(trade);

        assertEq(desk.pendingFanout(), 0);
        assertEq(f.totalDeposited(WETH) - beforeBooked, 0.001 ether);
    }
}
