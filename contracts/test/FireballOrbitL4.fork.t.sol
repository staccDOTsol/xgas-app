// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FanoutSink} from "../src/FanoutSink.sol";
import {XMoneyEscrow} from "../src/XMoneyEscrow.sol";
import {FomoAttritionL4} from "../src/FomoAttritionL4.sol";
import {XGasRouter} from "../src/XGasRouter.sol";
import {NguLauncher} from "../src/NguLauncher.sol";

/// @notice Read-only fork rehearsal of the successor wiring. Cross-chain Outbox
///         delivery is covered separately by the Robinhood forwarder fork test.
contract FireballOrbitL4ForkTest is Test {
    address constant OLD_SINK = 0xfeb38ce50e1F49438acAa39b2Da513d2F1DE548f;
    address constant OLD_ESCROW = 0x842E6904e4eB64d5957CC2E9Eb640A9a8C006754;
    address constant OLD_FOMO = 0xa8d88800CF41a2c246Fa363f4FA9EE14C1FEf151;
    address constant OLD_NGU = 0x6067E608d1e0C4a67d406447FaA42a7C7452f7F8;
    address constant BUYBACK_SINK = 0x70A0fBE369e7C390BddA7c55dFD8590F6C13B47B;
    address constant OLD_PARENT = 0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8;
    address constant EXPECTED_PARENT_FORWARDER = 0x1111111111111111111111111111111111111111;

    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_L4_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
    }

    function test_successorsUseNewSinkAndHistoricalPositionsStayOnOldContracts() public {
        if (!forked) { vm.skip(true); return; }
        assertEq(block.chainid, 466302);
        assertGt(BUYBACK_SINK.code.length, 0);
        assertEq(FanoutSink(payable(OLD_SINK)).fanout(), OLD_PARENT);

        uint256 oldOrders = XMoneyEscrow(OLD_ESCROW).nextOrderId();
        uint256 oldTrades = XMoneyEscrow(OLD_ESCROW).nextTradeId();
        uint256 oldFomoRound = FomoAttritionL4(payable(OLD_FOMO)).roundId();
        uint256 oldNguTokens = NguLauncher(OLD_NGU).allTokensLength();

        FanoutSink sink = new FanoutSink(EXPECTED_PARENT_FORWARDER);
        XMoneyEscrow escrow = new XMoneyEscrow(address(sink), BUYBACK_SINK);
        FomoAttritionL4 fomo = new FomoAttritionL4(address(sink), BUYBACK_SINK);
        XGasRouter router = new XGasRouter(payable(address(sink)), payable(BUYBACK_SINK));
        NguLauncher ngu = new NguLauncher(address(sink), BUYBACK_SINK);

        assertEq(sink.fanout(), EXPECTED_PARENT_FORWARDER);
        assertEq(escrow.FANOUT(), address(sink));
        assertEq(fomo.FANOUT(), address(sink));
        assertEq(router.FANOUT(), address(sink));
        assertEq(ngu.fanoutSink(), address(sink));
        assertEq(escrow.BUYBACK(), BUYBACK_SINK);
        assertEq(fomo.BUYBACK(), BUYBACK_SINK);
        assertEq(router.BUYBACK(), BUYBACK_SINK);
        assertEq(ngu.buybackSink(), BUYBACK_SINK);

        assertEq(XMoneyEscrow(OLD_ESCROW).nextOrderId(), oldOrders);
        assertEq(XMoneyEscrow(OLD_ESCROW).nextTradeId(), oldTrades);
        assertEq(FomoAttritionL4(payable(OLD_FOMO)).roundId(), oldFomoRound);
        assertEq(NguLauncher(OLD_NGU).allTokensLength(), oldNguTokens);
        assertEq(FanoutSink(payable(OLD_SINK)).fanout(), OLD_PARENT);
    }

    function test_existingEscrowOrderCanStillBeCancelledOnFork() public {
        if (!forked) { vm.skip(true); return; }
        XMoneyEscrow oldEscrow = XMoneyEscrow(OLD_ESCROW);
        if (oldEscrow.nextOrderId() == 0) { vm.skip(true); return; }
        (address maker,,,,,,, bool active) = oldEscrow.orders(0);
        if (!active) { vm.skip(true); return; }

        vm.prank(maker);
        oldEscrow.cancelOrder(0);
        (,,,,,,, bool stillActive) = oldEscrow.orders(0);
        assertFalse(stillActive);
    }
}
