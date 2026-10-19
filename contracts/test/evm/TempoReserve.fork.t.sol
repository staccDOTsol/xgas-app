// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Test.sol";
import {EvmReserveForkBase, NativeProbe} from "./EvmReserveFork.t.sol";
import {Tempo} from "../../src/evm/EvmChains.sol";
import {FanoutSink} from "../../src/FanoutSink.sol";
import {XMoneyTimelock} from "../../src/XMoneyTimelock.sol";

/// @notice Live Tempo mainnet fork. Reserve is OUSD. The whale is a contract;
///         prank still works because TIP-20 transfer keys off msg.sender.
contract TempoReserveForkTest is EvmReserveForkBase {
    address constant OUSD_WHALE = 0x1E3423c85FE006D27091b9482cAa9520c250f4C6;

    /// @dev TIP-20 precompiles only execute under `FOUNDRY_PROFILE=tempo`.
    ///      Calling them on the default VM raises OpcodeNotFound, and that
    ///      error is not catchable with a staticcall. Skip unless the runner
    ///      set EXPECT_TEMPO_VM=true alongside that profile.
    function setUp() public override {
        if (!vm.envOr("EXPECT_TEMPO_VM", false)) {
            vm.skip(true);
            return;
        }
        super.setUp();
    }

    function chainId_() internal pure override returns (uint256) {
        return Tempo.CHAIN_ID;
    }

    function rpc() internal pure override returns (string memory) {
        return Tempo.RPC;
    }

    function reserveAddr() internal pure override returns (address) {
        return Tempo.OUSD;
    }

    function whale() internal pure override returns (address) {
        return OUSD_WHALE;
    }

    function _logDeployCost(uint256 gasUsed) internal view override {
        uint256 price = block.basefee;
        uint256 micro = (gasUsed * price + Tempo.FEE_SCALE - 1) / Tempo.FEE_SCALE;
        uint256 microCap = (gasUsed * Tempo.BASE_FEE_CAP_ATTO + Tempo.FEE_SCALE - 1) / Tempo.FEE_SCALE;
        console.log("tempo fee base units at basefee", micro);
        console.log("tempo fee base units at cap", microCap);
    }

    function test_nativeValueIsZeroAndLegacySinkCannotFlush() public {
        NativeProbe probe = new NativeProbe();
        vm.deal(address(this), 1 ether);
        // Tempo reports BALANCE as 0, so attaching value fails the caller's
        // balance check. The probe never sees a non-zero CALLVALUE.
        (bool paid,) = address(probe).call{value: 1 ether}(abi.encodeWithSelector(NativeProbe.take.selector));
        assertFalse(paid, "value transfer");
        assertEq(probe.selfBal(), 0, "BALANCE");

        FanoutSink sink = new FanoutSink(address(0xBEEF));
        (bool flushed,) = address(sink).call{value: 1 ether}("");
        assertFalse(flushed, "sink value transfer");
        assertEq(address(sink).balance, 0);
        vm.expectRevert(FanoutSink.NothingToFlush.selector);
        sink.flush();

        assertEq(Tempo.PATH_USD.code.length, 1, "pathUSD precompile");
        assertEq(address(0x8366a39CC670B4001A1121B8F6A443A643e40951).code.length, 0, "no robinhood pool manager");
    }

    function test_timelockMinDelay() public view {
        assertEq(XMoneyTimelock(payable(timelock)).getMinDelay(), 1 days);
    }
}
