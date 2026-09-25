import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { LIVE_SWITCH, resolveProviderMode } from './mode.js';

describe('resolveProviderMode', () => {
  it('stays on fixtures with an undefined switch', () => {
    expect(resolveProviderMode(undefined)).toBe('fixture');
  });

  it('stays on fixtures with the process environment switch value this suite runs in', () => {
    expect(resolveProviderMode(process.env[LIVE_SWITCH])).toBe('fixture');
  });

  it.each(['1', 'true', 'yes', 'LIVE', 'Live', ' live', 'live ', ''])(
    'stays on fixtures when the switch is %j',
    (value) => {
      expect(resolveProviderMode(value)).toBe('fixture');
    },
  );

  it('goes live only for the exact word live', () => {
    expect(resolveProviderMode('live')).toBe('live');
  });

  test.prop([fc.string().filter((value) => value !== 'live')])(
    'any other value stays on fixtures',
    (value) => {
      expect(resolveProviderMode(value)).toBe('fixture');
    },
  );
});
