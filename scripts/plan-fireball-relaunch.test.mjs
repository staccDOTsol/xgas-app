import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relaunchTarget } from './plan-fireball-relaunch.mjs';

test('requires a distinct Fireball parent and separate plan manifest', () => {
  assert.throws(() => relaunchTarget({}), /FIREBALL_FANOUT_PARENT/);
  assert.throws(() => relaunchTarget({ FIREBALL_FANOUT_PARENT: '0x04C9229Fba6AFDC6ac9eD4312acb4BC74f1a436e' }), /new fanout/);
  const config = relaunchTarget({ FIREBALL_FANOUT_PARENT: '0x1111111111111111111111111111111111111111' });
  assert.match(config.output, /fireball-466302-plan\.json$/);
});
