// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XMoneyMultiReserveVault} from "../../src/evm/XMoneyMultiReserveVault.sol";
import {MultiReserveFanout} from "../../src/evm/MultiReserveFanout.sol";
import {MultiReserveBuyback} from "../../src/evm/MultiReserveBuyback.sol";

contract Eighteen is ERC20 {
    constructor() ERC20("EIGHTEEN", "E18") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SixDec is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract XMoneyMultiReserveTest is Test {
    SixDec usdt0;
    SixDec usdc;
    XMoneyMultiReserveVault vault;
    MultiReserveFanout fanout;
    MultiReserveBuyback buyback;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    function setUp() public {
        usdt0 = new SixDec("USDT0", "USDT0");
        usdc = new SixDec("USDC", "USDC");
        fanout = new MultiReserveFanout(treasury, address(this));
        IERC20[] memory reserves = new IERC20[](2);
        reserves[0] = usdt0;
        reserves[1] = usdc;
        vault = new XMoneyMultiReserveVault("X Money", "xMoney", reserves, address(fanout), owner);
        buyback = new MultiReserveBuyback(vault, owner, keeper);
        fanout.setBuyback(address(buyback));

        usdt0.mint(alice, 1000e6);
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdt0.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_bothReservesEnterExitAndBuyback() public {
        vm.prank(alice);
        uint256 mintedUsdt = vault.enter(usdt0, 1000e6, alice);
        // 1000e6 in, rake 1e5, net 999_900_000, gross = net * 1e12, burn 1 bp.
        uint256 net = 999_900_000;
        uint256 gross = net * 1e12;
        uint256 expected = gross - gross / 10_000;
        assertEq(mintedUsdt, expected);
        assertEq(usdt0.balanceOf(address(fanout)), 100_000);

        vm.prank(alice);
        uint256 mintedUsdc = vault.enter(usdc, 1000e6, alice);
        assertGt(mintedUsdc, 0);
        assertEq(usdc.balanceOf(address(vault)), net);

        uint256 usdt0Before = usdt0.balanceOf(address(vault));
        // Exit a fraction. Burning the whole first mint asks for more USDT0 than
        // that reserve holds, because the second reserve is part of the same supply.
        vm.prank(alice);
        uint256 out = vault.exit(usdt0, mintedUsdt / 2);
        assertGt(out, 0);
        assertEq(usdt0.balanceOf(alice), out);
        assertEq(usdc.balanceOf(address(vault)), net, "USDC reserve untouched");
        assertLt(usdt0.balanceOf(address(vault)), usdt0Before);

        fanout.distribute(usdt0);
        assertEq(usdt0.balanceOf(address(fanout)), 0);
        uint256 buybackBal = usdt0.balanceOf(address(buyback));
        assertGt(buybackBal, 0);

        uint256 deadBefore = vault.balanceOf(vault.DEAD());
        vm.prank(keeper);
        uint256 burned = buyback.execute(usdt0, 1);
        assertGt(burned, 0);
        // enter() mints the 1 bp entry burn straight to DEAD, then transfers
        // the bought amount there. That transfer is tax-exempt (to == DEAD).
        uint256 deadDelta = vault.balanceOf(vault.DEAD()) - deadBefore;
        assertEq(deadDelta - burned, deadDelta / 10_000, "entry burn is the only extra");
        assertEq(vault.balanceOf(address(buyback)), 0);
        assertEq(usdt0.balanceOf(address(buyback)), 0);
    }

    function test_oneDollarRegardlessOfDecimals() public {
        SixDec six = new SixDec("USD", "USD");
        Eighteen eighteen = new Eighteen();
        IERC20[] memory reserves = new IERC20[](2);
        reserves[0] = six;
        reserves[1] = eighteen;
        XMoneyMultiReserveVault v = new XMoneyMultiReserveVault("X Money", "xMoney", reserves, address(fanout), owner);
        six.mint(alice, 1_000_000);
        eighteen.mint(alice, 1 ether);
        vm.startPrank(alice);
        six.approve(address(v), type(uint256).max);
        eighteen.approve(address(v), type(uint256).max);
        uint256 fromSix = v.enter(six, 1_000_000, alice);
        uint256 fromEighteen = v.enter(eighteen, 1 ether, alice);
        vm.stopPrank();
        // Second deposit is priced off the first reserve, so it is not identical,
        // but both are the same order: one whole dollar, not 1e12 dollars.
        assertApproxEqRel(fromSix, 1 ether, 0.01e18);
        assertApproxEqRel(fromEighteen, fromSix, 0.02e18);
        assertEq(v.scaleOf(address(six)), 1e12);
        assertEq(v.scaleOf(address(eighteen)), 1);
    }

    function test_rejectsUnknownReserve() public {
        SixDec other = new SixDec("NO", "NO");
        vm.expectRevert(abi.encodeWithSelector(XMoneyMultiReserveVault.NotReserve.selector, address(other)));
        vault.enter(other, 1, alice);
    }
}
