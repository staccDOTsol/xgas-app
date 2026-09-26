// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {XgasDevPaymaster} from "../../src/aa/XgasDevPaymaster.sol";
import {AATestBase} from "./AATestBase.sol";

contract XgasDevPaymasterPrefundTest is AATestBase {
    function test_PrefundedAddressGoesToDeposit() public {
        address deployer = address(0xBEEF);
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        vm.deal(predicted, 1 ether); // xMoney sent to the address before the contract exists
        vm.prank(deployer);
        XgasDevPaymaster p = new XgasDevPaymaster(ep, deployer, signerAddr);
        assertEq(address(p), predicted);
        assertEq(address(p).balance, 0);
        assertEq(p.getDeposit(), 1 ether);
        vm.deal(address(p), 0.5 ether);
        p.sweepToDeposit();
        assertEq(p.getDeposit(), 1.5 ether);
    }
}
