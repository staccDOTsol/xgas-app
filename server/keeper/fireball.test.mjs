import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerialExecutor } from './serialized.mjs';
import { createFireballFeeKeeper, FIREBALL_MIN_FLUSH } from './fireball.mjs';

test('serial wallet queue waits for a receipt and continues after an error', async () => {
  const serial = createSerialExecutor();
  const steps = [];
  const first = serial(async () => {
    steps.push('first send');
    await new Promise(resolve => setTimeout(resolve, 10));
    steps.push('first receipt');
    throw new Error('reverted');
  });
  const second = serial(async () => { steps.push('second send'); return 2; });
  await assert.rejects(first, /reverted/);
  assert.equal(await second, 2);
  assert.deepEqual(steps, ['first send', 'first receipt', 'second send']);
});

test('fee pipeline executes each stage in order and forwards delivered value once', async () => {
  const steps = [];
  let sink = FIREBALL_MIN_FLUSH;
  let parent = 0n;
  let spent = false;
  const keeper = createFireballFeeKeeper({
    verifyWiring: async () => steps.push('verify'),
    sinkBalance: async () => sink,
    flush: async () => { steps.push('flush'); sink = 0n; return 'flush-tx'; },
    scanWithdrawals: async () => steps.push('scan'),
    forwarderWithdrawals: async () => [{ id: 1 }],
    isClaimable: async () => !spent,
    executeOutbox: async () => { steps.push('outbox'); spent = true; parent = FIREBALL_MIN_FLUSH; return 'outbox-tx'; },
    forwarderBalance: async () => parent,
    forward: async () => { steps.push('forward'); parent = 0n; return 'forward-tx'; },
  });
  await keeper.run();
  assert.deepEqual(steps, ['verify', 'flush', 'scan', 'outbox', 'forward']);
  assert.equal(keeper.state.lastForwardTx, 'forward-tx');
  await keeper.run();
  assert.deepEqual(steps.slice(5), ['verify', 'scan']);
});

test('failed Outbox proof does not block forwarding already delivered fees', async () => {
  const steps = [];
  const keeper = createFireballFeeKeeper({
    verifyWiring: async () => {}, sinkBalance: async () => 0n,
    flush: async () => assert.fail('below threshold'), scanWithdrawals: async () => {},
    forwarderWithdrawals: async () => [{ id: 1 }], isClaimable: async () => true,
    executeOutbox: async () => { throw new Error('bad proof'); },
    forwarderBalance: async () => 10n, forward: async () => { steps.push('forward'); return 'hash'; },
  });
  await keeper.run();
  assert.deepEqual(steps, ['forward']);
  assert.match(keeper.state.lastError, /bad proof/);
});
