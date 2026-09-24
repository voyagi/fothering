import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { propertySeed } from './property-seed.js';

const OVERRIDE_VAR = 'FOTHERING_PROPERTY_SEED';
const DEFAULT_SEED = 20260923;

let original: string | undefined;

beforeEach(() => {
  original = process.env[OVERRIDE_VAR];
  delete process.env[OVERRIDE_VAR];
});

afterEach(() => {
  if (original === undefined) delete process.env[OVERRIDE_VAR];
  else process.env[OVERRIDE_VAR] = original;
});

describe('propertySeed', () => {
  it('returns the fixed default seed when the override is unset', () => {
    expect(propertySeed()).toBe(DEFAULT_SEED);
  });

  it('returns the override when it is an unsigned base-10 integer', () => {
    process.env[OVERRIDE_VAR] = '42';
    expect(propertySeed()).toBe(42);
  });

  it.each(['', '4.2', 'abc', ' 42'])(
    'ignores an invalid override %j and returns the default',
    (value) => {
      process.env[OVERRIDE_VAR] = value;
      expect(propertySeed()).toBe(DEFAULT_SEED);
    },
  );
});
