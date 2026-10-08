// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReferenceFeeERC20, IERC12384} from "../../src/amm/ReferenceFeeERC20.sol";
import {GuardedERC20} from "../../src/amm/GuardedERC20.sol";

/// @dev Plain IERC12384 token: every transfer between two addresses is a reference.
contract PlainToken is ReferenceFeeERC20 {
    constructor(address beneficiary_) ERC20("Ref", "REF") ReferenceFeeERC20(beneficiary_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Launchpad token with an external curve and no beneficiary (all to the sink).
contract CurveToken is GuardedERC20 {
    address public immutable curve;

    constructor(address curve_) ERC20("Curve", "CRV") ReferenceFeeERC20(address(0)) {
        curve = curve_;
    }

    function _curve() internal view override returns (address) {
        return curve;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function graduate() external {
        _graduate();
    }
}

contract ReferenceFeeTest is Test {
    address constant SINK = 0x000000000000000000000000000000000000dEaD;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address treasury = address(0x7EA5);

    PlainToken token;

    function setUp() public {
        token = new PlainToken(treasury);
        token.mint(alice, 1_000_000e18);
        vm.roll(100);
    }

    function feeFor(uint256 value, uint256 n) internal view returns (uint256) {
        return value * token.referenceFeeBps(n) / 10_000;
    }

    // ───────────────────────── schedule ─────────────────────────

    function test_schedule() public view {
        assertEq(token.referenceFeeBps(1), 0, "first is free");
        assertEq(token.referenceFeeBps(2), 40);
        assertEq(token.referenceFeeBps(3), 90);
        assertEq(token.referenceFeeBps(10), 1_000);
        assertEq(token.referenceFeeBps(31), 9_610);
        assertEq(token.referenceFeeBps(32), 10_000, "capped at 100%");
        assertEq(token.referenceFeeBps(1_000), 10_000);
        assertEq(token.sink(), SINK);
        assertEq(token.beneficiary(), treasury);
    }

    function test_noBeneficiaryMeansSink() public {
        PlainToken t = new PlainToken(address(0));
        assertEq(t.beneficiary(), SINK);
    }

    // ───────────────────────── counting ─────────────────────────

    function test_firstReferenceInBlockIsFree() public {
        vm.prank(alice);
        token.transfer(bob, 1_000e18);
        assertEq(token.balanceOf(bob), 1_000e18);
        assertEq(token.referencesThisBlock(), 1);
        assertEq(token.balanceOf(SINK), 0);
    }

    function test_escalatesAcrossTransactionsInOneBlock() public {
        // three separate calls, same block: that is the bundle shape
        vm.prank(alice);
        token.transfer(bob, 1_000e18);
        vm.prank(alice);
        token.transfer(carol, 1_000e18);
        vm.prank(bob);
        token.transfer(carol, 500e18);

        uint256 fee2 = feeFor(1_000e18, 2); // 40 bp
        uint256 fee3 = feeFor(500e18, 3); // 90 bp
        assertEq(token.referencesThisBlock(), 3);
        assertEq(token.balanceOf(carol), 1_000e18 - fee2 + 500e18 - fee3);
        assertEq(token.balanceOf(bob), 1_000e18 - 500e18);
        assertEq(token.balanceOf(SINK), fee2 / 2 + fee3 / 2);
        assertEq(token.balanceOf(treasury), (fee2 - fee2 / 2) + (fee3 - fee3 / 2));
        assertEq(token.totalSupply(), 1_000_000e18, "nothing burned");
    }

    function test_countIsGlobalNotPerSender() public {
        vm.prank(alice);
        token.transfer(bob, 100e18); // n = 1, alice
        vm.prank(bob);
        token.transfer(carol, 100e18); // n = 2, a different sender still pays
        assertEq(token.balanceOf(carol), 100e18 - feeFor(100e18, 2));
    }

    function test_newBlockResets() public {
        vm.prank(alice);
        token.transfer(bob, 1_000e18);
        vm.prank(alice);
        token.transfer(bob, 1_000e18); // n = 2
        vm.roll(101);
        assertEq(token.referencesThisBlock(), 0);
        vm.prank(alice);
        token.transfer(bob, 1_000e18); // n = 1 again, free
        assertEq(token.balanceOf(bob), 1_000e18 + (1_000e18 - feeFor(1_000e18, 2)) + 1_000e18);
    }

    function test_capTakesEverything() public {
        for (uint256 i; i < 31; i++) {
            vm.prank(alice);
            token.transfer(bob, 1e18);
        }
        uint256 before = token.balanceOf(bob);
        vm.prank(alice);
        token.transfer(bob, 1e18); // n = 32: 100%
        assertEq(token.balanceOf(bob), before, "32nd reference delivers nothing");
        assertEq(token.balanceOf(SINK) + token.balanceOf(treasury) > 0, true);
    }

    function test_mintAndBurnAreNotReferences() public {
        token.mint(bob, 5e18);
        token.burn(bob, 1e18);
        assertEq(token.referencesThisBlock(), 0);
        vm.prank(alice);
        token.transfer(bob, 1e18);
        assertEq(token.referencesThisBlock(), 1);
        assertEq(token.balanceOf(bob), 5e18);
    }

    function test_transferFromCountsToo() public {
        vm.prank(alice);
        token.approve(carol, type(uint256).max);
        vm.prank(carol);
        token.transferFrom(alice, bob, 1e18); // n = 1
        vm.prank(carol);
        token.transferFrom(alice, bob, 1e18); // n = 2
        assertEq(token.balanceOf(bob), 2e18 - feeFor(1e18, 2));
    }

    function test_emitsReference() public {
        vm.prank(alice);
        token.transfer(bob, 1e18);
        vm.expectEmit(true, true, false, true);
        emit IERC12384.Reference(alice, bob, 2, feeFor(1e18, 2));
        vm.prank(alice);
        token.transfer(bob, 1e18);
    }

    // ───────────────────────── launchpad guard ─────────────────────────

    function test_curveOnlyBeforeGraduation() public {
        address curve = address(0xC0DE);
        CurveToken t = new CurveToken(curve);
        t.mint(alice, 100e18);

        vm.prank(alice);
        vm.expectRevert(GuardedERC20.CurveOnly.selector);
        t.transfer(bob, 1e18);

        // to and from the curve is fine and is not a reference
        vm.prank(alice);
        t.transfer(curve, 10e18);
        vm.prank(curve);
        t.transfer(bob, 10e18);
        assertEq(t.referencesThisBlock(), 0);
        assertEq(t.balanceOf(bob), 10e18);

        t.graduate();
        vm.prank(alice);
        t.transfer(bob, 1e18); // n = 1
        vm.prank(alice);
        t.transfer(bob, 1e18); // n = 2, 40 bp, all of it to the sink
        assertEq(t.balanceOf(bob), 10e18 + 2e18 - 1e18 * 40 / 10_000);
        assertEq(t.balanceOf(SINK), 1e18 * 40 / 10_000);
        assertEq(t.graduated(), true);
        vm.expectRevert(GuardedERC20.AlreadyGraduated.selector);
        t.graduate();
    }
}
