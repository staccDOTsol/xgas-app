// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ValidatorFeeSplitter
/// @notice Collects the xgas chain's (466302) L2 fees and splits them equally between the current validator set.
///         Deployed ON the chain itself; the native token there is xMoney, so "value"/"balance" below is xMoney.
///         The chain owner points ArbOwner.setNetworkFeeAccount / setInfraFeeAccount (precompile 0x70) at this.
///
/// How money arrives (nitro v3.11.4, arbos/tx_processor.go):
///   - L2 fees are credited by ArbOS with `util.MintBalance` / `util.TransferBalance`: direct state balance
///     changes, NOT calls. receive() does not run and no event is emitted for them.
///   - Anyone can also send value normally, which does run receive().
///   => Income is measured as the balance delta since the last checkpoint (`trackedBalance`), never by counting
///      receive() calls. `sync()` (also run at the start of every state-changing function) books that delta.
///
/// How money can leave WITHOUT a call (also tx_processor.go): for retryable tickets ArbOS prepays
/// gasLimit * baseFee into the fee accounts in the SubmitRetryable tx and, at the end of the redeem (RetryTx),
/// transfers the unused part back OUT of the fee accounts (plus the submission-fee refund). So this contract's
/// balance can go down on its own. Two defences:
///   1. Every function that books income reverts while a retryable redeem is executing
///      (ArbRetryableTx.getCurrentRedeemer() != 0). Otherwise code run inside the redeem could book the prepaid,
///      still-refundable gas as income, release it, and have ArbOS pay the refund out of other payees' money.
///      (Auto-redeem runs immediately after its SubmitRetryable tx in the same block, so no ordinary tx can
///      sync in between.) Residual: an auto-redeem whose fee-refund address is 0x0 returns 0 here; then the
///      refund goes to 0x0, so the attacker burns at least (n-1)x what the other payees lose. Irrational.
///   2. If the balance still drops below what is owed, the shortfall is recorded as `deficit` and is covered
///      first from the next income before anything new is credited. Releases pay min(owed, balance) and keep
///      the rest owed, so nothing is ever lost from the books, only delayed.
///   Invariant (tested): sum(owed to payees) + carry + unassigned == trackedBalance + deficit.
///
/// Distribution: a cumulative per-share index (`perPayeeIndex`, whole wei per share, exact integer math).
/// A payee's balance = credited[p] + (perPayeeIndex - snapshot[p]) while active. Adding or removing a payee
/// first books all income received so far with the OLD set, so a membership change never re-allocates fees
/// already received. Removed payees keep what they earned and can release it any time. Division remainder
/// (< payee count wei) is carried into the next distribution, and flushed to `unassigned` on membership change.
///
/// Empty payee set: income goes to `unassigned`, which the owner can only send, via sweepUnassigned(), to
/// `treasury`, an immutable address fixed at construction. Chosen over "hand it to the next payee set" because
///   - that would give everything to whichever payee is added first (order-dependent, arbitrary), and
///   - the owner can already choose the payee set, so it gives no extra protection, only extra state;
///   - a fixed destination is one line to audit: the owner can move it, but never to itself.
/// The owner has no way to take fees that have accrued to payees: there is no withdraw, and removing a payee
/// does not forfeit what it earned.
contract ValidatorFeeSplitter {
    // ------------------------------------------------------------------ constants / immutables
    uint256 public constant MAX_PAYEES = 32;
    /// @dev ArbRetryableTx precompile. On a non-Arbitrum EVM (unit tests) it has no code and the check passes.
    address public constant ARB_RETRYABLE_TX = 0x000000000000000000000000000000000000006E;

    /// @notice Only destination for unassigned income (collected while the payee set was empty).
    address public immutable treasury;

    // ------------------------------------------------------------------ ownership
    address public owner;
    address public pendingOwner;

    // ------------------------------------------------------------------ payee set
    address[] private _payees;
    mapping(address => uint256) private _slot; // index in _payees + 1; 0 = not an active payee

    // ------------------------------------------------------------------ accounting (all in wei of xMoney)
    uint256 public perPayeeIndex; // cumulative income per active share
    uint256 public carry;         // remainder of the last split, < payee count
    uint256 public unassigned;    // income booked while the set was empty (+ flushed carry); treasury-only
    uint256 public deficit;       // balance removed without a call (ArbOS refunds), to be covered by new income
    uint256 public trackedBalance; // address(this).balance at the last checkpoint

    mapping(address => uint256) private _credited; // realized, not yet released
    mapping(address => uint256) private _snapshot; // perPayeeIndex when last checkpointed
    mapping(address => uint256) public released;   // lifetime released per payee

    uint256 public totalIncome;   // gross balance increases booked
    uint256 public totalDeficitIncurred;
    uint256 public totalReleased;
    uint256 public totalSwept;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events
    event Received(address indexed from, uint256 amount);
    event FeesSynced(uint256 income, uint256 deficitCovered, uint256 perPayee, uint256 toUnassigned, uint256 carry);
    event DeficitIncurred(uint256 amount, uint256 totalDeficit);
    event PayeeAdded(address indexed payee, uint256 payeeCount);
    event PayeeRemoved(address indexed payee, uint256 keptBalance, uint256 payeeCount);
    event CarryFlushed(uint256 amount);
    event Released(address indexed payee, address indexed to, uint256 amount);
    event UnassignedSwept(address indexed treasury, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error InvalidPayee();
    error AlreadyPayee();
    error NotPayee();
    error TooManyPayees();
    error NothingToRelease();
    error TransferFailed();
    error Reentrancy();
    error InRetryableRedeem();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address treasury_, address[] memory initialPayees) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        owner = owner_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
        // Any value already at this address (e.g. pre-funded) is booked by the first sync as income.
        for (uint256 i; i < initialPayees.length; ++i) _add(initialPayees[i]);
    }

    /// @notice Plain transfers are accepted. ArbOS fee credits do NOT come through here (see contract notes).
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ================================================================== permissionless

    /// @notice Book all income received since the last checkpoint. Anyone may call.
    function sync() external nonReentrant {
        _sync();
    }

    /// @notice Send `payee` everything it has accrued (to the payee itself). Anyone may call.
    function release(address payee) external nonReentrant returns (uint256) {
        return _release(payee, payee);
    }

    /// @notice Payee (msg.sender) sends its accrued balance to `to`, for payees that cannot receive value.
    function releaseTo(address to) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _release(msg.sender, to);
    }

    // ================================================================== owner

    function addPayee(address payee) external nonReentrant onlyOwner {
        _sync();
        _add(payee);
    }

    function addPayees(address[] calldata payees_) external nonReentrant onlyOwner {
        _sync();
        for (uint256 i; i < payees_.length; ++i) _add(payees_[i]);
    }

    /// @notice Stop future income to `payee`. What it earned so far stays claimable by it.
    function removePayee(address payee) external nonReentrant onlyOwner {
        _sync();
        uint256 slot = _slot[payee];
        if (slot == 0) revert NotPayee();
        _checkpoint(payee);
        uint256 last = _payees.length - 1;
        if (slot - 1 != last) {
            address moved = _payees[last];
            _payees[slot - 1] = moved;
            _slot[moved] = slot;
        }
        _payees.pop();
        delete _slot[payee];
        delete _snapshot[payee];
        _flushCarry();
        emit PayeeRemoved(payee, _credited[payee], _payees.length);
    }

    /// @notice Send income booked while the payee set was empty to the immutable treasury.
    function sweepUnassigned() external nonReentrant onlyOwner returns (uint256 amount) {
        _sync();
        amount = unassigned;
        uint256 bal = address(this).balance;
        if (amount > bal) amount = bal; // only possible while in deficit; the rest stays booked
        if (amount == 0) revert NothingToRelease();
        unassigned -= amount;
        trackedBalance -= amount;
        totalSwept += amount;
        emit UnassignedSwept(treasury, amount);
        _send(treasury, amount);
    }

    /// @notice Two-step transfer. Passing address(0) cancels a pending transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================== views

    function payees() external view returns (address[] memory) {
        return _payees;
    }

    function payeeCount() external view returns (uint256) {
        return _payees.length;
    }

    function isPayee(address a) external view returns (bool) {
        return _slot[a] != 0;
    }

    /// @notice What `payee` is owed, including income not yet synced. The amount release() would pay is
    ///         min(this, address(this).balance).
    function releasable(address payee) external view returns (uint256) {
        uint256 index = perPayeeIndex;
        uint256 n = _payees.length;
        uint256 bal = address(this).balance;
        if (n != 0 && bal > trackedBalance) {
            uint256 income = bal - trackedBalance;
            uint256 cover = income < deficit ? income : deficit;
            index += (income - cover + carry) / n;
        }
        uint256 owed = _credited[payee];
        if (_slot[payee] != 0) owed += index - _snapshot[payee];
        return owed;
    }

    // ================================================================== internals

    function _sync() internal {
        _assertNotInRetryable();
        uint256 bal = address(this).balance;
        uint256 tracked = trackedBalance;
        if (bal > tracked) {
            uint256 income = bal - tracked;
            totalIncome += income;
            uint256 d = deficit;
            uint256 cover = income < d ? income : d;
            if (cover != 0) deficit = d - cover;
            uint256 toSplit = income - cover;
            uint256 n = _payees.length;
            uint256 per;
            uint256 toUnassigned;
            if (n == 0) {
                toUnassigned = toSplit + carry;
                unassigned += toUnassigned;
                carry = 0;
            } else {
                uint256 total = toSplit + carry;
                per = total / n;
                carry = total - per * n;
                perPayeeIndex += per;
            }
            emit FeesSynced(income, cover, per, toUnassigned, carry);
        } else if (bal < tracked) {
            uint256 lost = tracked - bal;
            deficit += lost;
            totalDeficitIncurred += lost;
            emit DeficitIncurred(lost, deficit);
        }
        trackedBalance = bal;
    }

    function _release(address payee, address to) internal returns (uint256 amount) {
        _sync();
        _checkpoint(payee);
        amount = _credited[payee];
        uint256 bal = address(this).balance;
        if (amount > bal) amount = bal; // only possible while in deficit; the rest stays owed
        if (amount == 0) revert NothingToRelease();
        _credited[payee] -= amount;
        trackedBalance -= amount;
        released[payee] += amount;
        totalReleased += amount;
        emit Released(payee, to, amount);
        _send(to, amount);
    }

    function _checkpoint(address payee) internal {
        if (_slot[payee] != 0) {
            uint256 index = perPayeeIndex;
            _credited[payee] += index - _snapshot[payee];
            _snapshot[payee] = index;
        }
    }

    function _add(address payee) internal {
        if (payee == address(0) || payee == address(this)) revert InvalidPayee();
        if (_slot[payee] != 0) revert AlreadyPayee();
        if (_payees.length >= MAX_PAYEES) revert TooManyPayees();
        _flushCarry();
        _payees.push(payee);
        _slot[payee] = _payees.length;
        _snapshot[payee] = perPayeeIndex;
        emit PayeeAdded(payee, _payees.length);
    }

    /// @dev The remainder belongs to the old set, which cannot be split exactly; give it to the treasury bucket
    ///      instead of letting the new set inherit it.
    function _flushCarry() internal {
        uint256 c = carry;
        if (c != 0) {
            carry = 0;
            unassigned += c;
            emit CarryFlushed(c);
        }
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _assertNotInRetryable() internal view {
        (bool ok, bytes memory ret) =
            ARB_RETRYABLE_TX.staticcall(abi.encodeWithSignature("getCurrentRedeemer()"));
        if (ok && ret.length == 32 && abi.decode(ret, (address)) != address(0)) revert InRetryableRedeem();
    }
}
