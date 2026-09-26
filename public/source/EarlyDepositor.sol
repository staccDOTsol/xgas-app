// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Minimal ERC20 surface used here.
interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev The xMoney vault is also the xMoney ERC20 (0xa924…a97E).
interface IXMoneyVault is IERC20Min {
    function enterRollupToL2(uint256 usdgAmount) external returns (uint256 xMoneyMinted);
}

/// @dev nitro-contracts v3.x ERC20Inbox (chain 466302).
interface IERC20InboxMin {
    function bridge() external view returns (address);
    function unsafeCreateRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        uint256 tokenTotalFeeAmount,
        bytes calldata data
    ) external returns (uint256);
}

interface IERC20BridgeMin {
    function nativeToken() external view returns (address);
}

/**
 * @title EarlyDepositor — USDG on Robinhood Chain -> native xMoney on xgas chain 466302, in one transaction,
 *        before (and after) the XMoney vault is re-pointed at the new rollup.
 *
 * @notice Flow, all inside deposit():
 *           1. pull `usdgAmount` USDG from the caller, approve exactly that to the vault
 *           2. vault.enterRollupToL2(usdgAmount): xMoney is minted to THIS contract (balance delta measured)
 *           3. send the whole xMoney balance to the 466302 ERC20Inbox and measure what the inbox actually
 *              received (before the vault switch the transfer pays the 1 bp tax; after it, it is untaxed)
 *           4. open one retryable for exactly what the inbox received:
 *                to = excessFeeRefundAddress = callValueRefundAddress = l3Recipient (never aliased),
 *                l2CallValue = received - gasLimit*maxFeePerGas, maxSubmissionCost = 0 (ERC20 inbox fee is 0)
 *           5. sweep any stray USDG to l3Recipient on Robinhood; the contract ends every call holding nothing.
 *
 *         The recipient ends up with `received - gasUsed*l3BaseFee` on 466302: the unused part of the gas
 *         prepayment is refunded to it by ArbOS as part of the auto-redeem.
 *
 *         unsafeCreateRetryableTicket is used on purpose: the "safe" variant aliases the two refund addresses
 *         when l3Recipient has code on Robinhood (e.g. an EIP-7702 account), which would send the gas refund,
 *         and the whole call value if the auto-redeem ever failed and the ticket expired, to an address the
 *         recipient's key does not control on 466302. The only other thing the safe variant adds is the
 *         deposit >= callValue + gas check, which this contract enforces itself (it holds with equality).
 *
 *         No owner, no admin, no upgradeability, no receive(). Holds no funds between calls.
 */
