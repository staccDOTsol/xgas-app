// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Currency} from "./v4-core/types/Currency.sol";
import {LPFeeLibrary} from "./v4-core/libraries/LPFeeLibrary.sol";

/// @title JitToll: the anti-extraction toll baked into the xGas PoolManager.
/// @notice Lives in the singleton, not in a hook, so no pool, hook or router on this
///         PoolManager can opt out of it. Three rules:
///
///         1. LP add and LP remove pay the pool's own swap fee plus a 10 bp floor. A
///            0-fee pool therefore costs 10 bp per LP action and 10 bp per swap on
///            top of nothing. Liquidity that brackets a swap pays the fee three times.
///
///         2. Every reference to the same currency inside one transaction escalates
///            the toll quadratically: the n-th swap / add / remove touching a currency
///            in this tx pays (fee + 10 bp) * n^2, capped at 100%. The counters are
///            transient, so they cost nothing to reset. Native $xMoney is never
///            counted: a plain A -> xMoney -> B route is one reference per token.
///
///         3. A position removed in the block it was added to counts as one extra
///            reference. That catches the bundle-style JIT that splits add and remove
///            across transactions (enforced in PoolManager, which owns the block map).
///
///         The toll accrues to `protocolFeesAccrued`, i.e. to the xGas FanoutSink and
///         XGAS.DEV buyback, never to the extractor.
library JitToll {
    /// @notice 10 bp in v4 fee pips (1e6 = 100%).
    uint24 internal constant FLOOR = 1_000;
    uint256 internal constant ONE = LPFeeLibrary.MAX_LP_FEE; // 1e6

    uint8 internal constant KIND_SWAP = 0;
    uint8 internal constant KIND_ADD = 1;
    uint8 internal constant KIND_REMOVE = 2;

    /// @dev keccak256("xgas.JitToll.refs") - 1, mixed with the currency for the transient slot.
    bytes32 private constant REFS_SEED = 0x2a5f3c0f0f9e2c6d4d3c6a0a7f2b6f1d3c7e8a9b0c1d2e3f4a5b6c7d8e9f0a1b;

    function _slot(Currency c) private pure returns (bytes32 s) {
        s = keccak256(abi.encode(REFS_SEED, Currency.unwrap(c)));
    }

    /// @notice How many times `c` has been referenced in the current transaction.
    function refs(Currency c) internal view returns (uint256 n) {
        bytes32 slot = _slot(c);
        assembly ("memory-safe") {
            n := tload(slot)
        }
    }

    /// @dev Bump the counter for one currency. Native is exempt and returns 0.
    function bump(Currency c) internal returns (uint256 n) {
        if (c.isAddressZero()) return 0;
        bytes32 slot = _slot(c);
        assembly ("memory-safe") {
            n := add(tload(slot), 1)
            tstore(slot, n)
        }
    }

    /// @notice Reference both pool currencies; the toll escalates on the busier one.
    ///         A pool of two exempt currencies cannot exist (currencies are unique), so
    ///         n is at least 1.
    function touch(Currency c0, Currency c1) internal returns (uint256 n) {
        uint256 a = bump(c0);
        uint256 b = bump(c1);
        n = a > b ? a : b;
        if (n == 0) n = 1;
    }

    /// @notice Toll rate in pips for a pool charging `fee` at the n-th reference.
    function rate(uint24 fee, uint256 n) internal pure returns (uint24) {
        uint256 r = (uint256(fee) + FLOOR) * n * n;
        return r >= ONE ? uint24(ONE) : uint24(r);
    }

    /// @notice `r` pips of |amount|, rounded down.
    function on(int128 amount, uint24 r) internal pure returns (uint128) {
        uint256 a = amount < 0 ? uint256(uint128(-amount)) : uint256(uint128(amount));
        return uint128(a * r / ONE);
    }
}
