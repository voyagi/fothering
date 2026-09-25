import { describe, expect, it } from 'vitest';
import { bucketSortKeyPrefix, expiresAtFor, recordKey, RETENTION_SECONDS } from './records.js';

describe('bucketSortKeyPrefix', () => {
  it('pads the first and the last representable bucket start to 13 digits', () => {
    expect(bucketSortKeyPrefix(0)).toBe('B#0000000000000');
    expect(bucketSortKeyPrefix(9_999_999_999_999)).toBe('B#9999999999999');
  });

  it('is the prefix of every record key, so a range bound built from it selects that bucket', () => {
    const { sk } = recordKey({ configurationSet: 'x', bucketStartMs: 300_000, eventType: 'Bounce', identity: 'i' });
    expect(sk.startsWith(`${bucketSortKeyPrefix(300_000)}#`)).toBe(true);
  });
});

describe('recordKey', () => {
  it('builds the lane partition key and a sort key with the bucket zero-padded to 13 digits', () => {
    expect(
      recordKey({ configurationSet: 'marketing', bucketStartMs: 300_000, eventType: 'Bounce', identity: 'fb-1#abc' }),
    ).toEqual({ pk: 'LANE#marketing', sk: 'B#0000000300000#Bounce#fb-1#abc' });
  });

  it('orders sort keys by bucket start when compared as strings, so a key range query is a time range query', () => {
    const early = recordKey({ configurationSet: 'x', bucketStartMs: 300_000, eventType: 'Send', identity: 'i' }).sk;
    const late = recordKey({ configurationSet: 'x', bucketStartMs: 1_790_000_100_000, eventType: 'Send', identity: 'i' }).sk;
    expect(early < late).toBe(true);
  });

  // Padded, a negative or 14-digit start sorts before every real bucket and NaN pads to letters, so
  // the range query reading the lane back would skip or mix buckets without an error.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -300_000, 1.5, 10_000_000_000_000])(
    'refuses a bucket start of %s, which cannot be written as a 13-digit sort key',
    (bucketStartMs) => {
      expect(() => recordKey({ configurationSet: 'x', bucketStartMs, eventType: 'Send', identity: 'i' })).toThrow(RangeError);
    },
  );
});

describe('expiresAtFor', () => {
  it('keeps the retention window at exactly 30 days', () => {
    expect(RETENTION_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('expires a record 30 days after its send time, in whole epoch seconds as the TTL attribute requires', () => {
    expect(expiresAtFor(1_790_000_000_999)).toBe(1_790_000_000 + 2_592_000);
  });
});
