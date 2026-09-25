import { describe, expect, it } from 'vitest';
import { expiresAtFor, recordKey, RETENTION_SECONDS } from './records.js';

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
});

describe('expiresAtFor', () => {
  it('keeps the retention window at exactly 30 days', () => {
    expect(RETENTION_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('expires a record 30 days after its send time, in whole epoch seconds as the TTL attribute requires', () => {
    expect(expiresAtFor(1_790_000_000_999)).toBe(1_790_000_000 + 2_592_000);
  });
});
