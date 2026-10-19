// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DeployEvmReserve} from "./DeployEvmReserve.s.sol";
import {Tempo} from "../src/evm/EvmChains.sol";

/// @notice Tempo mainnet (4217). Reserve: OUSD. Gas is paid in pathUSD (fallback) or OUSD.
contract DeployTempo is DeployEvmReserve {
    function chainId() internal pure override returns (uint256) {
        return Tempo.CHAIN_ID;
    }

    function reserve() internal pure override returns (address) {
        return Tempo.OUSD;
    }

    function chainName() internal pure override returns (string memory) {
        return "tempo";
    }
}
