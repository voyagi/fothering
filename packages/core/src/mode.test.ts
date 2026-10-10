import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { propertySeed } from './test/property-seed.js';
import { LIVE_SWITCH, resolveProviderMode } from './mode.js';

// Each lookalike is built from its numeric code points so this file stays pure ASCII: no literal
// invisible or non-Latin character is ever written to disk.
const CYRILLIC_SMALL_I_LIVE = String.fromCodePoint(0x6c, 0x456, 0x76, 0x65);
const FULLWIDTH_LIVE = String.fromCodePoint(0xff4c, 0xff49, 0xff56, 0xff45);
const ZERO_WIDTH_JOINER_LIVE = String.fromCodePoint(0x6c, 0x69, 0x200d, 0x76, 0x65);

describe('resolveProviderMode', () => {
  it('stays on fixtures with an undefined switch', () => {
    expect(resolveProviderMode(undefined)).toBe('fixture');
  });

  it('stays on fixtures with the process environment switch value this suite runs in', () => {
    expect(resolveProviderMode(process.env[LIVE_SWITCH])).toBe('fixture');
  });

  it('pins the switch name to FOTHERING_LIVE', () => {
    expect(LIVE_SWITCH).toBe('FOTHERING_LIVE');
  });

  it.each([
    '1', 'true', 'yes', 'LIVE', 'Live', ' live', 'live ', '', '   ', 'live\n',
    CYRILLIC_SMALL_I_LIVE, FULLWIDTH_LIVE, ZERO_WIDTH_JOINER_LIVE,
  ])(
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
