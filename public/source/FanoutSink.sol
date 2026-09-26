// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title FanoutSink
 * @notice Where every L4 rake lands. The Stacc Wizards Fee Fanout lives on Robinhood Chain (the parent), so
 *         $xMoney raked on this L4 cannot be paid to it directly: the old constant FANOUT address has no code
 *         here and simply swallowed the rake. This contract collects native $xMoney and, on `flush()`, withdraws
 *         it to the parent chain through ArbSys. On a custom-gas-token Orbit chain that releases the fee token
 *         (XMoneyUSD, an ERC-20) to `fanout` once the outbox message is executed after the challenge window;
 *         the fanout then splits it per Homecoming holder through `harvest(xMoney)`.
 */
interface IArbSys {
    function withdrawEth(address destination) external payable returns (uint256);
}

contract FanoutSink {
    IArbSys public constant ARB_SYS = IArbSys(0x0000000000000000000000000000000000000064);
    /// @notice Parent-chain fanout that ends up holding the withdrawn fee token.
    address public immutable fanout;
    /// @notice Withdrawals below this are not worth an outbox execution on the parent chain.
    uint256 public constant MIN_FLUSH = 0.01 ether;
    uint256 public totalFlushed;

    event Received(address indexed from, uint256 amount);
    event Flushed(uint256 amount, uint256 withdrawalId);

    error ZeroAddress();
    error NothingToFlush();

    constructor(address fanout_) {
        if (fanout_ == address(0)) revert ZeroAddress();
        fanout = fanout_;
    }

    receive() external payable { emit Received(msg.sender, msg.value); }

    /// @notice Anyone can push the accumulated rake toward the parent chain.
    function flush() external returns (uint256 amount, uint256 withdrawalId) {
        amount = address(this).balance;
        if (amount < MIN_FLUSH) revert NothingToFlush();
        totalFlushed += amount;
        withdrawalId = ARB_SYS.withdrawEth{value: amount}(fanout);
        emit Flushed(amount, withdrawalId);
    }
}
