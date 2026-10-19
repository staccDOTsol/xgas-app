// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DeployEvmReserve} from "./DeployEvmReserve.s.sol";
import {Plasma} from "../src/evm/EvmChains.sol";

/// @notice Plasma mainnet (9745). Reserve: USDT0.
contract DeployPlasma is DeployEvmReserve {
    function chainId() internal pure override returns (uint256) {
        return Plasma.CHAIN_ID;
    }

    function reserve() internal pure override returns (address) {
        return Plasma.USDT0;
    }

    function chainName() internal pure override returns (string memory) {
        return "plasma";
    }
}
