// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EvmReserveDeploy} from "../../src/evm/EvmReserveDeploy.sol";
import {XMoneyErc20Vault} from "../../src/evm/XMoneyErc20Vault.sol";
import {ReserveFeeFanout} from "../../src/evm/ReserveFeeFanout.sol";
import {ReserveBuyback} from "../../src/evm/ReserveBuyback.sol";
import {XMoneyTimelock} from "../../src/XMoneyTimelock.sol";

contract NativeProbe {
    function take() external payable returns (uint256) {
        return msg.value;
    }

    function selfBal() external view returns (uint256) {
        return address(this).balance;
    }
}

abstract contract EvmReserveForkBase is Test {
    using SafeERC20 for IERC20;

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant AMOUNT = 1000e6;

    XMoneyErc20Vault vault;
    ReserveFeeFanout fanout;
    ReserveBuyback buyback;
    address timelock;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function chainId_() internal pure virtual returns (uint256);
    function rpc() internal pure virtual returns (string memory);
    function reserveAddr() internal pure virtual returns (address);
    function whale() internal pure virtual returns (address);

    function setUp() public virtual {
        vm.createSelectFork(rpc());
        assertEq(block.chainid, chainId_());
        _deployAndFund();
    }

    function _deployAndFund() internal {
        uint256 g = gasleft();
        EvmReserveDeploy.Result memory r =
            EvmReserveDeploy.deploy(IERC20(reserveAddr()), address(this), owner, keeper, treasury);
        console.log("stack deploy gas (inside test tx)", g - gasleft());
        vault = r.vault;
        fanout = r.fanout;
        buyback = r.buyback;
        timelock = address(r.timelock);

        assertEq(vault.reserveDecimals(), 6, "reserve decimals");
        assertEq(vault.scaleFactor(), 1e12, "scale vs USDG 1e12");
        assertEq(vault.owner(), timelock);
        assertGt(IERC20(reserveAddr()).balanceOf(whale()), AMOUNT, "whale dry");

        vm.prank(whale());
        IERC20(reserveAddr()).safeTransfer(alice, AMOUNT);
        assertEq(IERC20(reserveAddr()).balanceOf(alice), AMOUNT, "transfer skimmed or blocked");
        vm.prank(alice);
        IERC20(reserveAddr()).forceApprove(address(vault), type(uint256).max);
    }

    function test_enterTransferExit_feesToFanout() public {
        IERC20 token = IERC20(reserveAddr());
        uint256 fanoutBefore = token.balanceOf(address(fanout));
        uint256 minted;
        uint256 enterGas;
        uint256 xferGas;
        uint256 exitGas;

        vm.prank(alice);
        uint256 gEnter = gasleft();
        minted = vault.enter(AMOUNT, alice);
        enterGas = gEnter - gasleft();

        assertEq(minted, _expectedMint(AMOUNT), "mint");
        assertEq(vault.balanceOf(alice), minted);
        assertEq(vault.balanceOf(DEAD), _expectedBurn(AMOUNT));
        assertEq(token.balanceOf(address(vault)), AMOUNT - AMOUNT / 10_000, "reserve retained");
        assertEq(token.balanceOf(address(fanout)) - fanoutBefore, AMOUNT / 10_000, "rake to fanout");

        vm.prank(alice);
        uint256 gXfer = gasleft();
        vault.transfer(bob, minted);
        xferGas = gXfer - gasleft();
        uint256 bobBal = vault.balanceOf(bob);
        assertEq(bobBal, minted - minted / 10_000, "transfer burn");

        (uint256 nav,,) = vault.getReserveNAV();
        assertGt(nav, 1e18, "nav");

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        uint256 gExit = gasleft();
        uint256 out = vault.exit(bobBal);
        exitGas = gExit - gasleft();
        assertEq(token.balanceOf(bob), bobBefore + out, "redeem");
        assertGt(out, 998e6, "redeem amount");
        assertGt(token.balanceOf(address(fanout)), fanoutBefore + AMOUNT / 10_000, "exit rake");

        _log(enterGas, xferGas, exitGas);
    }

    function _expectedMint(uint256 amount) internal pure returns (uint256) {
        uint256 net = amount - amount / 10_000;
        uint256 gross = net * 1e12;
        return gross - gross / 10_000;
    }

    function _expectedBurn(uint256 amount) internal pure returns (uint256) {
        uint256 net = amount - amount / 10_000;
        uint256 gross = net * 1e12;
        return gross / 10_000;
    }

    function test_distributeAndBuyback() public {
        vm.prank(alice);
        vault.enter(AMOUNT, alice);
        uint256 pending = IERC20(reserveAddr()).balanceOf(address(fanout));
        fanout.distribute();
        assertEq(IERC20(reserveAddr()).balanceOf(address(buyback)), (pending * 2) / 3);
        vm.prank(keeper);
        uint256 burned = buyback.execute(1);
        assertGt(burned, 0);
        assertEq(vault.balanceOf(address(buyback)), 0);
        assertGe(vault.balanceOf(DEAD), burned);
    }

    function test_deployGasEachContract() public {
        uint256 total;
        ReserveFeeFanout f;
        {
            uint256 g = gasleft();
            f = new ReserveFeeFanout(IERC20(reserveAddr()), treasury, address(this));
            uint256 used = g - gasleft();
            total += used;
            console.log("fanout deploy gas", used);
        }
        address tl;
        {
            address[] memory proposers = new address[](1);
            proposers[0] = owner;
            address[] memory executors = new address[](1);
            executors[0] = address(0);
            uint256 g = gasleft();
            tl = address(new XMoneyTimelock(1 days, proposers, executors));
            uint256 used = g - gasleft();
            total += used;
            console.log("timelock deploy gas", used);
        }
        XMoneyErc20Vault v;
        {
            uint256 g = gasleft();
            v = new XMoneyErc20Vault(IERC20(reserveAddr()), address(f), tl);
            uint256 used = g - gasleft();
            total += used;
            console.log("vault deploy gas", used);
        }
        {
            uint256 g = gasleft();
            ReserveBuyback b = new ReserveBuyback(IERC20(reserveAddr()), address(v), tl, keeper);
            uint256 used = g - gasleft();
            total += used;
            console.log("buyback deploy gas", used);
            g = gasleft();
            f.setBuyback(address(b));
            used = g - gasleft();
            total += used;
            console.log("link gas", used);
        }
        console.log("deploy total gas", total);
        console.log("block basefee", block.basefee);
        _logDeployCost(total);
        assertGt(total, 0);
        assertGt(tl.code.length, 0);
    }

    function _log(uint256 enterGas, uint256 xferGas, uint256 exitGas) internal view {
        console.log("chain", block.chainid);
        console.log("block", block.number);
        console.log("basefee", block.basefee);
        console.log("enter gas", enterGas);
        console.log("transfer gas", xferGas);
        console.log("exit gas", exitGas);
    }

    function _logDeployCost(uint256 gasUsed) internal view virtual;
}
