// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {XMoneyTimelock} from "../XMoneyTimelock.sol";
import {XMoneyErc20Vault} from "./XMoneyErc20Vault.sol";
import {ReserveFeeFanout} from "./ReserveFeeFanout.sol";
import {ReserveBuyback} from "./ReserveBuyback.sol";

/// @notice Deploy order shared by the Foundry scripts and the tests.
///         Timelock delay is 24h, matching the Robinhood xMoney owner.
library EvmReserveDeploy {
    uint256 internal constant TIMELOCK_DELAY = 1 days;

    struct Result {
        XMoneyTimelock timelock;
        ReserveFeeFanout fanout;
        ReserveBuyback buyback;
        XMoneyErc20Vault vault;
    }

    function deploy(IERC20 reserve, address deployer, address owner, address keeper, address treasury)
        internal
        returns (Result memory r)
    {
        r.fanout = new ReserveFeeFanout(reserve, treasury, deployer);
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open execution once the delay has passed
        r.timelock = new XMoneyTimelock(TIMELOCK_DELAY, proposers, executors);
        r.vault = new XMoneyErc20Vault(reserve, address(r.fanout), address(r.timelock));
        r.buyback = new ReserveBuyback(reserve, address(r.vault), address(r.timelock), keeper);
        r.fanout.setBuyback(address(r.buyback));
    }
}
