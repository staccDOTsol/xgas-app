// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Test.sol";
import {EvmReserveForkBase, NativeProbe} from "./EvmReserveFork.t.sol";
import {Plasma} from "../../src/evm/EvmChains.sol";
import {FanoutSink} from "../../src/FanoutSink.sol";
import {XMoneyTimelock} from "../../src/XMoneyTimelock.sol";

/// @notice Live Plasma mainnet fork. Whale is an EOA that held USDT0 when this was written.
contract PlasmaReserveForkTest is EvmReserveForkBase {
    address constant USDT0_WHALE = 0x8741B106e9738a6971AD07DABCFe95FF66337b51;

    function chainId_() internal pure override returns (uint256) {
        return Plasma.CHAIN_ID;
    }

    function rpc() internal pure override returns (string memory) {
        return Plasma.RPC;
    }

    function reserveAddr() internal pure override returns (address) {
        return Plasma.USDT0;
    }

    function whale() internal pure override returns (address) {
        return USDT0_WHALE;
    }

    function _logDeployCost(uint256 gasUsed) internal view override {
        uint256 price = block.basefee;
        console.log("plasma deploy wei", gasUsed * price);
    }

    function test_nativeValueWorksButIsXplNotTheReserve() public {
        NativeProbe probe = new NativeProbe();
        uint256 reported = probe.take{value: 1 ether}();
        assertEq(reported, 1 ether, "Plasma CALLVALUE");
        assertEq(probe.selfBal(), 1 ether, "Plasma BALANCE");

        // FanoutSink collects native XPL and flushes it through ArbSys (0x64).
        // That precompile has no code on Plasma, so flush reverts and the XPL
        // stays stuck in the sink. This is not the rake path we deploy.
        assertEq(address(0x64).code.length, 0);
        FanoutSink sink = new FanoutSink(address(0xBEEF));
        (bool ok,) = address(sink).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(sink).balance, 1 ether);
        vm.expectRevert();
        sink.flush();
        assertEq(address(sink).balance, 1 ether);

        // Robinhood buyback pools are not deployed here.
        assertEq(address(0x8366a39CC670B4001A1121B8F6A443A643e40951).code.length, 0);
    }

    function test_timelockBytecodeIsTheOzController() public view {
        assertGt(timelock.code.length, 0);
        assertEq(XMoneyTimelock(payable(timelock)).getMinDelay(), 1 days);
    }
}
