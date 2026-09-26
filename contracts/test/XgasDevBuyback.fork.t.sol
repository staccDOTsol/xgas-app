// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XgasDevBuyback, PoolKey} from "../src/XgasDevBuyback.sol";

/// @notice Runs against Robinhood Chain: FORK_URL=https://staccpad.fun/rpc forge test --match-path '*fork*'
contract XgasDevBuybackForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant XMONEY = 0xa924C725B64cC346f275269EFA4Bd0538cfBa97E;
    address constant XGAS = 0x006D2D9e65f847e8B5f5053C9eb3a7824ec7dFa3;
    address constant ORBIT_BRIDGE = 0x8b58B2f893770E57e16D8c7551f2E405E9A94E5f; // holds deposited xMoney
    address constant TIMELOCK = 0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B;

    bytes32 constant USDG_POOL_ID = 0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551;
    bytes32 constant XGAS_POOL_ID = 0x33c7e7e6ba4b65dfce2b32ff3fc453371b4048b44448a9591ad2a6c2a1c95bc1;

    XgasDevBuyback bb;
    address keeper = makeAddr("keeper");

    function usdgPool() internal pure returns (PoolKey memory) {
        return PoolKey(address(0), USDG, 0x800000, 10, 0x06a889870C8f83640D6816319f72e2aA579b6080);
    }

    function xgasPool() internal pure returns (PoolKey memory) {
        return PoolKey(address(0), XGAS, 0, 200, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);
    }

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blk);
        bb = new XgasDevBuyback(TIMELOCK, keeper, usdgPool(), xgasPool());
    }

    modifier forked() {
        if (address(bb) == address(0)) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_poolIdsMatchLivePools() public forked {
        assertEq(keccak256(abi.encode(usdgPool())), USDG_POOL_ID, "usdg pool id");
        assertEq(keccak256(abi.encode(xgasPool())), XGAS_POOL_ID, "xgas pool id");
    }

    function test_usdgBuysAndBurnsXgas() public forked {
        vm.prank(XMONEY); // the vault holds the USDG reserve
        IERC20(USDG).transfer(address(bb), 5e6); // 5 USDG

        uint256 supplyBefore = IERC20(XGAS).totalSupply();
        vm.prank(keeper);
        uint256 burned = bb.execute(1);

        assertGt(burned, 0, "bought nothing");
        assertEq(IERC20(XGAS).totalSupply(), supplyBefore - burned, "supply not reduced");
        assertEq(IERC20(XGAS).balanceOf(address(bb)), 0, "xgas left behind");
        assertEq(IERC20(USDG).balanceOf(address(bb)), 0, "usdg left behind");
        assertEq(address(bb).balance, 0, "eth left behind");
        assertEq(bb.totalUsdgSpent(), 5e6);
        emit log_named_decimal_uint("XGAS.DEV burned for 5 USDG", burned, 18);
    }

    function test_xMoneyFromTheOutboxIsRedeemedThenBurned() public forked {
        // the Outbox releases L4 withdrawals as xMoney transfers out of the Orbit bridge
        vm.prank(ORBIT_BRIDGE);
        IERC20(XMONEY).transfer(address(bb), 1 ether);
        uint256 got = IERC20(XMONEY).balanceOf(address(bb));
        assertGt(got, 0);

        uint256 supplyBefore = IERC20(XGAS).totalSupply();
        vm.prank(keeper);
        uint256 burned = bb.execute(1);

        assertGt(burned, 0);
        assertEq(IERC20(XGAS).totalSupply(), supplyBefore - burned);
        assertEq(IERC20(XMONEY).balanceOf(address(bb)), 0, "xMoney not redeemed");
        assertEq(bb.totalXMoneyRedeemed(), got);
        emit log_named_decimal_uint("XGAS.DEV burned for 1 xMoney", burned, 18);
    }

    function test_ethHeldIsSpentToo() public forked {
        vm.deal(address(bb), 0.001 ether);
        vm.prank(keeper);
        uint256 burned = bb.execute(1);
        assertGt(burned, 0);
        assertEq(address(bb).balance, 0);
        assertEq(bb.totalEthSpent(), 0.001 ether);
    }

    function test_minOutIsEnforced() public forked {
        vm.prank(XMONEY);
        IERC20(USDG).transfer(address(bb), 1e6);
        vm.prank(keeper);
        vm.expectRevert();
        bb.execute(type(uint256).max);
    }

    function test_onlyKeeperExecutes() public forked {
        vm.prank(XMONEY);
        IERC20(USDG).transfer(address(bb), 1e6);
        vm.expectRevert(XgasDevBuyback.Unauthorized.selector);
        bb.execute(0);
    }

    function test_onlyOwnerAdmin() public forked {
        vm.expectRevert(XgasDevBuyback.Unauthorized.selector);
        bb.setKeeper(address(this));
        vm.prank(TIMELOCK);
        bb.setKeeper(address(this));
        assertEq(bb.keeper(), address(this));
    }

    function test_rejectsPoolsThatDoNotBuyXgas() public forked {
        PoolKey memory wrong = usdgPool();
        vm.prank(TIMELOCK);
        vm.expectRevert(XgasDevBuyback.BadPool.selector);
        bb.setPools(usdgPool(), wrong);
    }
}
