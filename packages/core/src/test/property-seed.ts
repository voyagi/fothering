const DEFAULT_SEED = 20260923;
const OVERRIDE_VAR = 'FOTHERING_PROPERTY_SEED';

// Only an unsigned base-10 integer string is honored, so a stray or malformed value can never
// change the seed silently (D-28).
const UNSIGNED_INTEGER_RE = /^\d+$/;

export function propertySeed(): number {
  const override = process.env[OVERRIDE_VAR];
  if (override !== undefined && UNSIGNED_INTEGER_RE.test(override)) return Number(override);
  return DEFAULT_SEED;
}
