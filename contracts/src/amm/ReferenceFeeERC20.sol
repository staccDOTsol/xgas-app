// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title IERC12384: block-scoped reference counting with an escalating in-kind fee.
/// @notice The ERC-20 form of EIP-12384. Where the EIP has the client count calls into
///         an enrolled address per block and charge gas, this token counts its own
///         transfers per block and charges itself, in kind. Same schedule, same
///         destinations, no protocol change needed, deployable on any EVM chain today.
interface IERC12384 {
    /// @notice A counted transfer paid its reference fee.
    /// @param n the reference ordinal in this block (1 = first)
    /// @param fee tokens taken from `value` and split between sink and beneficiary
    event Reference(address indexed from, address indexed to, uint256 n, uint256 fee);

    /// @notice References counted in the current block so far.
    function referencesThisBlock() external view returns (uint256);
    /// @notice Fee rate in basis points for the n-th reference in a block.
    function referenceFeeBps(uint256 n) external pure returns (uint256);
    /// @notice The sealed sink that receives half of every fee. Nobody controls it.
    function sink() external view returns (address);
    /// @notice The issuer's destination for the other half. Fixed at deployment.
    function beneficiary() external view returns (address);
}

/// @title ReferenceFeeERC20: reference implementation of IERC12384.
/// @notice Rules, in the EIP's terms:
///
///           1. Every transfer between two non-zero addresses is a reference to this
///              token. Mint and burn are not.
///           2. References are counted per block, across all senders and all
///              transactions. Nothing about the sender, the origin or the venue
///              changes the count. A machine that spreads its legs over a bundle of
///              transactions in one block is one machine.
///           3. The k-th reference in a block pays `FLOOR_BPS * k²` basis points of the
///              transferred amount, capped at `CAP_BPS`, with the first `K_FREE`
///              references free. A wallet transfer or a single swap is almost always
///              the first reference in its block and pays nothing.
///           4. The fee is not burned and does not reach the party being priced. Half
///              goes to `sink`, an address with no key, and half to `beneficiary`, an
///              address the issuer fixed at deployment (the sink itself if none).
///
///         The counter is one storage slot: the block it belongs to and the count.
///         The first reference in a new block rewrites it; later references in the
///         same block update a warm slot.
///
///         What this cannot see: a venue with flash accounting nets a sequence of
///         operations into one settlement transfer, so it counts as one reference.
///         That is the reason the Ethereum core EIP counts calls at the client
///         instead. This contract is the version that needs no fork.
abstract contract ReferenceFeeERC20 is ERC20, IERC12384 {
    /// @notice 10 bp per k², the same floor the PoolManager toll uses.
    uint256 public constant FLOOR_BPS = 10;
    /// @notice The fee never exceeds 100%.
    uint256 public constant CAP_BPS = 10_000;
    /// @notice References per block that pay nothing.
    uint256 public constant K_FREE = 1;
    uint256 internal constant BPS = 10_000;

    /// @notice Sealed sink: the canonical dead address. Tokens sent here are held,
    ///         not burned, visible to everyone and movable by no one.
    address public constant SINK = 0x000000000000000000000000000000000000dEaD;

    address private immutable _beneficiary;

    uint64 private _refBlock;
    uint64 private _refCount;

    /// @param beneficiary_ destination of the issuer's half; zero means the sink
    constructor(address beneficiary_) {
        _beneficiary = beneficiary_ == address(0) ? SINK : beneficiary_;
    }

    function sink() public pure returns (address) {
        return SINK;
    }

    function beneficiary() public view returns (address) {
        return _beneficiary;
    }

    function referencesThisBlock() public view returns (uint256) {
        return _refBlock == uint64(block.number) ? _refCount : 0;
    }

    function referenceFeeBps(uint256 n) public pure returns (uint256) {
        if (n <= K_FREE) return 0;
        uint256 r = FLOOR_BPS * n * n;
        return r > CAP_BPS ? CAP_BPS : r;
    }

    /// @dev Count the reference and return its ordinal.
    function _reference() internal returns (uint256 n) {
        uint64 current = uint64(block.number);
        if (_refBlock != current) {
            _refBlock = current;
            _refCount = 1;
            return 1;
        }
        n = uint256(_refCount) + 1;
        _refCount = uint64(n);
    }

    /// @dev Whether a transfer counts. Mint and burn never do; subclasses may exempt
    ///      more (a curve that is the token's own market, for instance).
    function _counted(address from, address to) internal view virtual returns (bool) {
        return from != address(0) && to != address(0);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (!_counted(from, to)) {
            super._update(from, to, value);
            return;
        }
        uint256 n = _reference();
        uint256 fee = (value * referenceFeeBps(n)) / BPS;
        if (fee != 0) {
            uint256 half = fee / 2;
            super._update(from, SINK, half);
            super._update(from, _beneficiary, fee - half);
        }
        super._update(from, to, value - fee);
        emit Reference(from, to, n, fee);
    }
}
