// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ReferenceFeeERC20} from "./ReferenceFeeERC20.sol";

/// @title GuardedERC20: a launchpad token on top of IERC12384.
/// @notice Adds one rule to the reference fee: before graduation, the curve is the only
///         venue. A transfer is allowed only if one side is the zero address (mint or
///         burn by the curve) or the curve contract itself. No pool can be seeded on any
///         AMM while the curve is the price oracle, so the machine has nothing to walk.
///
///         Curve transfers are never counted as references: the curve is the token's
///         own market, and its own fees are its own business. After graduation every
///         transfer between two addresses counts, per block, per EIP-12384.
abstract contract GuardedERC20 is ReferenceFeeERC20 {
    /// @notice False until the curve graduates.
    bool public graduated;

    event Graduated();

    error CurveOnly();
    error AlreadyGraduated();

    /// @notice The curve contract. Return address(0) when the curve is the token itself,
    ///         so that only mint and burn are allowed before graduation.
    function _curve() internal view virtual returns (address);

    function _graduate() internal {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
        emit Graduated();
    }

    function _counted(address from, address to) internal view virtual override returns (bool) {
        address curve = _curve();
        if (from == curve || to == curve) return false;
        return super._counted(from, to);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (!graduated) {
            address curve = _curve();
            if (from != address(0) && to != address(0) && from != curve && to != curve) revert CurveOnly();
        }
        super._update(from, to, value);
    }
}
