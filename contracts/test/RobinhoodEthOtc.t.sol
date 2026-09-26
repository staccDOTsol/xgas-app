// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RobinhoodEthOtc} from "../src/RobinhoodEthOtc.sol";
import {Outcome} from "../src/interfaces/IOtcArbitration.sol";

// ============================================================================ mocks

contract OtcMockWETH {
    mapping(address => uint256) public balanceOf;
    bool public failTransfer;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfer) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function setFail(bool f) external {
        failTransfer = f;
    }
}

/// @dev Minimal stand-in for OtcArbitration, coded against the fixed interface.
contract OtcMockArbitration {
    address public escrow;
    address public immutable deployer;
    uint256 public bondsHeld;
    uint256 public disputes;

    mapping(uint256 => uint256) public bondOf;
    mapping(uint256 => address) public buyerOf;
    mapping(uint256 => address) public sellerOf;

    constructor() {
        deployer = msg.sender;
    }

    function bind(address e) external {
        require(msg.sender == deployer && escrow == address(0), "bind");
        escrow = e;
    }

    function openDispute(uint256 tradeId, address buyer, address seller) external payable {
        require(msg.sender == escrow, "only escrow");
        bondOf[tradeId] = msg.value;
        buyerOf[tradeId] = buyer;
        sellerOf[tradeId] = seller;
        bondsHeld += msg.value;
        disputes++;
    }

    function rule(uint256 tradeId, Outcome outcome) external {
        RobinhoodEthOtc(escrow).onDisputeResolved(tradeId, outcome);
    }
}

contract OtcRejector {
    receive() external payable {
        revert("no eth");
    }
}

contract OtcGasBurner {
    uint256 public sink;

    receive() external payable {
        while (true) {
            sink++;
        }
    }
}

contract OtcReenterer {
    RobinhoodEthOtc public esc;
    uint256 public tradeId;
    uint8 public mode; // 1 claim, 2 withdrawEth, 3 release, 4 cancelUnpaid, 5 flushFees
    bool public revertIfBlocked;
    bool public reentered;
    uint256 public hits;

    constructor(RobinhoodEthOtc e) {
        esc = e;
    }

    function arm(uint256 id, uint8 m, bool r) external {
        tradeId = id;
        mode = m;
        revertIfBlocked = r;
    }

    receive() external payable {
        hits++;
        bool ok;
        if (mode == 1) {
            try esc.claim(tradeId) {
                ok = true;
            } catch {}
        } else if (mode == 2) {
            try esc.withdrawEth() {
                ok = true;
            } catch {}
        } else if (mode == 3) {
            try esc.release(tradeId) {
                ok = true;
            } catch {}
        } else if (mode == 4) {
            try esc.cancelUnpaid(tradeId) {
                ok = true;
            } catch {}
        } else if (mode == 5) {
            try esc.flushFees() {
                ok = true;
            } catch {}
        }
        if (ok) reentered = true;
        if (mode != 0 && !ok && revertIfBlocked) revert("blocked");
    }
}

// ============================================================================ base

abstract contract OtcBase is Test {
    RobinhoodEthOtc esc;
    OtcMockArbitration arb;
    OtcMockWETH weth;
    address fanout = makeAddr("fanout");
    address alice = makeAddr("alice"); // usually ETH seller
    address bob = makeAddr("bob"); // usually ETH buyer
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint256 constant PRICE = 300_000; // $3,000.00 per ETH in cents
    uint256 constant PAY = 30 minutes;
    uint256 constant REL = 12 hours;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        weth = new OtcMockWETH();
        arb = new OtcMockArbitration();
        esc = new RobinhoodEthOtc(address(weth), fanout, address(arb));
        arb.bind(address(esc));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(dave, 100 ether);
    }

    function _sell(address maker, uint256 amount, uint256 minEth, uint256 maxEth) internal returns (uint256 id) {
        vm.deal(maker, maker.balance + amount);
        vm.prank(maker);
        id = esc.postSell{value: amount}("maker_x", PRICE, minEth, maxEth);
    }

    function _takeSell(address buyer, uint256 orderId, uint256 amount) internal returns (uint256 id) {
        vm.prank(buyer);
        id = esc.takeSell(orderId, amount, "buyer_x");
    }

    function _buy(address maker, uint256 wanted, uint256 minEth, uint256 maxEth) internal returns (uint256 id) {
        vm.prank(maker);
        id = esc.postBuy("bidder_x", wanted, PRICE, minEth, maxEth);
    }

    function _takeBuy(address seller, uint256 orderId, uint256 amount) internal returns (uint256 id) {
        vm.deal(seller, seller.balance + amount);
        vm.prank(seller);
        id = esc.takeBuy{value: amount}(orderId, "seller_x");
    }

    function _paid(uint256 tradeId) internal {
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tradeId);
        vm.prank(t.buyer);
        esc.markPaid(tradeId, "xmoney ref 123");
    }

    /// Sell trade of `amount` from alice's order to `buyer`, marked paid.
    function _paidSellTrade(address buyer, uint256 amount) internal returns (uint256 orderId, uint256 tradeId) {
        orderId = _sell(alice, amount * 2, amount, amount * 2);
        tradeId = _takeSell(buyer, orderId, amount);
        _paid(tradeId);
    }

    function _dispute(uint256 tradeId) internal {
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tradeId);
        uint256 bond = esc.bondFor(t.ethAmount);
        vm.deal(t.seller, t.seller.balance + bond);
        vm.prank(t.seller);
        esc.dispute{value: bond}(tradeId, "no payment arrived");
    }

    function _status(uint256 tradeId) internal view returns (RobinhoodEthOtc.TradeStatus) {
        return esc.getTrade(tradeId).status;
    }

    function _obligations() internal view returns (uint256 sum) {
        RobinhoodEthOtc.Order[] memory os = esc.getOrders(0, type(uint256).max);
        for (uint256 i; i < os.length; ++i) {
            if (os[i].side == RobinhoodEthOtc.Side.Sell) sum += os[i].remainingEth;
        }
        RobinhoodEthOtc.Trade[] memory ts = esc.getTrades(0, type(uint256).max);
        for (uint256 i; i < ts.length; ++i) {
            RobinhoodEthOtc.TradeStatus s = ts[i].status;
            if (
                s == RobinhoodEthOtc.TradeStatus.Open || s == RobinhoodEthOtc.TradeStatus.Paid
                    || s == RobinhoodEthOtc.TradeStatus.Disputed
            ) sum += ts[i].ethAmount;
        }
        sum += esc.totalEthOwed() + esc.pendingFanout();
    }

    function _assertSolvent() internal view {
        assertEq(address(esc).balance, _obligations(), "balance != obligations");
    }
}

// ============================================================================ unit tests