contract EarlyDepositor {
    // ------------------------------------------------------------------ fixed wiring (Robinhood Chain 4663)
    IERC20Min public constant USDG = IERC20Min(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IXMoneyVault public constant XMONEY = IXMoneyVault(0xa924C725B64cC346f275269EFA4Bd0538cfBa97E);
    IERC20InboxMin public constant INBOX = IERC20InboxMin(0xa7087693676F2Ca8e5e9563A6859952258688146);
    address public constant BRIDGE = 0x2290f4505484f055B710e7Df37e2482c90B8B6fb;

    // ------------------------------------------------------------------ retryable gas bounds
    uint256 public constant MIN_GAS_LIMIT = 30_000; // a plain value retry needs ~21.2k on 466302 (NodeInterface estimate)
    uint256 public constant MAX_GAS_LIMIT = 2_000_000;
    uint256 public constant MIN_MAX_FEE_PER_GAS = 0.1 gwei; // 466302 minimum L2 base fee
    uint256 public constant MAX_MAX_FEE_PER_GAS = 100 gwei;

    uint256 public immutable defaultGasLimit;
    uint256 public immutable defaultMaxFeePerGas;

    // ------------------------------------------------------------------ accounting (informational)
    uint256 public totalUsdgIn;
    uint256 public totalL3Minted;      // sum of tokenTotalFeeAmount = what 466302 mints for these deposits
    uint256 public totalBridgeReceived; // what the 466302 bridge actually received for them

    uint256 private _lock = 1;

    event EarlyDeposit(
        address indexed sender,
        address indexed l3Recipient,
        uint256 indexed ticketId,
        uint256 usdgIn,
        uint256 xMoneyMinted,
        uint256 l3Deposit,
        uint256 l2CallValue,
        uint256 bridgeReceived,
        uint256 gasLimit,
        uint256 maxFeePerGas
    );
    event UsdgDustSwept(address indexed to, uint256 amount);

    error ZeroRecipient();
    error ZeroAmount();
    error Reentrancy();
    error GasParamsOutOfBounds(uint256 gasLimit, uint256 maxFeePerGas);
    error DepositTooSmall(uint256 l3Deposit, uint256 gasPrepay);
    error UnexpectedUsdgIn(uint256 expected, uint256 received);
    error InboxBalanceMismatch(uint256 before, uint256 afterTicket);
    error Leftover(uint256 xMoney);
    error TokenCallFailed(address token);
    error WiringMismatch();
    error RecipientIsContract(address recipient);

    constructor(uint256 gasLimit_, uint256 maxFeePerGas_) {
        _checkGas(gasLimit_, maxFeePerGas_);
        if (INBOX.bridge() != BRIDGE || IERC20BridgeMin(BRIDGE).nativeToken() != address(XMONEY)) {
            revert WiringMismatch();
        }
        defaultGasLimit = gasLimit_;
        defaultMaxFeePerGas = maxFeePerGas_;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice USDG -> xMoney -> native gas token on 466302 for `l3Recipient`. Approve USDG to this contract first.
    function deposit(uint256 usdgAmount, address l3Recipient) external returns (uint256 ticketId) {
        return _deposit(usdgAmount, l3Recipient, defaultGasLimit, defaultMaxFeePerGas);
    }

    /// @notice Same as deposit() with explicit retryable gas params (bounded).
    function depositWithGas(uint256 usdgAmount, address l3Recipient, uint256 gasLimit, uint256 maxFeePerGas)
        external
        returns (uint256 ticketId)
    {
        return _deposit(usdgAmount, l3Recipient, gasLimit, maxFeePerGas);
    }

    /// @notice xMoney the 466302 bridge is short versus what 466302 minted for deposits made through this helper
    ///         (the 1 bp tax on inbox->bridge before the vault switch). Zero for post-switch deposits.
    function bridgeDeficit() external view returns (uint256) {
        return totalL3Minted - totalBridgeReceived;
    }

    // ------------------------------------------------------------------ internals
    struct Receipt {
        uint256 minted;
        uint256 l3Deposit;
        uint256 callValue;
        uint256 bridgeReceived;
        uint256 ticketId;
    }

    function _deposit(uint256 usdgAmount, address l3Recipient, uint256 gasLimit, uint256 maxFeePerGas)
        internal
        nonReentrant
        returns (uint256)
    {
        if (l3Recipient == address(0)) revert ZeroRecipient();
        if (usdgAmount == 0) revert ZeroAmount();
        _checkRecipient(l3Recipient);
        _checkGas(gasLimit, maxFeePerGas);

        Receipt memory r;
        r.minted = _mintXMoney(usdgAmount);
        _bridgeAll(r, l3Recipient, gasLimit, maxFeePerGas);

        // stray USDG (someone sent it here directly) goes to the recipient on Robinhood
        uint256 strayUsdg = USDG.balanceOf(address(this));
        if (strayUsdg != 0) {
            _call(address(USDG), abi.encodeCall(IERC20Min.transfer, (l3Recipient, strayUsdg)));
            emit UsdgDustSwept(l3Recipient, strayUsdg);
        }

        totalUsdgIn += usdgAmount;
        totalL3Minted += r.l3Deposit;
        totalBridgeReceived += r.bridgeReceived;

        emit EarlyDeposit(
            msg.sender,
            l3Recipient,
            r.ticketId,
            usdgAmount,
            r.minted,
            r.l3Deposit,
            r.callValue,
            r.bridgeReceived,
            gasLimit,
            maxFeePerGas
        );
        return r.ticketId;
    }

    /// @dev Steps 1-2: exact USDG in, exact approval to the vault, xMoney minted here (balance delta).
    function _mintXMoney(uint256 usdgAmount) private returns (uint256 minted) {
        uint256 u0 = USDG.balanceOf(address(this));
        _call(address(USDG), abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), usdgAmount)));
        uint256 usdgIn = USDG.balanceOf(address(this)) - u0;
        if (usdgIn != usdgAmount) revert UnexpectedUsdgIn(usdgAmount, usdgIn);
        _call(address(USDG), abi.encodeCall(IERC20Min.approve, (address(XMONEY), usdgAmount)));

        uint256 x0 = XMONEY.balanceOf(address(this));
        XMONEY.enterRollupToL2(usdgAmount);
        minted = XMONEY.balanceOf(address(this)) - x0;

        // the vault pulls exactly usdgAmount; clear anything left defensively
        if (USDG.allowance(address(this), address(XMONEY)) != 0) {
            _call(address(USDG), abi.encodeCall(IERC20Min.approve, (address(XMONEY), 0)));
        }
    }

    /// @dev Steps 3-4: pre-fund the inbox with everything held, measure what it received, open one retryable
    ///      for exactly that. The inbox then has the full amount in hand and pulls nothing from us.
    function _bridgeAll(Receipt memory r, address l3Recipient, uint256 gasLimit, uint256 maxFeePerGas) private {
        uint256 inbox0 = XMONEY.balanceOf(address(INBOX));
        uint256 bridge0 = XMONEY.balanceOf(BRIDGE);
        _call(address(XMONEY), abi.encodeCall(IERC20Min.transfer, (address(INBOX), XMONEY.balanceOf(address(this)))));
        r.l3Deposit = XMONEY.balanceOf(address(INBOX)) - inbox0;

        uint256 gasPrepay = gasLimit * maxFeePerGas;
        if (r.l3Deposit <= gasPrepay) revert DepositTooSmall(r.l3Deposit, gasPrepay);
        r.callValue = r.l3Deposit - gasPrepay;
        r.ticketId = INBOX.unsafeCreateRetryableTicket(
            l3Recipient, r.callValue, 0, l3Recipient, l3Recipient, gasLimit, maxFeePerGas, r.l3Deposit, ""
        );

        // the inbox forwarded exactly l3Deposit to the bridge and is back where it started
        uint256 inbox1 = XMONEY.balanceOf(address(INBOX));
        if (inbox1 != inbox0) revert InboxBalanceMismatch(inbox0, inbox1);
        r.bridgeReceived = XMONEY.balanceOf(BRIDGE) - bridge0;
        uint256 left = XMONEY.balanceOf(address(this));
        if (left != 0) revert Leftover(left);
    }

    /// @dev Only EOAs and EIP-7702 delegated EOAs (code == 0xef0100 || impl): a contract address (Safe etc.) has
    ///      no key on 466302, so its funds would be unrecoverable there.
    function _checkRecipient(address a) private view {
        if (a.code.length == 0) return;
        bytes memory c = a.code;
        if (c.length != 23 || c[0] != 0xef || c[1] != 0x01 || c[2] != 0x00) revert RecipientIsContract(a);
    }

    function _checkGas(uint256 gasLimit, uint256 maxFeePerGas) private pure {
        if (
            gasLimit < MIN_GAS_LIMIT || gasLimit > MAX_GAS_LIMIT || maxFeePerGas < MIN_MAX_FEE_PER_GAS
                || maxFeePerGas > MAX_MAX_FEE_PER_GAS
        ) revert GasParamsOutOfBounds(gasLimit, maxFeePerGas);
    }

    /// @dev SafeERC20-style call: success required, and a returned bool (if any) must be true.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) {
            revert TokenCallFailed(token);
        }
    }
}
