// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {XMoney} from "../src/XMoney.sol";
import {MockUSDG} from "./MockUSDG.sol";
import {MockBridge, MockInbox} from "./XMoney.t.sol";

/// Thermostat item 6: the retryable params are bounded, and the L4 gas prepay is paid from the
/// depositor's own gross, so no deposit (of any size, at any in-bounds setting) can lower r/s.
contract XMoneyVaultTest is Test {
    XMoney token; MockUSDG usdg; MockBridge bridge; MockInbox inbox;
    address alice = address(0xA11CE); address bob = address(0xB0B); address carol = address(0xCA201);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    address constant USDG_ADDRESS = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // 0.000001, 0.1, 1, 2, 10 USDG
    uint256[5] AMOUNTS = [uint256(1), 100_000, 1_000_000, 2_000_000, 10_000_000];

    function setUp() public {
        vm.etch(USDG_ADDRESS, address(new MockUSDG()).code); usdg = MockUSDG(USDG_ADDRESS);
        token = new XMoney();
        bridge = new MockBridge(address(token));
        inbox = new MockInbox(bridge, token);
        token.setBridgeSystem(address(inbox), address(bridge));
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            usdg.mint(users[i], 10_000_000e6);
            vm.prank(users[i]); usdg.approve(address(token), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- helpers
    function _nav() internal view returns (uint256 nav) { (nav,,) = token.getReserveNAV(); }
    function _circulating() internal view returns (uint256) { return token.totalSupply() - token.balanceOf(DEAD); }
    function _fee() internal view returns (uint256) { return token.l4GasLimit() * token.l4MaxFeePerGas(); }

    /// Push NAV off 1.0 so deposits price at a non-trivial ratio: a deposit, taxed transfers, a partial exit.
    function _seed() internal {
        vm.prank(bob); token.enterRollupToL3(1_000e6);
        uint256 b = token.balanceOf(bob);
        vm.prank(bob); token.transfer(carol, b / 2);
        uint256 c = token.balanceOf(carol);
        vm.prank(carol); token.exitRollup(c / 3);
        vm.prank(alice); token.enterRollup(250e6, alice);
        assertGt(_nav(), 1e18);
    }

    /// Deposit via the L4 path; tiny deposits that cannot cover the gas prepay must revert and leave NAV alone.
    function _enterAndCheck(address who, uint256 amount) internal {
        uint256 navBefore = _nav();
        uint256 supplyBefore = token.totalSupply();
        uint256 reserveBefore = usdg.balanceOf(address(token));
        uint256 fee = _fee();

        vm.prank(who);
        try token.enterRollup(amount, who) returns (uint256 bridged) {
            assertGe(_nav(), navBefore, "NAV fell on enterRollup");
            // every xMoney minted is backed: supply grew by exactly the gross the net USDG buys
            uint256 rake = (amount * token.FANOUT_RAKE_BPS()) / 10000;
            uint256 netUsdg = amount - rake;
            assertEq(usdg.balanceOf(address(token)) - reserveBefore, netUsdg, "reserve delta");
            uint256 minted = token.totalSupply() - supplyBefore;
            uint256 entryBurn = minted / 10000; // gross * BURN_BPS / 10000, up to rounding
            assertApproxEqAbs(minted, bridged + fee + entryBurn, 1, "no mint beyond gross");
            assertEq(inbox.lastL3CallValue(), bridged, "call value");
        } catch (bytes memory err) {
            assertEq(bytes4(err), XMoney.DepositBelowL4Fee.selector, "unexpected revert");
            assertEq(_nav(), navBefore);
            assertEq(token.totalSupply(), supplyBefore);
        }
    }

    // ---------------------------------------------------------------- NAV never decreases on deposits
    function test_navNeverDecreases_enterRollupToL3_fresh() public {
        uint256 last = _nav();
        for (uint256 i; i < AMOUNTS.length; i++) {
            vm.prank(alice); token.enterRollupToL3(AMOUNTS[i]);
            uint256 nav = _nav();
            assertGe(nav, last, "NAV fell");
            last = nav;
        }
    }

    function test_navNeverDecreases_enterRollupToL3_seeded() public {
        _seed();
        for (uint256 i; i < AMOUNTS.length; i++) {
            uint256 before = _nav();
            vm.prank(alice); token.enterRollupToL3(AMOUNTS[i]);
            assertGe(_nav(), before, "NAV fell");
        }
    }

    function test_navNeverDecreases_enterRollup_defaultParams() public {
        _seed();
        for (uint256 i; i < AMOUNTS.length; i++) _enterAndCheck(alice, AMOUNTS[i]);
    }

    function test_navNeverDecreases_enterRollup_maxParams() public {
        token.setL4RetryableParams(token.MAX_L4_GAS_LIMIT(), token.MAX_L4_MAX_FEE_PER_GAS());
        _seed();
        for (uint256 i; i < AMOUNTS.length; i++) _enterAndCheck(alice, AMOUNTS[i]);
    }

    function test_navNeverDecreases_enterRollup_minParams() public {
        token.setL4RetryableParams(token.MIN_L4_GAS_LIMIT(), token.MIN_L4_MAX_FEE_PER_GAS());
        _seed();
        for (uint256 i; i < AMOUNTS.length; i++) _enterAndCheck(alice, AMOUNTS[i]);
    }

    /// The deposit sizes that used to lower r/s under the default params (gross under ~2 xMoney) now do not.
    function test_smallDepositsNoLongerDilute() public {
        _seed();
        for (uint256 amt = 10_000; amt <= 2_000_000; amt += 99_999) _enterAndCheck(alice, amt);
    }

    function test_dustDepositToL4RevertsCleanly() public {
        _seed();
        vm.prank(alice);
        vm.expectPartialRevert(XMoney.DepositBelowL4Fee.selector);
        token.enterRollup(1, alice); // 1e-6 USDG buys ~1e-6 xMoney, far below the 1e-4 xMoney gas prepay
    }

    function testFuzz_navNeverDecreases(uint96 amount, uint256 gasLimit, uint256 fee, bool toL4) public {
        gasLimit = bound(gasLimit, token.MIN_L4_GAS_LIMIT(), token.MAX_L4_GAS_LIMIT());
        fee = bound(fee, token.MIN_L4_MAX_FEE_PER_GAS(), token.MAX_L4_MAX_FEE_PER_GAS());
        uint256 amt = bound(uint256(amount), 1, 1_000_000e6);
        token.setL4RetryableParams(gasLimit, fee);
        _seed();
        if (toL4) {
            _enterAndCheck(alice, amt);
        } else {
            uint256 before = _nav();
            vm.prank(alice); token.enterRollupToL3(amt);
            assertGe(_nav(), before);
        }
    }

    // ---------------------------------------------------------------- setter bounds
    function test_setterAcceptsBoundsAndEmits() public {
        vm.expectEmit(address(token));
        emit XMoney.L4RetryableParamsSet(1_000_000, 10 gwei);
        token.setL4RetryableParams(1_000_000, 10 gwei);
        assertEq(token.l4GasLimit(), 1_000_000);
        assertEq(token.l4MaxFeePerGas(), 10 gwei);
        token.setL4RetryableParams(21_000, 0.01 gwei);
        assertEq(token.l4GasLimit(), 21_000);
        assertEq(token.l4MaxFeePerGas(), 0.01 gwei);
    }

    function test_setterRevertsBeyondBounds() public {
        uint256 gMin = token.MIN_L4_GAS_LIMIT(); uint256 gMax = token.MAX_L4_GAS_LIMIT();
        uint256 fMin = token.MIN_L4_MAX_FEE_PER_GAS(); uint256 fMax = token.MAX_L4_MAX_FEE_PER_GAS();
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(gMax + 1, fMin);
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(gMin - 1, fMin);
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(gMin, fMax + 1);
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(gMin, fMin - 1);
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(1, fMin); // Nitro sentinel
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(gMin, 1); // Nitro sentinel
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(0, 0);
        // the setting that crashed NAV from 1.00005 to 0.379 in the scratch test
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(1_000_000_000, 1 gwei);
        vm.expectRevert(XMoney.L4ParamsOutOfBounds.selector); token.setL4RetryableParams(type(uint256).max, type(uint256).max);
        // unchanged
        assertEq(token.l4GasLimit(), 100_000);
        assertEq(token.l4MaxFeePerGas(), 1 gwei);
    }

    function test_setterOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.setL4RetryableParams(100_000, 1 gwei);
    }

    // ---------------------------------------------------------------- round trip accounting
    function test_roundTripEnterExitAccounting() public {
        _seed();
        uint256 navStart = _nav();
        uint256 fanoutStart = usdg.balanceOf(FANOUT);
        uint256 aliceUsdgStart = usdg.balanceOf(alice);
        uint256 fee = _fee();

        uint256 amount = 1_000e6;
        vm.prank(alice); uint256 bridged = token.enterRollup(amount, alice);
        uint256 enterRake = amount / 10000;
        assertEq(usdg.balanceOf(FANOUT) - fanoutStart, enterRake);

        // Outbox releases alice's call value plus the whole gas prepay (as if none of it was used), taxed 0.01%
        uint256 withdrawn = bridged + fee;
        bridge.release(alice, withdrawn);
        uint256 got = token.balanceOf(alice);
        assertEq(got, withdrawn - withdrawn / 10000);

        uint256 reserveBefore = usdg.balanceOf(address(token));
        uint256 circBefore = _circulating();
        uint256 expectedGross = (got * reserveBefore) / circBefore;
        uint256 exitRake = expectedGross / 10000;

        vm.prank(alice); uint256 out = token.exitRollup(got);
        assertEq(out, expectedGross - exitRake);
        assertEq(reserveBefore - usdg.balanceOf(address(token)), expectedGross, "reserve debited by gross");
        assertEq(usdg.balanceOf(FANOUT) - fanoutStart, enterRake + exitRake, "fanout got both rakes");
        assertEq(usdg.balanceOf(alice), aliceUsdgStart - amount + out);
        assertEq(token.balanceOf(alice), 0);
        // round trip costs alice only the rakes, burns and tax (well under 0.1%)
        assertGt(out, (amount * 999) / 1000);
        assertLe(out, amount);
        assertGe(_nav(), navStart, "NAV fell over the round trip");
    }

    /// Every circulating xMoney, bridge buffer included, can be redeemed and the vault never runs dry early.
    function test_fullDrainIsSolvent() public {
        vm.prank(alice); token.enterRollup(500e6, alice);
        vm.prank(bob); uint256 b = token.enterRollup(0.1e6, bob);
        vm.prank(carol); token.enterRollupToL3(2e6);
        // release everything the bridge holds (call values, gas prepays, buffer) to the depositors
        uint256 held = token.balanceOf(address(bridge));
        bridge.release(bob, b);
        bridge.release(alice, held - b);
        assertEq(token.balanceOf(address(bridge)), 0);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; i++) {
            uint256 bal = token.balanceOf(users[i]);
            vm.prank(users[i]); token.exitRollup(bal);
        }
        assertEq(_circulating(), 0);
        // exit rounding only ever leaves dust behind, never a shortfall
        assertLt(usdg.balanceOf(address(token)), 10);
    }
}