contract RobinhoodEthOtcTest is OtcBase {
    // ---------------------------------------------------------------- deployment / views

    function test_constructor_rejectsZero() public {
        vm.expectRevert(RobinhoodEthOtc.ZeroAddress.selector);
        new RobinhoodEthOtc(address(0), fanout, address(arb));
        vm.expectRevert(RobinhoodEthOtc.ZeroAddress.selector);
        new RobinhoodEthOtc(address(weth), address(0), address(arb));
        vm.expectRevert(RobinhoodEthOtc.ZeroAddress.selector);
        new RobinhoodEthOtc(address(weth), fanout, address(0));
    }

    function test_constants() public view {
        assertEq(esc.PAY_WINDOW(), 30 minutes);
        assertEq(esc.RELEASE_WINDOW(), 12 hours);
        assertEq(esc.FEE_BPS(), 10);
        assertEq(esc.BOND_BPS(), 500);
        assertEq(esc.MIN_BOND(), 0.002 ether);
        assertEq(esc.arbitration(), address(arb));
        assertEq(esc.weth(), address(weth));
        assertEq(esc.feeFanout(), fanout);
    }

    function test_bondFor() public view {
        assertEq(esc.bondFor(0), 0.002 ether);
        assertEq(esc.bondFor(0.01 ether), 0.002 ether);
        assertEq(esc.bondFor(0.04 ether), 0.002 ether); // 5% = 0.002 exactly
        assertEq(esc.bondFor(0.05 ether), 0.0025 ether);
        assertEq(esc.bondFor(1 ether), 0.05 ether);
        assertEq(esc.bondFor(10 ether), 0.5 ether);
    }

    function test_pagination() public {
        for (uint256 i; i < 5; ++i) {
            _sell(alice, 1 ether, 0.1 ether, 1 ether);
        }
        assertEq(esc.ordersLength(), 5);
        assertEq(esc.getOrders(0, 2).length, 2);
        assertEq(esc.getOrders(3, 10).length, 2);
        assertEq(esc.getOrders(5, 10).length, 0);
        assertEq(esc.getOrders(99, 1).length, 0);
        assertEq(esc.getOrders(1, type(uint256).max).length, 4);
        _takeSell(bob, 0, 0.5 ether);
        _takeSell(carol, 1, 0.5 ether);
        assertEq(esc.tradesLength(), 2);
        assertEq(esc.getTrades(1, 5).length, 1);
        assertEq(esc.getTrades(1, 5)[0].orderId, 1);
        assertEq(esc.getTrades(2, 5).length, 0);
        vm.expectRevert(RobinhoodEthOtc.TradeNotFound.selector);
        esc.getTrade(2);
        vm.expectRevert(RobinhoodEthOtc.OrderNotFound.selector);
        esc.getOrder(5);
    }

    // ---------------------------------------------------------------- posting

    function test_postSell_escrows() public {
        uint256 id = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        RobinhoodEthOtc.Order memory o = esc.getOrder(id);
        assertEq(o.maker, alice);
        assertEq(uint8(o.side), uint8(RobinhoodEthOtc.Side.Sell));
        assertEq(o.makerXHandle, "maker_x");
        assertEq(o.priceCentsPerEth, PRICE);
        assertEq(o.remainingEth, 2 ether);
        assertEq(o.minEth, 0.1 ether);
        assertEq(o.maxEth, 1 ether);
        assertTrue(o.active);
        assertFalse(o.cancelled);
        assertEq(address(esc).balance, 2 ether);
    }

    function test_postSell_validation() public {
        vm.startPrank(alice);
        vm.expectRevert(RobinhoodEthOtc.InvalidAmount.selector);
        esc.postSell{value: 0}("a", PRICE, 1, 1);
        vm.expectRevert(RobinhoodEthOtc.InvalidAmount.selector);
        esc.postSell{value: 1 ether}("a", PRICE, 0, 1 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidAmount.selector);
        esc.postSell{value: 1 ether}("a", PRICE, 0.5 ether, 0.4 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidAmount.selector);
        esc.postSell{value: 0.1 ether}("a", PRICE, 0.2 ether, 1 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidPrice.selector);
        esc.postSell{value: 1 ether}("a", 0, 0.1 ether, 1 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidPrice.selector); // min trade worth under 1 cent
        esc.postSell{value: 1 ether}("a", PRICE, 1e9, 1 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidHandle.selector);
        esc.postSell{value: 1 ether}("", PRICE, 0.1 ether, 1 ether);
        vm.expectRevert(RobinhoodEthOtc.InvalidHandle.selector);
        esc.postSell{value: 1 ether}(
            "01234567890123456789012345678901234567890123456789012345678901234", PRICE, 0.1 ether, 1 ether
        );
        vm.stopPrank();
    }

    function test_postBuy_noEscrow() public {
        uint256 id = _buy(bob, 3 ether, 0.1 ether, 1 ether);
        RobinhoodEthOtc.Order memory o = esc.getOrder(id);
        assertEq(uint8(o.side), uint8(RobinhoodEthOtc.Side.Buy));
        assertEq(o.remainingEth, 3 ether);
        assertEq(address(esc).balance, 0);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.InvalidAmount.selector);
        esc.postBuy("b", 0, PRICE, 0.1 ether, 1 ether);
    }

    // ---------------------------------------------------------------- Sell direction

    function test_sell_fullFlow_releaseAfterPaid() public {
        uint256 oid = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        assertEq(t.seller, alice);
        assertEq(t.buyer, bob);
        assertEq(t.sellerXHandle, "maker_x");
        assertEq(t.buyerXHandle, "buyer_x");
        assertEq(t.expectedCents, 300_000);
        assertEq(t.openedAt, block.timestamp);
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        assertEq(esc.openTradeOf(bob), tid + 1);

        vm.warp(block.timestamp + 10 minutes);
        _paid(tid);
        t = esc.getTrade(tid);
        assertEq(uint8(t.status), uint8(RobinhoodEthOtc.TradeStatus.Paid));
        assertEq(t.paidAt, block.timestamp);
        assertEq(t.paymentNote, "xmoney ref 123");
        assertEq(esc.openTradeOf(bob), 0);

        uint256 bobBefore = bob.balance;
        vm.prank(alice);
        esc.release(tid);
        // fee 0.1% = 0.001 ETH, all of it as WETH to the Fee Fanout
        assertEq(bob.balance - bobBefore, 0.999 ether);
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        assertEq(address(weth).balance, 0.001 ether);
        assertEq(address(arb).balance, 0);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Released));
        _assertSolvent();
    }

    function test_release_whileOpen() public {
        uint256 oid = _sell(alice, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 0.5 ether);
        uint256 before = bob.balance;
        vm.prank(alice);
        esc.release(tid);
        assertEq(bob.balance - before, 0.4995 ether);
        assertEq(esc.openTradeOf(bob), 0); // releasing an Open trade frees the buyer
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.release(tid);
    }

    function test_release_onlySeller() public {
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.release(tid);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.release(tid);
    }

    function test_takeSell_checks() public {
        uint256 oid = _sell(alice, 1 ether, 0.2 ether, 0.6 ether);
        uint256 bid = _buy(carol, 1 ether, 0.1 ether, 1 ether);
        vm.startPrank(bob);
        vm.expectRevert(RobinhoodEthOtc.OutOfRange.selector);
        esc.takeSell(oid, 0.1 ether, "b");
        vm.expectRevert(RobinhoodEthOtc.OutOfRange.selector);
        esc.takeSell(oid, 0.7 ether, "b");
        vm.expectRevert(RobinhoodEthOtc.WrongSide.selector);
        esc.takeSell(bid, 0.5 ether, "b");
        vm.expectRevert(RobinhoodEthOtc.InvalidHandle.selector);
        esc.takeSell(oid, 0.5 ether, "");
        vm.expectRevert(RobinhoodEthOtc.OrderNotFound.selector);
        esc.takeSell(9, 0.5 ether, "b");
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.SelfTrade.selector);
        esc.takeSell(oid, 0.5 ether, "a");

        _takeSell(bob, oid, 0.6 ether); // 0.4 left
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.OutOfRange.selector);
        esc.takeSell(oid, 0.5 ether, "c"); // more than remaining
    }

    function test_drainedOrder_deactivates_andDustRefundable() public {
        uint256 oid = _sell(alice, 1 ether, 0.4 ether, 1 ether);
        _takeSell(bob, oid, 0.7 ether); // 0.3 left < min 0.4
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertFalse(o.active);
        assertFalse(o.cancelled);
        assertEq(o.remainingEth, 0.3 ether);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.OrderNotActive.selector);
        esc.takeSell(oid, 0.3 ether, "c");
        uint256 before = alice.balance;
        vm.prank(alice);
        esc.cancelOrder(oid);
        assertEq(alice.balance - before, 0.3 ether);
        assertTrue(esc.getOrder(oid).cancelled);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.OrderNotActive.selector);
        esc.cancelOrder(oid);
        _assertSolvent();
    }

    function test_cancelOrder_fullyDrainedOrderCanBeCancelled() public {
        uint256 oid = _sell(alice, 1 ether, 0.5 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether); // drained to 0, inactive
        vm.prank(alice);
        esc.cancelOrder(oid); // no refund, but ETH coming back now goes to the maker
        assertTrue(esc.getOrder(oid).cancelled);
        vm.warp(block.timestamp + PAY + 1);
        uint256 before = alice.balance;
        esc.cancelUnpaid(tid);
        assertEq(alice.balance - before, 1 ether);
        assertFalse(esc.getOrder(oid).active);
        assertEq(esc.getOrder(oid).remainingEth, 0);
        _assertSolvent();
    }

    function test_cancelOrder_refundsUnlockedOnly() public {
        uint256 oid = _sell(alice, 2 ether, 0.1 ether, 2 ether);
        uint256 tid = _takeSell(bob, oid, 0.5 ether);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.cancelOrder(oid);
        uint256 before = alice.balance;
        vm.prank(alice);
        esc.cancelOrder(oid);
        assertEq(alice.balance - before, 1.5 ether);
        assertEq(address(esc).balance, 0.5 ether); // trade still escrowed
        _paid(tid);
        vm.prank(alice);
        esc.release(tid);
        assertEq(address(esc).balance, 0);
    }

    // ---------------------------------------------------------------- Buy direction

    function test_buy_fullFlow_releaseAndClaim() public {
        uint256 oid = _buy(bob, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeBuy(alice, oid, 1 ether);
        RobinhoodEthOtc.Trade memory t = esc.getTrade(tid);
        assertEq(t.seller, alice);
        assertEq(t.buyer, bob);
        assertEq(t.sellerXHandle, "seller_x");
        assertEq(t.buyerXHandle, "bidder_x");
        assertEq(t.ethAmount, 1 ether);
        assertEq(t.expectedCents, 300_000);
        assertEq(address(esc).balance, 1 ether);
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);

        _paid(tid);
        uint256 before = bob.balance;
        vm.prank(alice);
        esc.release(tid);
        assertEq(bob.balance - before, 0.999 ether);

        // second fill, optimistic claim path
        uint256 tid2 = _takeBuy(carol, oid, 1 ether);
        assertFalse(esc.getOrder(oid).active); // fully filled
        _paid(tid2);
        vm.warp(block.timestamp + REL + 1);
        before = bob.balance;
        vm.prank(bob);
        esc.claim(tid2);
        assertEq(bob.balance - before, 0.999 ether);
        assertEq(uint8(_status(tid2)), uint8(RobinhoodEthOtc.TradeStatus.Claimed));
        assertEq(weth.balanceOf(fanout), 0.002 ether);
        _assertSolvent();
    }

    function test_takeBuy_checks() public {
        uint256 oid = _buy(bob, 1 ether, 0.2 ether, 0.5 ether);
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        vm.expectRevert(RobinhoodEthOtc.OutOfRange.selector);
        esc.takeBuy{value: 0.1 ether}(oid, "a");
        vm.expectRevert(RobinhoodEthOtc.OutOfRange.selector);
        esc.takeBuy{value: 0.6 ether}(oid, "a");
        vm.expectRevert(RobinhoodEthOtc.InvalidHandle.selector);
        esc.takeBuy{value: 0.3 ether}(oid, "");
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.SelfTrade.selector);
        esc.takeBuy{value: 0.3 ether}(oid, "b");
        uint256 sid = _sell(carol, 1 ether, 0.1 ether, 1 ether);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.WrongSide.selector);
        esc.takeBuy{value: 0.3 ether}(sid, "a");
        vm.prank(bob);
        esc.cancelOrder(oid);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.OrderNotActive.selector);
        esc.takeBuy{value: 0.3 ether}(oid, "a");
    }

    // ---------------------------------------------------------------- one Open trade per buyer

    function test_buyer_atMostOneOpenTrade_sellSide() public {
        uint256 o1 = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        uint256 o2 = _sell(carol, 2 ether, 0.1 ether, 1 ether);
        uint256 t1 = _takeSell(bob, o1, 0.5 ether);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeSell(o2, 0.5 ether, "b"); // a second order
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeSell(o1, 0.5 ether, "b"); // the same order

        _paid(t1); // leaving Open frees the buyer
        uint256 t2 = _takeSell(bob, o2, 0.5 ether);
        assertEq(esc.openTradeOf(bob), t2 + 1);
        vm.warp(block.timestamp + PAY + 1);
        esc.cancelUnpaid(t2); // so does an unpaid cancel
        assertEq(esc.openTradeOf(bob), 0);
        _takeSell(bob, o2, 0.5 ether);
        _assertSolvent();
    }

    function test_buyer_atMostOneOpenTrade_buySide() public {
        // on a Buy order the maker is the buyer: one seller at a time until the maker marks paid
        uint256 oid = _buy(bob, 3 ether, 0.1 ether, 1 ether);
        uint256 t1 = _takeBuy(alice, oid, 1 ether);
        vm.deal(carol, 10 ether);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeBuy{value: 1 ether}(oid, "c");
        // the busy maker can not become the buyer of a Sell trade either
        uint256 sid = _sell(dave, 1 ether, 0.1 ether, 1 ether);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BuyerBusy.selector);
        esc.takeSell(sid, 0.5 ether, "b");
        // but a seller can have many Open trades
        _paid(t1);
        _takeBuy(carol, oid, 1 ether);
        _takeSell(alice, sid, 0.5 ether);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- pay window

    function test_markPaid_boundary() public {
        uint256 oid = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        uint256 t1 = _takeSell(bob, oid, 0.5 ether);
        uint256 t2 = _takeSell(carol, oid, 0.5 ether);
        uint256 opened = block.timestamp;

        vm.warp(opened + PAY); // last second allowed
        vm.prank(bob);
        esc.markPaid(t1, "n");

        vm.warp(opened + PAY + 1);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.PayWindowClosed.selector);
        esc.markPaid(t2, "n");
    }

    function test_markPaid_auth_and_status() public {
        uint256 oid = _sell(alice, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 0.5 ether);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.markPaid(tid, "n");
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.TextTooLong.selector);
        esc.markPaid(tid, string(new bytes(281)));
        _paid(tid);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.markPaid(tid, "again");
    }

    function test_cancelUnpaid_boundary_returnsToActiveSellOrder() public {
        uint256 oid = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        uint256 opened = block.timestamp;

        vm.warp(opened + PAY);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.PayWindowOpen.selector);
        esc.cancelUnpaid(tid);

        vm.warp(opened + PAY + 1);
        uint256 aliceBefore = alice.balance;
        vm.prank(carol); // anyone
        esc.cancelUnpaid(tid);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.CancelledUnpaid));
        assertEq(esc.getOrder(oid).remainingEth, 2 ether);
        assertEq(alice.balance, aliceBefore);
        // buyer can no longer mark paid or claim
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.markPaid(tid, "late");
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.cancelUnpaid(tid);
        _assertSolvent();
    }

    function test_cancelUnpaid_paidTradeCannotBeCancelled() public {
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        vm.warp(block.timestamp + PAY + 1);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.cancelUnpaid(tid);
    }

    function test_cancelUnpaid_cancelledOrder_paysMaker() public {
        uint256 oid = _sell(alice, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        vm.prank(alice);
        esc.cancelOrder(oid);
        vm.warp(block.timestamp + PAY + 1);
        uint256 before = alice.balance;
        esc.cancelUnpaid(tid);
        assertEq(alice.balance - before, 1 ether);
        assertEq(esc.getOrder(oid).remainingEth, 0);
        assertFalse(esc.getOrder(oid).active);
        _assertSolvent();
    }

    function test_cancelUnpaid_fullyDrainedOrder_reactivates() public {
        uint256 oid = _sell(alice, 1 ether, 0.5 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        assertFalse(esc.getOrder(oid).active);
        vm.warp(block.timestamp + PAY + 1);
        uint256 before = alice.balance;
        esc.cancelUnpaid(tid);
        assertEq(alice.balance, before); // nothing pushed: the ETH is back on the order
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 1 ether);
        _takeSell(carol, oid, 1 ether); // takeable again
        _assertSolvent();
    }

    function test_cancelUnpaid_partialBelowMin_reactivatesWithAllEth() public {
        uint256 oid = _sell(alice, 5 ether, 0.5 ether, 5 ether);
        uint256 tid = _takeSell(bob, oid, 4.6 ether); // 0.4 left < min 0.5
        assertFalse(esc.getOrder(oid).active);
        vm.warp(block.timestamp + PAY + 1);
        esc.cancelUnpaid(tid);
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertTrue(o.active);
        assertEq(o.remainingEth, 5 ether);
        _assertSolvent();
    }

    function test_cancelUnpaid_repeatedGriefingNeverKillsOrder() public {
        uint256 oid = _sell(alice, 1 ether, 0.6 ether, 1 ether);
        address[3] memory griefers = [bob, carol, dave];
        for (uint256 i; i < 3; ++i) {
            uint256 tid = _takeSell(griefers[i], oid, 0.6 ether); // 0.4 left, inactive
            assertFalse(esc.getOrder(oid).active);
            vm.warp(block.timestamp + PAY + 1);
            esc.cancelUnpaid(tid);
            RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
            assertTrue(o.active); // a take is always >= minEth, so a return always makes it fillable again
            assertEq(o.remainingEth, 1 ether);
        }
        _assertSolvent();
    }

    function test_cancelUnpaid_buyTrade_refundsTaker_restoresCapacity() public {
        uint256 oid = _buy(bob, 2 ether, 0.1 ether, 2 ether);
        uint256 tid = _takeBuy(alice, oid, 2 ether);
        assertFalse(esc.getOrder(oid).active);
        vm.warp(block.timestamp + PAY + 1);
        uint256 before = alice.balance;
        esc.cancelUnpaid(tid);
        assertEq(alice.balance - before, 2 ether);
        RobinhoodEthOtc.Order memory o = esc.getOrder(oid);
        assertEq(o.remainingEth, 2 ether);
        assertTrue(o.active);
        _assertSolvent();
    }

    function test_cancelUnpaid_cancelledBuyOrder_notRestored() public {
        uint256 oid = _buy(bob, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeBuy(alice, oid, 1 ether);
        vm.prank(bob);
        esc.cancelOrder(oid);
        vm.warp(block.timestamp + PAY + 1);
        uint256 before = alice.balance;
        esc.cancelUnpaid(tid);
        assertEq(alice.balance - before, 1 ether);
        assertEq(esc.getOrder(oid).remainingEth, 0);
        assertFalse(esc.getOrder(oid).active);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- release window / claim

    function test_claim_boundary_and_auth() public {
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        uint256 paidAt = block.timestamp;

        vm.warp(paidAt + REL);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.ReleaseWindowOpen.selector);
        esc.claim(tid);

        vm.warp(paidAt + REL + 1);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.claim(tid);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.claim(tid);

        uint256 before = bob.balance;
        vm.prank(bob);
        esc.claim(tid);
        assertEq(bob.balance - before, 0.999 ether);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.claim(tid);
    }

    function test_claim_requiresPaid() public {
        uint256 oid = _sell(alice, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        vm.warp(block.timestamp + REL + PAY + 1);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.claim(tid);
    }

    function test_releaseStillWorksAfterWindow() public {
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        vm.warp(block.timestamp + REL + 100);
        vm.prank(alice);
        esc.release(tid);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Released));
    }

    // ---------------------------------------------------------------- disputes

    function test_dispute_exactBond_boundary_forwarding() public {
        uint256 oid = _sell(alice, 4 ether, 1 ether, 2 ether);
        uint256 t1 = _takeSell(bob, oid, 2 ether);
        uint256 t2 = _takeSell(carol, oid, 1 ether);
        _paid(t1);
        _paid(t2);
        uint256 paidAt = block.timestamp;
        uint256 bond = esc.bondFor(2 ether); // 0.1 ETH

        vm.startPrank(alice);
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: bond - 1}(t1, "r");
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: bond + 1}(t1, "r"); // no overpay
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: 1 ether}(t1, "r");
        vm.expectRevert(RobinhoodEthOtc.TextTooLong.selector);
        esc.dispute{value: bond}(t1, string(new bytes(1001)));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.dispute{value: bond}(t1, "r");

        vm.warp(paidAt + REL); // last second allowed
        vm.prank(alice);
        esc.dispute{value: bond}(t1, "nothing arrived");
        assertEq(uint8(_status(t1)), uint8(RobinhoodEthOtc.TradeStatus.Disputed));
        assertEq(arb.bondOf(t1), bond);
        assertEq(arb.buyerOf(t1), bob);
        assertEq(arb.sellerOf(t1), alice);
        assertEq(address(arb).balance, bond);

        vm.warp(paidAt + REL + 1);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.ReleaseWindowClosed.selector);
        esc.dispute{value: 0.05 ether}(t2, "late");

        // disputed trade is frozen for release / claim / cancel
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.release(t1);
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.claim(t1);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.cancelUnpaid(t1);
        _assertSolvent();
    }

    function test_dispute_requiresPaid() public {
        uint256 oid = _sell(alice, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        esc.dispute{value: 0.05 ether}(tid, "r");
    }

    function test_dispute_minBondOnSmallTrade() public {
        (, uint256 tid) = _paidSellTrade(bob, 0.01 ether);
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.WrongBond.selector);
        esc.dispute{value: 0.0005 ether}(tid, "r"); // 5% would be 0.0005, floor is 0.002
        vm.prank(alice);
        esc.dispute{value: 0.002 ether}(tid, "r");
    }

    function test_resolve_BuyerPaid() public {
        (uint256 oid, uint256 tid) = _paidSellTrade(bob, 1 ether);
        _dispute(tid);
        uint256 before = bob.balance;
        arb.rule(tid, Outcome.BuyerPaid);
        assertEq(bob.balance - before, 0.999 ether);
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Resolved));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertFalse(esc.flagged(bob));
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        _assertSolvent();
    }

    function test_resolve_BuyerDidNotPay_toActiveOrder_andFlags() public {
        (uint256 oid, uint256 tid) = _paidSellTrade(bob, 1 ether);
        _dispute(tid);
        uint256 aliceBefore = alice.balance;
        arb.rule(tid, Outcome.BuyerDidNotPay);
        assertEq(esc.getOrder(oid).remainingEth, 2 ether); // back on the order
        assertEq(alice.balance, aliceBefore);
        assertEq(weth.balanceOf(fanout), 0); // no fee on ETH returned to the seller
        assertTrue(esc.flagged(bob));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));

        // flagged buyer can no longer take a Sell order or post a Buy order
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.takeSell(oid, 1 ether, "b");
        vm.prank(bob);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.postBuy("b", 1 ether, PRICE, 0.1 ether, 1 ether);
        // but can still sell ETH
        _sell(bob, 1 ether, 0.1 ether, 1 ether);
        _assertSolvent();
    }

    function test_resolve_BuyerDidNotPay_reactivatesDrainedOrder() public {
        uint256 oid = _sell(alice, 1 ether, 1 ether, 1 ether);
        uint256 tid = _takeSell(bob, oid, 1 ether);
        _paid(tid);
        _dispute(tid);
        arb.rule(tid, Outcome.BuyerDidNotPay);
        assertTrue(esc.getOrder(oid).active);
        assertEq(esc.getOrder(oid).remainingEth, 1 ether);
        _assertSolvent();
    }

    function test_flaggedMakersBuyOrderCannotBeTaken() public {
        uint256 bidId = _buy(bob, 2 ether, 0.1 ether, 1 ether); // posted before the flag
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        _dispute(tid);
        arb.rule(tid, Outcome.BuyerDidNotPay);
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        vm.expectRevert(RobinhoodEthOtc.FlaggedAddress.selector);
        esc.takeBuy{value: 0.5 ether}(bidId, "c");
    }

    function test_resolve_BuyerDidNotPay_buyTrade_paysSeller() public {
        uint256 oid = _buy(bob, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeBuy(alice, oid, 1 ether);
        _paid(tid);
        _dispute(tid);
        uint256 before = alice.balance;
        arb.rule(tid, Outcome.BuyerDidNotPay);
        assertEq(alice.balance - before, 1 ether);
        assertTrue(esc.flagged(bob));
        assertEq(esc.getOrder(oid).remainingEth, 0); // a dispute outcome never restores Buy capacity
        _assertSolvent();
    }

    function test_resolve_BuyerDidNotPay_cancelledOrder_paysSeller() public {
        (uint256 oid, uint256 tid) = _paidSellTrade(bob, 1 ether);
        vm.prank(alice);
        esc.cancelOrder(oid);
        _dispute(tid);
        uint256 before = alice.balance;
        arb.rule(tid, Outcome.BuyerDidNotPay);
        assertEq(alice.balance - before, 1 ether);
        _assertSolvent();
    }

    function test_resolve_LongStop_ethBackToOrder_noFlag_noFee() public {
        uint256 amount = 1 ether + 1; // odd wei: nothing is split any more
        (uint256 oid, uint256 tid) = _paidSellTrade(bob, amount);
        _dispute(tid);
        uint256 b0 = bob.balance;
        uint256 a0 = alice.balance;
        arb.rule(tid, Outcome.LongStop);
        assertEq(bob.balance, b0);
        assertEq(alice.balance, a0);
        assertEq(esc.getOrder(oid).remainingEth, amount * 2);
        assertEq(weth.balanceOf(fanout), 0);
        assertFalse(esc.flagged(bob));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        _assertSolvent();
    }

    function test_resolve_LongStop_cancelledOrderAndBuyTrade_paySeller() public {
        (uint256 oid, uint256 t1) = _paidSellTrade(bob, 1 ether);
        vm.prank(alice);
        esc.cancelOrder(oid);
        _dispute(t1);
        uint256 a0 = alice.balance;
        arb.rule(t1, Outcome.LongStop);
        assertEq(alice.balance - a0, 1 ether);

        uint256 bid = _buy(carol, 1 ether, 0.1 ether, 1 ether);
        uint256 t2 = _takeBuy(dave, bid, 1 ether);
        _paid(t2);
        _dispute(t2);
        uint256 d0 = dave.balance;
        arb.rule(t2, Outcome.LongStop);
        assertEq(dave.balance - d0, 1 ether);
        assertFalse(esc.flagged(carol));
        _assertSolvent();
    }

    function test_resolve_guards() public {
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        // not disputed yet
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        arb.rule(tid, Outcome.BuyerPaid);
        _dispute(tid);
        // only arbitration
        vm.prank(alice);
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.onDisputeResolved(tid, Outcome.BuyerDidNotPay);
        vm.expectRevert(RobinhoodEthOtc.BadOutcome.selector);
        arb.rule(tid, Outcome.None);
        // out-of-range enum is rejected by the ABI decoder
        vm.prank(address(arb));
        (bool ok,) = address(esc).call(abi.encodeWithSignature("onDisputeResolved(uint256,uint8)", tid, uint8(4)));
        assertFalse(ok);
        arb.rule(tid, Outcome.BuyerPaid);
        vm.expectRevert(RobinhoodEthOtc.BadStatus.selector);
        arb.rule(tid, Outcome.BuyerDidNotPay);
    }

    // ---------------------------------------------------------------- fee leg

    function test_fee_allToFanout_deferredAndFlushed() public {
        weth.setFail(true);
        (, uint256 tid) = _paidSellTrade(bob, 2 ether);
        uint256 before = bob.balance;
        vm.prank(alice);
        esc.release(tid);
        assertEq(bob.balance - before, 1.998 ether);
        assertEq(esc.pendingFanout(), 0.002 ether);
        assertEq(address(weth).balance, 0); // wrap rolled back with the failed transfer
        _assertSolvent();

        esc.flushFees(); // still failing: stays pending, no revert
        assertEq(esc.pendingFanout(), 0.002 ether);
        weth.setFail(false);
        vm.prank(carol);
        esc.flushFees();
        assertEq(esc.pendingFanout(), 0);
        assertEq(weth.balanceOf(fanout), 0.002 ether);
        _assertSolvent();
    }

    function test_fee_deferredDuringDisputeResolution_resolutionStillLands() public {
        weth.setFail(true);
        (, uint256 tid) = _paidSellTrade(bob, 1 ether);
        _dispute(tid);
        uint256 before = bob.balance;
        arb.rule(tid, Outcome.BuyerPaid);
        assertEq(bob.balance - before, 0.999 ether);
        assertEq(esc.pendingFanout(), 0.001 ether);
        _assertSolvent();
        weth.setFail(false);
        esc.flushFees();
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        _assertSolvent();
    }

    function test_wrapAndSendFee_selfOnly() public {
        vm.expectRevert(RobinhoodEthOtc.Unauthorized.selector);
        esc.wrapAndSendFee(1);
    }

    function test_fee_tinyTradeRoundsToZeroFee() public {
        // 999 wei trade -> fee rounds to 0; buyer gets it all
        uint256 oid;
        vm.prank(alice);
        oid = esc.postSell{value: 999}("m", 1e18, 999, 999); // 1e18 cents per ETH so 999 wei is >= 1 cent
        uint256 tid = _takeSell(bob, oid, 999);
        uint256 before = bob.balance;
        vm.prank(alice);
        esc.release(tid);
        assertEq(bob.balance - before, 999);
        assertEq(weth.balanceOf(fanout), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- hostile receivers

    function test_rejectingBuyer_creditedThenWithdrawTo() public {
        OtcRejector rej = new OtcRejector();
        (, uint256 tid) = _paidSellTrade(address(rej), 1 ether);
        vm.prank(alice);
        esc.release(tid); // must not revert
        assertEq(esc.ethOwed(address(rej)), 0.999 ether);
        assertEq(esc.totalEthOwed(), 0.999 ether);
        _assertSolvent();

        vm.prank(address(rej));
        vm.expectRevert(RobinhoodEthOtc.TransferFailed.selector);
        esc.withdrawEth(); // still rejects: credit kept
        assertEq(esc.ethOwed(address(rej)), 0.999 ether);

        vm.prank(address(rej));
        vm.expectRevert(RobinhoodEthOtc.ZeroAddress.selector);
        esc.withdrawEthTo(payable(address(0)));

        address payable dest = payable(makeAddr("dest"));
        vm.prank(address(rej));
        esc.withdrawEthTo(dest);
        assertEq(dest.balance, 0.999 ether);
        assertEq(esc.ethOwed(address(rej)), 0);
        assertEq(esc.totalEthOwed(), 0);
        vm.prank(address(rej));
        vm.expectRevert(RobinhoodEthOtc.NothingOwed.selector);
        esc.withdrawEth();
        _assertSolvent();
    }

    function test_gasBurningBuyer_claimCredited() public {
        OtcGasBurner burner = new OtcGasBurner();
        (, uint256 tid) = _paidSellTrade(address(burner), 1 ether);
        vm.warp(block.timestamp + REL + 1);
        vm.prank(address(burner));
        esc.claim(tid); // 50k gas push fails, credited
        assertEq(esc.ethOwed(address(burner)), 0.999 ether);
        _assertSolvent();
    }

    function test_rejectingMaker_cancelOrderCredited() public {
        OtcRejector rej = new OtcRejector();
        vm.deal(address(rej), 1 ether);
        vm.prank(address(rej));
        uint256 oid = esc.postSell{value: 1 ether}("r", PRICE, 0.1 ether, 1 ether);
        vm.prank(address(rej));
        esc.cancelOrder(oid);
        assertEq(esc.ethOwed(address(rej)), 1 ether);
        _assertSolvent();
    }

    function test_rejectingSeller_buyTradeCancelCredited() public {
        OtcRejector rej = new OtcRejector();
        uint256 oid = _buy(bob, 1 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeBuy(address(rej), oid, 1 ether);
        vm.warp(block.timestamp + PAY + 1);
        esc.cancelUnpaid(tid);
        assertEq(esc.ethOwed(address(rej)), 1 ether);
        _assertSolvent();
    }

    function test_hostileParties_cannotBlockResolution() public {
        OtcRejector rejBuyer = new OtcRejector();
        OtcGasBurner burnSeller = new OtcGasBurner();
        // Buy order by a rejecting buyer, taken three times by a gas-burning seller
        vm.prank(address(rejBuyer));
        uint256 oid = esc.postBuy("rb", 3 ether, PRICE, 0.1 ether, 1 ether);
        uint256[3] memory t;
        for (uint256 i; i < 3; ++i) {
            t[i] = _takeBuy(address(burnSeller), oid, 1 ether);
            vm.prank(address(rejBuyer));
            esc.markPaid(t[i], "n"); // one Open trade per buyer: mark paid before the next take
        }
        for (uint256 i; i < 3; ++i) {
            _dispute(t[i]);
        }

        arb.rule(t[0], Outcome.BuyerPaid);
        assertEq(esc.ethOwed(address(rejBuyer)), 0.999 ether);
        arb.rule(t[1], Outcome.LongStop);
        assertEq(esc.ethOwed(address(burnSeller)), 1 ether);
        arb.rule(t[2], Outcome.BuyerDidNotPay);
        assertEq(esc.ethOwed(address(burnSeller)), 2 ether);
        assertTrue(esc.flagged(address(rejBuyer)));
        _assertSolvent();
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrancy_buyerTriesClaimDuringRelease() public {
        OtcReenterer r = new OtcReenterer(esc);
        (, uint256 tid) = _paidSellTrade(address(r), 1 ether);
        r.arm(tid, 1, false);
        vm.warp(block.timestamp + REL + 1);
        vm.prank(alice);
        esc.release(tid);
        assertFalse(r.reentered());
        assertEq(r.hits(), 1);
        assertEq(address(r).balance, 0.999 ether);
        assertEq(uint8(_status(tid)), uint8(RobinhoodEthOtc.TradeStatus.Released));
        _assertSolvent();
    }

    function test_reentrancy_buyerTriesReleaseDuringClaim() public {
        OtcReenterer r = new OtcReenterer(esc);
        (, uint256 tid) = _paidSellTrade(address(r), 1 ether);
        r.arm(tid, 3, false);
        vm.warp(block.timestamp + REL + 1);
        vm.prank(address(r));
        esc.claim(tid);
        assertFalse(r.reentered());
        assertEq(address(r).balance, 0.999 ether);
        _assertSolvent();
    }

    function test_reentrancy_withdrawCannotDoubleSpend() public {
        OtcReenterer r = new OtcReenterer(esc);
        (, uint256 tid) = _paidSellTrade(address(r), 1 ether);
        r.arm(tid, 2, true); // reenter withdrawEth; revert when blocked
        vm.prank(alice);
        esc.release(tid); // push: reentry blocked -> receiver reverts -> credited
        assertEq(esc.ethOwed(address(r)), 0.999 ether);
        assertEq(address(r).balance, 0);

        vm.prank(address(r));
        vm.expectRevert(RobinhoodEthOtc.TransferFailed.selector);
        esc.withdrawEth(); // reentrant withdraw blocked, receiver reverts, credit kept
        assertEq(esc.ethOwed(address(r)), 0.999 ether);

        r.arm(tid, 2, false); // attempt reentry but accept the ETH
        vm.prank(address(r));
        esc.withdrawEth();
        assertFalse(r.reentered());
        assertEq(address(r).balance, 0.999 ether);
        assertEq(esc.ethOwed(address(r)), 0);
        _assertSolvent();
    }

    function test_reentrancy_sellerTriesDoubleRefund() public {
        OtcReenterer r = new OtcReenterer(esc);
        uint256 oid = _buy(bob, 2 ether, 0.1 ether, 1 ether);
        uint256 tid = _takeBuy(address(r), oid, 1 ether);
        r.arm(tid, 4, false);
        vm.warp(block.timestamp + PAY + 1);
        esc.cancelUnpaid(tid);
        assertFalse(r.reentered());
        assertEq(address(r).balance, 1 ether);
        _assertSolvent();
    }

    function test_reentrancy_flushDuringPayout() public {
        weth.setFail(true);
        (, uint256 t0) = _paidSellTrade(carol, 1 ether);
        vm.prank(alice);
        esc.release(t0); // leaves a pending fee
        weth.setFail(false);
        OtcReenterer r = new OtcReenterer(esc);
        (, uint256 tid) = _paidSellTrade(address(r), 1 ether);
        r.arm(tid, 5, false);
        vm.prank(alice);
        esc.release(tid);
        assertFalse(r.reentered());
        assertEq(esc.pendingFanout(), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_payoutConservation(uint96 rawAmount, uint8 outcomeSeed, bool viaClaim) public {
        uint256 amount = bound(uint256(rawAmount), 0.001 ether, 50 ether);
        (, uint256 tid) = _paidSellTrade(bob, amount);
        uint256 b0 = bob.balance;
        uint256 a0 = alice.balance;
        uint256 escBefore = address(esc).balance;
        uint256 orderEthBefore = esc.getOrder(0).remainingEth;
        uint8 o = outcomeSeed % 4;
        if (o == 0) {
            if (viaClaim) {
                vm.warp(block.timestamp + REL + 1);
                vm.prank(bob);
                esc.claim(tid);
            } else {
                vm.prank(alice);
                esc.release(tid);
            }
        } else {
            _dispute(tid);
            arb.rule(tid, Outcome(o));
        }
        uint256 fees = weth.balanceOf(fanout);
        uint256 toOrder = esc.getOrder(0).remainingEth - orderEthBefore;
        assertEq(
            (bob.balance - b0) + (alice.balance - a0) + fees + toOrder, amount, "every wei of the trade accounted for"
        );
        assertEq(escBefore - address(esc).balance, amount - toOrder);
        assertLe(fees, (amount * 10) / 10_000);
        if (o >= 2) assertEq(bob.balance, b0); // BuyerDidNotPay and LongStop pay the buyer nothing
        assertEq(esc.flagged(bob), o == 2);
        _assertSolvent();
    }

    function testFuzz_expectedCents(uint96 rawAmount, uint32 rawPrice) public {
        uint256 price = bound(uint256(rawPrice), 100, 100_000_000);
        uint256 amount = bound(uint256(rawAmount), 0.01 ether, 1000 ether);
        vm.deal(alice, amount);
        vm.prank(alice);
        uint256 oid = esc.postSell{value: amount}("m", price, amount, amount);
        uint256 tid = _takeSell(bob, oid, amount);
        assertEq(esc.getTrade(tid).expectedCents, (amount * price) / 1e18);
    }
}

// ============================================================================ invariant

contract OtcHandler is Test {
    RobinhoodEthOtc public esc;
    OtcMockArbitration public arb;
    OtcMockWETH public weth;
    address[] public actors;
    address payable public constant SINK = payable(address(0xB0B5));

    uint256 public calls;

    constructor(RobinhoodEthOtc e, OtcMockArbitration a, OtcMockWETH w, address[] memory acts) {
        esc = e;
        arb = a;
        weth = w;
        actors = acts;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function postSell(uint256 a, uint256 amt, uint256 mn) external {
        address m = _actor(a);
        amt = bound(amt, 0.01 ether, 5 ether);
        mn = bound(mn, 0.001 ether, amt);
        vm.deal(m, m.balance + amt);
        vm.prank(m);
        esc.postSell{value: amt}("m", 300_000, mn, amt);
        calls++;
    }

    function postBuy(uint256 a, uint256 amt, uint256 mn) external {
        address m = _actor(a);
        if (esc.flagged(m)) return;
        amt = bound(amt, 0.01 ether, 5 ether);
        mn = bound(mn, 0.001 ether, amt);
        vm.prank(m);
        esc.postBuy("b", amt, 300_000, mn, amt);
        calls++;
    }

    function takeSell(uint256 a, uint256 oSeed, uint256 amt) external {
        uint256 n = esc.ordersLength();
        if (n == 0) return;
        uint256 id = oSeed % n;
        RobinhoodEthOtc.Order memory o = esc.getOrder(id);
        address t = _actor(a);
        if (!o.active || o.side != RobinhoodEthOtc.Side.Sell || t == o.maker || esc.flagged(t)) return;
        if (esc.openTradeOf(t) != 0) return;
        uint256 hi = o.maxEth < o.remainingEth ? o.maxEth : o.remainingEth;
        if (hi < o.minEth) return;
        amt = bound(amt, o.minEth, hi);
        vm.prank(t);
        esc.takeSell(id, amt, "t");
        calls++;
    }

    function takeBuy(uint256 a, uint256 oSeed, uint256 amt) external {
        uint256 n = esc.ordersLength();
        if (n == 0) return;
        uint256 id = oSeed % n;
        RobinhoodEthOtc.Order memory o = esc.getOrder(id);
        address t = _actor(a);
        if (!o.active || o.side != RobinhoodEthOtc.Side.Buy || t == o.maker || esc.flagged(o.maker)) return;
        if (esc.openTradeOf(o.maker) != 0) return;
        uint256 hi = o.maxEth < o.remainingEth ? o.maxEth : o.remainingEth;
        if (hi < o.minEth) return;
        amt = bound(amt, o.minEth, hi);
        vm.deal(t, t.balance + amt);
        vm.prank(t);
        esc.takeBuy{value: amt}(id, "t");
        calls++;
    }

    function _pick(uint256 s) internal view returns (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) {
        uint256 n = esc.tradesLength();
        if (n == 0) return (false, 0, t);
        id = s % n;
        t = esc.getTrade(id);
        ok = true;
    }

    function markPaid(uint256 s) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok || t.status != RobinhoodEthOtc.TradeStatus.Open) return;
        if (block.timestamp > uint256(t.openedAt) + 30 minutes) return;
        vm.prank(t.buyer);
        esc.markPaid(id, "p");
        calls++;
    }

    function cancelUnpaid(uint256 s) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok || t.status != RobinhoodEthOtc.TradeStatus.Open) return;
        if (block.timestamp <= uint256(t.openedAt) + 30 minutes) vm.warp(uint256(t.openedAt) + 30 minutes + 1);
        esc.cancelUnpaid(id);
        calls++;
    }

    function release(uint256 s) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok) return;
        if (t.status != RobinhoodEthOtc.TradeStatus.Open && t.status != RobinhoodEthOtc.TradeStatus.Paid) return;
        vm.prank(t.seller);
        esc.release(id);
        calls++;
    }

    function claim(uint256 s) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok || t.status != RobinhoodEthOtc.TradeStatus.Paid) return;
        if (block.timestamp <= uint256(t.paidAt) + 12 hours) vm.warp(uint256(t.paidAt) + 12 hours + 1);
        vm.prank(t.buyer);
        esc.claim(id);
        calls++;
    }

    function dispute(uint256 s) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok || t.status != RobinhoodEthOtc.TradeStatus.Paid) return;
        if (block.timestamp > uint256(t.paidAt) + 12 hours) return;
        uint256 bond = esc.bondFor(t.ethAmount);
        vm.deal(t.seller, t.seller.balance + bond);
        vm.prank(t.seller);
        esc.dispute{value: bond}(id, "r");
        calls++;
    }

    function resolve(uint256 s, uint8 o) external {
        (bool ok, uint256 id, RobinhoodEthOtc.Trade memory t) = _pick(s);
        if (!ok || t.status != RobinhoodEthOtc.TradeStatus.Disputed) return;
        arb.rule(id, Outcome(1 + (o % 3)));
        calls++;
    }

    function cancelOrder(uint256 oSeed) external {
        uint256 n = esc.ordersLength();
        if (n == 0) return;
        uint256 id = oSeed % n;
        RobinhoodEthOtc.Order memory o = esc.getOrder(id);
        if (o.cancelled) return;
        vm.prank(o.maker);
        esc.cancelOrder(id);
        calls++;
    }

    function withdraw(uint256 a) external {
        address who = _actor(a);
        if (esc.ethOwed(who) == 0) return;
        vm.prank(who);
        esc.withdrawEthTo(SINK);
        calls++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 13 hours));
    }

    function toggleFeeFailure(bool fail) external {
        weth.setFail(fail);
    }

    function flush() external {
        esc.flushFees();
    }
}

