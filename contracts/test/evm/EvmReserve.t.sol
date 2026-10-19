// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EvmReserveDeploy} from "../../src/evm/EvmReserveDeploy.sol";
import {XMoneyErc20Vault} from "../../src/evm/XMoneyErc20Vault.sol";
import {ReserveFeeFanout} from "../../src/evm/ReserveFeeFanout.sol";
import {ReserveBuyback} from "../../src/evm/ReserveBuyback.sol";

contract MockReserve is ERC20 {
    uint8 private immutable _d;
    bool public takeFee;

    constructor(uint8 d) ERC20("Reserve", "RSV") {
        _d = d;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(bool on) external {
        takeFee = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (takeFee && from != address(0) && to != address(0) && to != address(0xFEE)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract EvmReserveTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockReserve reserve;
    XMoneyErc20Vault vault;
    ReserveFeeFanout fanout;
    ReserveBuyback buyback;
    address timelock;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        reserve = new MockReserve(6);
        _deploy();
        reserve.mint(alice, 1_000_000e6);
        vm.prank(alice);
        reserve.approve(address(vault), type(uint256).max);
    }

    function _deploy() internal {
        EvmReserveDeploy.Result memory r =
            EvmReserveDeploy.deploy(IERC20(address(reserve)), address(this), owner, keeper, treasury);
        vault = r.vault;
        fanout = r.fanout;
        buyback = r.buyback;
        timelock = address(r.timelock);
    }

    function test_decimalsScaleLikeUsdg() public view {
        assertEq(vault.reserveDecimals(), 6);
        assertEq(vault.scaleFactor(), 1e12);
        assertEq(vault.owner(), timelock);
        assertEq(buyback.owner(), timelock);
        assertEq(fanout.buyback(), address(buyback));
        assertEq(vault.bridge(), address(0));
    }

    function test_eighteenDecimalsDoesNotApplyUsdgScale() public {
        MockReserve wide = new MockReserve(18);
        XMoneyErc20Vault v = new XMoneyErc20Vault(IERC20(address(wide)), address(fanout), timelock);
        assertEq(v.reserveDecimals(), 18);
        assertEq(v.scaleFactor(), 1);
    }

    function test_rejectsOverEighteenDecimals() public {
        MockReserve weird = new MockReserve(19);
        vm.expectRevert(abi.encodeWithSelector(XMoneyErc20Vault.UnsupportedDecimals.selector, uint8(19)));
        new XMoneyErc20Vault(IERC20(address(weird)), address(fanout), timelock);
    }

    function test_enterMintsTransferBurnsExitRedeemsAndRakeHitsFanout() public {
        uint256 amount = 1000e6;
        uint256 fanoutBefore = reserve.balanceOf(address(fanout));

        vm.prank(alice);
        uint256 minted = vault.enter(amount, alice);

        uint256 gross = 999_900_000 * 1e12; // 999.9 reserve units, 6 -> 18
        uint256 entryBurn = gross / 10_000;
        assertEq(minted, gross - entryBurn);
        assertEq(vault.balanceOf(alice), minted);
        assertEq(vault.balanceOf(DEAD), entryBurn);
        assertEq(reserve.balanceOf(address(vault)), 999_900_000);
        assertEq(reserve.balanceOf(address(fanout)) - fanoutBefore, 100_000); // 0.1 reserve

        vm.prank(alice);
        vault.transfer(bob, minted);
        uint256 bobBal = vault.balanceOf(bob);
        assertEq(bobBal, minted - minted / 10_000);
        assertGt(vault.balanceOf(DEAD), entryBurn);

        (uint256 nav,,) = vault.getReserveNAV();
        assertGt(nav, 1e18);

        uint256 aliceReserveBefore = reserve.balanceOf(alice);
        vm.prank(bob);
        uint256 out = vault.exit(bobBal);
        assertEq(reserve.balanceOf(alice), aliceReserveBefore);
        assertEq(reserve.balanceOf(bob), out);
        assertGt(out, 998e6);
        assertGt(reserve.balanceOf(address(fanout)), fanoutBefore + 100_000);
    }

    function test_dustEnterDoesNotNeedL4Prepay() public {
        vm.prank(alice);
        uint256 minted = vault.enter(1, alice);
        assertGt(minted, 0);
        assertEq(reserve.balanceOf(address(fanout)), 0); // rake rounds to 0
    }

    function test_distributeSplitsTwoToOneAndBuybackBurns() public {
        vm.prank(alice);
        vault.enter(1000e6, alice);

        uint256 pending = reserve.balanceOf(address(fanout));
        assertGt(pending, 0);
        uint256 navBefore;
        (navBefore,,) = vault.getReserveNAV();

        fanout.distribute();
        assertEq(reserve.balanceOf(address(fanout)), 0);
        uint256 toBuyback = reserve.balanceOf(address(buyback));
        uint256 toTreasury = reserve.balanceOf(treasury);
        assertEq(toBuyback, (pending * 2) / 3);
        assertEq(toTreasury, pending - toBuyback);

        vm.prank(keeper);
        uint256 burned = buyback.execute(1);
        assertGt(burned, 0);
        assertEq(vault.balanceOf(address(buyback)), 0);
        assertEq(vault.balanceOf(DEAD) >= burned, true);
        (uint256 navAfter,,) = vault.getReserveNAV();
        assertGe(navAfter, navBefore);
    }

    function test_strangerCannotExecuteBuybackOrSetBridge() public {
        vm.prank(alice);
        vm.expectRevert(ReserveBuyback.Unauthorized.selector);
        buyback.execute(0);

        vm.prank(alice);
        vm.expectRevert();
        vault.setBridgeSystem(alice, bob);
    }

    function test_timelockIsTheOnlyBridgeAdmin() public {
        address inbox = makeAddr("inbox");
        address bridge = makeAddr("bridge");
        bytes memory data = abi.encodeCall(vault.setBridgeSystem, (inbox, bridge));
        vm.prank(owner);
        XMoneyTimelockLike(timelock).schedule(address(vault), 0, data, bytes32(0), bytes32(uint256(1)), 1 days);
        vm.warp(block.timestamp + 1 days);
        XMoneyTimelockLike(timelock).execute(address(vault), 0, data, bytes32(0), bytes32(uint256(1)));
        assertTrue(vault.isBridgeSystem(bridge));

        vm.prank(alice);
        vault.enter(1000e6, alice);
        uint256 bal = vault.balanceOf(alice);
        uint256 bridgeBefore = vault.balanceOf(bridge); // entry buffer, minted before this transfer
        vm.prank(alice);
        vault.transfer(bridge, bal);
        assertEq(vault.balanceOf(bridge) - bridgeBefore, bal);
    }

    function test_feeOnTransferReserveStaysSolvent() public {
        MockReserve fee = new MockReserve(6);
        fee.setFee(true);
        EvmReserveDeploy.Result memory r =
            EvmReserveDeploy.deploy(IERC20(address(fee)), address(this), owner, keeper, treasury);
        fee.mint(alice, 1_000_000e6);
        vm.prank(alice);
        fee.approve(address(r.vault), type(uint256).max);

        vm.prank(alice);
        uint256 minted = r.vault.enter(1000e6, alice);
        assertGt(minted, 0);
        // 1% skim on the way in, then the rake. Vault holds only what it kept.
        assertEq(fee.balanceOf(address(r.vault)) > 0, true);
        uint256 held = fee.balanceOf(address(r.vault));
        uint256 got = r.vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = r.vault.exit(got);
        assertGt(out, 0);
        assertLe(fee.balanceOf(address(r.vault)), held);
    }
}

interface XMoneyTimelockLike {
    function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay)
        external;
    function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) external;
}
