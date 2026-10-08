export const FIREBALL_MIN_FLUSH = 10n ** 16n; // FanoutSink.MIN_FLUSH: 0.01 native xMoney.

/**
 * One durable progression is: L4 sink flush -> confirmed Outbox execution ->
 * parent forwarder.forward(). The Outbox transfers an ERC-20 without a callback,
 * so a separate forward transaction books the fee at its actual delivery amount.
 * A crash at any point is recoverable from on-chain balance / Outbox state.
 */
export function createFireballFeeKeeper(deps) {
  const state = {
    running: false, lastRun: 0, lastFlushTx: null, lastOutboxTx: null,
    lastForwardTx: null, lastError: null,
  };

  async function run() {
    if (state.running) return state;
    state.running = true;
    const errors = [];
    try {
      await deps.verifyWiring();
      const balance = await deps.sinkBalance();
      if (balance >= FIREBALL_MIN_FLUSH) state.lastFlushTx = await deps.flush();

      await deps.scanWithdrawals();
      for (const withdrawal of await deps.forwarderWithdrawals()) {
        try {
          if (await deps.isClaimable(withdrawal)) {
            state.lastOutboxTx = await deps.executeOutbox(withdrawal);
          }
        } catch (error) {
          // A failed proof cannot prevent an already delivered withdrawal from
          // being forwarded, nor block a later valid proof.
          errors.push(error?.shortMessage || error?.message || String(error));
        }
      }

      if (await deps.forwarderBalance() > 0n) {
        state.lastForwardTx = await deps.forward();
      }
      state.lastError = errors.length ? errors.join('; ') : null;
    } catch (error) {
      state.lastError = error?.shortMessage || error?.message || String(error);
    } finally {
      state.running = false;
      state.lastRun = Date.now();
    }
    return state;
  }

  return { run, state };
}