contract RobinhoodEthOtcInvariantTest is OtcBase {
    OtcHandler handler;
    address[] acts;

    function setUp() public override {
        super.setUp();
        acts.push(alice);
        acts.push(bob);
        acts.push(carol);
        acts.push(address(new OtcRejector()));
        acts.push(address(new OtcGasBurner()));
        acts.push(address(new OtcReenterer(esc))); // mode 0: plain receiver
        handler = new OtcHandler(esc, arb, weth, acts);

        bytes4[] memory sels = new bytes4[](16);
        sels[0] = OtcHandler.postSell.selector;
        sels[1] = OtcHandler.postBuy.selector;
        sels[2] = OtcHandler.takeSell.selector;
        sels[3] = OtcHandler.takeBuy.selector;
        sels[4] = OtcHandler.markPaid.selector;
        sels[5] = OtcHandler.cancelUnpaid.selector;
        sels[6] = OtcHandler.release.selector;
        sels[7] = OtcHandler.claim.selector;
        sels[8] = OtcHandler.dispute.selector;
        sels[9] = OtcHandler.resolve.selector;
        sels[10] = OtcHandler.cancelOrder.selector;
        sels[11] = OtcHandler.withdraw.selector;
        sels[12] = OtcHandler.warp.selector;
        sels[13] = OtcHandler.toggleFeeFailure.selector;
        sels[14] = OtcHandler.flush.selector;
        sels[15] = OtcHandler.takeSell.selector; // weight taking
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 60
    function invariant_balanceEqualsEverythingOwed() public view {
        _assertSolvent();
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 60
    function invariant_totalOwedMatchesAccounts() public view {
        uint256 sum;
        for (uint256 i; i < acts.length; ++i) {
            sum += esc.ethOwed(acts[i]);
        }
        assertEq(sum, esc.totalEthOwed());
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 60
    function invariant_feesBacked() public view {
        assertEq(address(weth).balance, weth.balanceOf(fanout));
        assertEq(address(arb).balance, arb.bondsHeld());
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 60
    function invariant_activeOrdersAreFillable() public view {
        RobinhoodEthOtc.Order[] memory os = esc.getOrders(0, type(uint256).max);
        for (uint256 i; i < os.length; ++i) {
            if (os[i].cancelled) {
                assertFalse(os[i].active, "cancelled order active");
                assertEq(os[i].remainingEth, 0, "cancelled order holds ETH");
            }
            if (!os[i].active) continue;
            assertGe(os[i].remainingEth, os[i].minEth, "active order must be fillable");
        }
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 60
    function invariant_atMostOneOpenTradePerBuyer() public view {
        RobinhoodEthOtc.Trade[] memory ts = esc.getTrades(0, type(uint256).max);
        for (uint256 i; i < acts.length; ++i) {
            uint256 open;
            uint256 idx;
            for (uint256 j; j < ts.length; ++j) {
                if (ts[j].buyer == acts[i] && ts[j].status == RobinhoodEthOtc.TradeStatus.Open) {
                    open++;
                    idx = j + 1;
                }
            }
            assertLe(open, 1, "two Open trades for one buyer");
            assertEq(esc.openTradeOf(acts[i]), idx, "openTradeOf index");
        }
    }
}

// ============================================================================ fork (Robinhood Chain 4663)

interface IERC20BalanceOf {
    function balanceOf(address) external view returns (uint256);
}

contract RobinhoodEthOtcForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FEE_FANOUT = 0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e;
    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

    /// Real WETH + real Fee Fanout: the fee wrap and transfer succeed. FORK_URL / FORK_BLOCK override the
    /// defaults (the public RPC, latest - 50). Set SKIP_FORK=true to skip offline.
    function test_fork_feeLandsInRealFanoutAsWeth() public {
        if (vm.envOr("SKIP_FORK", false)) return;
        string memory url = vm.envOr("FORK_URL", DEFAULT_RPC);
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) {
            // block.number on an Orbit chain is the L1 number, so ask the RPC for the L2 head
            bytes memory head = vm.rpc(url, "eth_blockNumber", "[]");
            for (uint256 i; i < head.length; ++i) {
                blk = (blk << 8) | uint8(head[i]);
            }
            blk -= 50;
        }
        vm.createSelectFork(url, blk);
        assertEq(block.chainid, 4663);

        OtcMockArbitration arb = new OtcMockArbitration();
        RobinhoodEthOtc esc = new RobinhoodEthOtc(WETH, FEE_FANOUT, address(arb));
        arb.bind(address(esc));

        address seller = makeAddr("forkSeller");
        address buyer = makeAddr("forkBuyer");
        vm.deal(seller, 3 ether);
        vm.prank(seller);
        uint256 oid = esc.postSell{value: 2 ether}("seller", 300_000, 0.1 ether, 2 ether);
        vm.prank(buyer);
        uint256 tid = esc.takeSell(oid, 2 ether, "buyer");
        vm.prank(buyer);
        esc.markPaid(tid, "ref");

        uint256 before = IERC20BalanceOf(WETH).balanceOf(FEE_FANOUT);
        vm.prank(seller);
        esc.release(tid);
        assertEq(buyer.balance, 1.998 ether);
        assertEq(IERC20BalanceOf(WETH).balanceOf(FEE_FANOUT) - before, 0.002 ether); // the whole fee
        assertEq(esc.pendingFanout(), 0);
        assertEq(address(esc).balance, 0);
    }
}

// ============================================================================ integration with the real OtcArbitration

interface IOtcArbitrationFull {
    function bind(address escrow) external;
    function stake() external payable;
    function commitVote(uint256 tradeId, bytes32 commitment) external;
    function revealVote(uint256 tradeId, uint8 vote, bytes32 salt) external;
    function resolve(uint256 tradeId) external;
    function COMMIT() external view returns (uint256);
    function REVEAL() external view returns (uint256);
    function STAKE_AGE() external view returns (uint256);
    function LONG_STOP() external view returns (uint256);
    function arbiterOf(address) external view returns (uint256, uint64, uint256, uint256);
    function disputeOf(uint256)
        external
        view
        returns (address, address, uint256, uint64, uint64, uint64, uint16, bool, uint8, uint256, uint256, uint256);
}

contract RobinhoodEthOtcArbitrationIntegrationTest is Test {
    RobinhoodEthOtc esc;
    IOtcArbitrationFull arb;
    OtcMockWETH weth;
    address fanout = makeAddr("fanout");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address[3] judges;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new OtcMockWETH();
        // by artifact name: no compile-time pin on the sibling contract's source
        arb = IOtcArbitrationFull(vm.deployCode("OtcArbitration.sol:OtcArbitration"));
        esc = new RobinhoodEthOtc(address(weth), fanout, address(arb));
        arb.bind(address(esc));
        for (uint256 i; i < 3; ++i) {
            judges[i] = makeAddr(string.concat("judge", vm.toString(i)));
            vm.deal(judges[i], 1 ether);
            vm.prank(judges[i]);
            arb.stake{value: 0.1 ether}();
        }
        vm.warp(block.timestamp + arb.STAKE_AGE()); // stakes are old enough to vote
        vm.deal(seller, 10 ether);
    }

    function _disputedTrade() internal returns (uint256 tid) {
        vm.prank(seller);
        uint256 oid = esc.postSell{value: 2 ether}("s", 300_000, 0.1 ether, 1 ether);
        vm.prank(buyer);
        tid = esc.takeSell(oid, 1 ether, "b");
        vm.prank(buyer);
        esc.markPaid(tid, "ref");
        uint256 bond = esc.bondFor(1 ether);
        vm.prank(seller);
        esc.dispute{value: bond}(tid, "nothing arrived");
    }

    function _voteAll(uint256 tid, uint8[3] memory votes) internal {
        uint256 opened = block.timestamp;
        for (uint256 i; i < 3; ++i) {
            bytes32 salt = keccak256(abi.encode("salt", i));
            vm.prank(judges[i]);
            arb.commitVote(tid, keccak256(abi.encode(tid, votes[i], salt, judges[i])));
        }
        vm.warp(opened + arb.COMMIT() + 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(judges[i]);
            arb.revealVote(tid, votes[i], keccak256(abi.encode("salt", i)));
        }
        vm.warp(opened + arb.COMMIT() + arb.REVEAL() + 1);
    }

    function test_integration_buyerPaid_paysBuyer_feeToFanout() public {
        uint256 tid = _disputedTrade();
        _voteAll(tid, [uint8(1), uint8(1), uint8(2)]);
        arb.resolve(tid);
        assertEq(buyer.balance, 0.999 ether);
        assertEq(uint8(esc.getTrade(tid).status), uint8(RobinhoodEthOtc.TradeStatus.Resolved));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerPaid));
        assertEq(weth.balanceOf(fanout), 0.001 ether);
        assertEq(address(esc).balance, 1 ether); // the untouched rest of the Sell order
    }

    function test_integration_didNotPay_refillsOrderAndFlags() public {
        uint256 tid = _disputedTrade();
        _voteAll(tid, [uint8(2), uint8(2), uint8(1)]);
        arb.resolve(tid);
        assertEq(buyer.balance, 0);
        assertEq(esc.getOrder(0).remainingEth, 2 ether);
        assertTrue(esc.flagged(buyer));
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.BuyerDidNotPay));
    }

    function test_integration_noQuorum_extendsUntilLongStop_ethBackToSeller() public {
        uint256 tid = _disputedTrade();
        (,,, uint64 openedAt,,,,,,,,) = arb.disputeOf(tid);
        uint256 s0 = seller.balance;
        uint256 rounds;
        while (true) {
            (,,,,, uint64 revealEnd,, bool resolved,,,,) = arb.disputeOf(tid);
            if (resolved) break;
            vm.warp(uint256(revealEnd) + 1);
            arb.resolve(tid);
            rounds++;
        }
        assertGe(block.timestamp, uint256(openedAt) + arb.LONG_STOP());
        assertEq(rounds, 7); // round 1 + 6 extensions of 48h reach 14 days; the 7th resolve is the long-stop
        (,,,,,, uint16 ext,,,,,) = arb.disputeOf(tid);
        assertEq(ext, 6);
        assertEq(uint8(esc.tradeOutcome(tid)), uint8(Outcome.LongStop));
        assertEq(buyer.balance, 0);
        assertFalse(esc.flagged(buyer));
        assertEq(esc.getOrder(0).remainingEth, 2 ether); // back onto the Sell order
        assertEq(seller.balance - s0, esc.bondFor(1 ether)); // the whole bond back
    }
}
