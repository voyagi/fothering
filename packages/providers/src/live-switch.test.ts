import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { readLiveSwitch } from './live-switch.js';

describe('readLiveSwitch', () => {
  const saved = process.env[LIVE_SWITCH];
  afterEach(() => {
    if (saved === undefined) delete process.env[LIVE_SWITCH];
    else process.env[LIVE_SWITCH] = saved;
  });

  it('returns undefined when the switch is unset', () => {
    delete process.env[LIVE_SWITCH];
    expect(readLiveSwitch()).toBeUndefined();
  });

  it('returns the exact process value, whitespace untouched', () => {
    process.env[LIVE_SWITCH] = ' live ';
    expect(readLiveSwitch()).toBe(' live ');
  });
});
