// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {UnitConfig} from "../../script/UnitConfig.sol";

contract UnitConfigTest is Test {
    function test_xmoneyPlasmaFile() public view {
        UnitConfig.Unit memory u = UnitConfig.parse(vm.readFile("../config/units/xmoney-plasma.json"));
        assertEq(u.id, "xmoney-plasma");
        assertEq(u.name, "X Money");
        assertEq(u.symbol, "xMoney");
        assertEq(u.decimals, 18);
        assertEq(u.reserves.length, 2);
        assertEq(u.reserves[0].symbol, "USDT0");
        assertEq(u.reserves[0].decimals, 6);
        assertEq(u.reserves[0].token, 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb);
        assertEq(u.reserves[1].symbol, "USDC");
        assertEq(u.reserves[1].token, 0x2d661C89D812261039AF9764eceaAee884f5F67F);
        assertEq(u.parentChainId, 9745);
        assertEq(u.chainId, 974503);
        assertEq(u.chainName, "xmoney-plasma");
        assertEq(u.gasToken, "unit");
        assertEq(u.initialArbOSVersion, 61);
        assertFalse(u.dataAvailabilityCommittee);
        assertEq(
            u.wasmModuleRoot,
            bytes32(0xc10cd7ec6acaf1c441a3f6bd0900ad20f15855ba775a96f1939118cbc629dc97)
        );
    }

    function test_rejectsANonDollarPeg() public {
        string memory raw = vm.readFile("../config/units/xmoney-plasma.json");
        raw = vm.replace(raw, "\"wholeUnitEquals\": 1", "\"wholeUnitEquals\": 2");
        vm.expectRevert(bytes("peg must be 1 unit = 1 USD"));
        this.parse(raw);
    }

    function parse(string memory raw) external pure returns (UnitConfig.Unit memory) {
        return UnitConfig.parse(raw);
    }
}
