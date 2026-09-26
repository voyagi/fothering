import { afterEach, describe, expect, it } from 'vitest';
import { readLiveSwitch } from './live-switch.js';

const SWITCH_KEY = 'FOTHERING_LIVE';

describe('readLiveSwitch', () => {
  const saved = process.env[SWITCH_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH_KEY];
    else process.env[SWITCH_KEY] = saved;
  });

  it('returns undefined when the switch is unset', () => {
    delete process.env[SWITCH_KEY];
    expect(readLiveSwitch()).toBeUndefined();
  });

  it('returns the exact process value, whitespace untouched', () => {
    process.env[SWITCH_KEY] = ' live ';
    expect(readLiveSwitch()).toBe(' live ');
  });
});
