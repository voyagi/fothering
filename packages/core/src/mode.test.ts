import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { propertySeed } from './test/property-seed.js';
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

  it('any other value stays on fixtures', () =>
    fc.assert(
      fc.property(
        fc.string().filter((value) => value !== 'live'),
        (value) => {
          expect(resolveProviderMode(value)).toBe('fixture');
        },
      ),
      { seed: propertySeed() },
    ));
});
