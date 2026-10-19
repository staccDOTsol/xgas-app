// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {stdJson} from "forge-std/StdJson.sol";

/// @notice One sovereign unit, read from `config/units/<id>.json`.
///         Every unit is 1 whole token = 1 USD, backed in full by the reserve
///         list. The gas token of the chain is this unit. Fee rates are the
///         xgas constants; a file that asks for anything else is rejected.
library UnitConfig {
    using stdJson for string;

    struct Reserve {
        address token;
        uint256 decimals;
        string symbol;
    }

    struct Unit {
        string id;
        string name;
        string symbol;
        uint256 decimals;
        Reserve[] reserves;
        uint256 parentChainId;
        string parentRpc;
        uint256 chainId;
        string chainName;
        string gasToken;
        address stakeToken;
        bytes32 wasmModuleRoot;
        uint256 initialArbOSVersion;
        bool dataAvailabilityCommittee;
        uint256 confirmPeriodBlocks;
    }

    error EmptyReserves();

    function parse(string memory raw) internal pure returns (Unit memory u) {
        u.id = raw.readString(".id");
        u.name = raw.readString(".unit.name");
        u.symbol = raw.readString(".unit.symbol");
        u.decimals = raw.readUint(".unit.decimals");
        require(u.decimals == 18, "unit decimals must be 18");
        require(bytes(u.name).length != 0 && bytes(u.symbol).length != 0, "unit name");

        require(_eq(raw.readString(".peg.quote"), "USD"), "peg quote must be USD");
        require(raw.readUint(".peg.wholeUnitEquals") == 1, "peg must be 1 unit = 1 USD");
        require(_eq(raw.readString(".peg.backing"), "full"), "backing must be full");

        require(raw.readUint(".feesBps.transferBurn") == 1, "transfer burn is 1 bp");
        require(raw.readUint(".feesBps.entryBurn") == 1, "entry burn is 1 bp");
        require(raw.readUint(".feesBps.reserveRake") == 1, "reserve rake is 1 bp");

        u.reserves = abi.decode(raw.parseRaw(".reserves"), (Reserve[]));
        if (u.reserves.length == 0) revert EmptyReserves();

        u.parentChainId = raw.readUint(".chain.parentChainId");
        u.parentRpc = raw.readString(".chain.parentRpc");
        u.chainId = raw.readUint(".chain.chainId");
        u.chainName = raw.readString(".chain.chainName");
        u.gasToken = raw.readString(".chain.gasToken");
        require(_eq(u.gasToken, "unit"), "gas token must be the unit");
        u.stakeToken = raw.readAddress(".chain.stakeToken");
        u.wasmModuleRoot = raw.readBytes32(".chain.wasmModuleRoot");
        u.initialArbOSVersion = raw.readUint(".chain.initialArbOSVersion");
        u.dataAvailabilityCommittee = raw.readBool(".chain.dataAvailabilityCommittee");
        u.confirmPeriodBlocks = raw.readUint(".chain.confirmPeriodBlocks");
        require(u.chainId != u.parentChainId, "child chain id");
        require(u.wasmModuleRoot != bytes32(0), "wasm module root");
        require(u.stakeToken != address(0), "stake token");
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
