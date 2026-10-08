// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FireballBridgeFeeForwarder} from "../src/fireball/FireballBridgeFeeForwarder.sol";

interface ILiveFireballFanout {
    function fireball() external view returns (address);
    function registeredCount() external view returns (uint64);
    function isAssetActive(address token) external view returns (bool);
    function ensureAsset(address token) external;
    function totalDeposited(address token) external view returns (uint256);
}

/// @notice Fork-only simulation against the deployed parent token and fanout.
///         It never broadcasts or changes live state.
contract FireballBridgeFeeForwarderForkTest is Test {
    address constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address constant FANOUT = 0x0a87Da84277232720e0908CC7470e3A7f925748f;
    address constant FIREBALL = 0xF0545dA454A0b0A18D956d0d8Bd356CC100ef0B9;

    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function test_liveFanoutBooksTaxedOutboxValueOnlyAfterForward() public {
        if (!forked) { vm.skip(true); return; }
        assertEq(block.chainid, 4663);
        ILiveFireballFanout f = ILiveFireballFanout(FANOUT);
        assertEq(f.fireball(), FIREBALL);
        assertGt(f.registeredCount(), 0);

        // This fork action is the required parent-chain registration step.
        f.ensureAsset(XMONEY);
        assertTrue(f.isAssetActive(XMONEY));
        FireballBridgeFeeForwarder forwarder = new FireballBridgeFeeForwarder(XMONEY, FANOUT);

        uint256 delivered = 1 ether;
        deal(XMONEY, address(forwarder), delivered, true);
        uint256 bookedBefore = f.totalDeposited(XMONEY);
        uint256 fanoutBefore = IERC20(XMONEY).balanceOf(FANOUT);
        (uint256 sent, uint256 credited) = forwarder.forward();
        assertEq(sent, delivered);
        assertEq(credited, IERC20(XMONEY).balanceOf(FANOUT) - fanoutBefore);
        assertEq(f.totalDeposited(XMONEY) - bookedBefore, credited);
        assertEq(IERC20(XMONEY).balanceOf(address(forwarder)), 0);
    }
}
