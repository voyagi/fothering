import { describe, expect, it } from 'vitest';
import {
  PARTITION_KEY,
  RECIPIENT_INDEX_NAME,
  RECIPIENT_KEY,
  RETENTION_SECONDS,
  SORT_KEY,
  TTL_ATTRIBUTE,
  expiresAtFor,
} from '@fothering/core/records';
import { BUCKET_MS, bucketStartMs, countRecords } from '@fothering/core/buckets';
import { findLane } from '@fothering/core/lanes';
import { minimizeEvent } from '@fothering/core/minimize';
import { parseSesEvent } from '@fothering/core/ses-events';
import { selectKeyVersion, type AddressKeySet } from '@fothering/core/address';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture } from './ses-events/index.js';
import {
  FixtureWriteError,
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureEventStore,
  TEST_ADDRESS_KEY_SET,
} from './ingest-ports.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

// Shared walk: load the doc-derived Bounce, parse it, find its lane, minimize it. Every case
// below exercises a different downstream assertion over the same minimized records.
async function minimizeFixture() {
  const fixture = loadSesEventFixture('bounce');
  const parsed = parseSesEvent(fixture.event);
  if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
  const configurationSet = parsed.event.detail.mail.tags['ses:configuration-set']?.[0];
  if (configurationSet === undefined) throw new Error('fixture bounce event carries no configuration-set tag');
  const lane = findLane(DOC_EXAMPLE_LANE_MAP, configurationSet);
  if (lane === undefined) throw new Error('fixture configuration set is not in DOC_EXAMPLE_LANE_MAP');
  const keySet = await createFixtureAddressKey().getKeySet();
  const records = minimizeEvent(parsed.event, {
    lane,
    laneMap: DOC_EXAMPLE_LANE_MAP,
    keySet,
    provenance: 'doc-derived',
    envelopeTimeMs: Date.parse(parsed.event.time),
    arrivalTimeMs: Date.parse(parsed.event.time),
  });
  return { fixture, parsed, lane, keySet, records };
}

describe('the doc-derived Bounce through core and the fixture event store', () => {
  it('parses, minimizes, writes once and counts one Bounce in its send-time bucket', async () => {
    const { parsed, keySet, records } = await minimizeFixture();
    expect(parsed.ok).toBe(true);
    expect(keySet).toBe(TEST_ADDRESS_KEY_SET);
    if (!parsed.ok) return;

    const store = createFixtureEventStore();
    for (const record of records) {
      expect(await store.putIfAbsent(record)).toBe('written');
    }

    const mailTimestampMs = Date.parse(parsed.event.detail.mail.timestamp);
    const bucket = bucketStartMs(mailTimestampMs);
    const nowMs = mailTimestampMs + ONE_HOUR_MS;
    const stored = await store.queryLane('ConfigSet', bucket, bucket, nowMs);
    const counts = countRecords(stored);

    expect(counts.Bounce).toBe(1);
  });

  it('rejects a second write of the same records as duplicate, leaving one record stored', async () => {
    const { records } = await minimizeFixture();
    const store = createFixtureEventStore();
    for (const record of records) {
      expect(await store.putIfAbsent(record)).toBe('written');
    }
    for (const record of records) {
      expect(await store.putIfAbsent(record)).toBe('duplicate');
    }
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;
    const stored = await store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, nowMs);
    expect(stored).toHaveLength(1);
  });

  it('stores no recipient or sender address, only a hashed identity, while the raw fixture carries both', async () => {
    const { fixture, records } = await minimizeFixture();
    const raw = JSON.stringify(fixture);
    expect(raw).toContain('recipient@example.com');
    expect(raw).toContain('sender@example.com');

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('recipient@example.com');
    expect(serialized).not.toContain('sender@example.com');

    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    expect(record.recipientHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(record.receivingDomain).toBe('example.com');
    expect(record.keyVersion).toBe('k1');
    expect(record.provenance).toBe('doc-derived');
    expect(record.expiresAt).toBe(expiresAtFor(record.mailTimestampMs));
  });

  it('pins the table key names, TTL attribute and retention window', () => {
    expect(PARTITION_KEY).toBe('pk');
    expect(SORT_KEY).toBe('sk');
    expect(RECIPIENT_KEY).toBe('recipientHmac');
    expect(RECIPIENT_INDEX_NAME).toBe('byRecipient');
    expect(TTL_ATTRIBUTE).toBe('expiresAt');
    expect(RETENTION_SECONDS).toBe(2_592_000);
  });
});

describe('the fixture ports behave like the conditional-write store and queue they stand in for', () => {
  it('gives exactly one written and one duplicate for two concurrent puts of the same key', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();

    const outcomes = await Promise.all([store.putIfAbsent(record), store.putIfAbsent(record)]);
    expect(outcomes.sort()).toEqual(['duplicate', 'written']);

    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;
    const stored = await store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, nowMs);
    expect(stored).toHaveLength(1);
  });

  it('excludes a record outside the requested bucket range and one expiring exactly at now', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);

    const outsideRange = await store.queryLane(
      record.configurationSet,
      record.bucketStartMs + BUCKET_MS,
      record.bucketStartMs + BUCKET_MS,
      record.mailTimestampMs + ONE_HOUR_MS,
    );
    expect(outsideRange).toHaveLength(0);

    const nowAtExpiryMs = record.expiresAt * 1000;
    const atExpiry = await store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, nowAtExpiryMs);
    expect(atExpiry).toHaveLength(0);

    const beforeExpiry = await store.queryLane(
      record.configurationSet,
      record.bucketStartMs,
      record.bucketStartMs,
      nowAtExpiryMs - 1000,
    );
    expect(beforeExpiry).toHaveLength(1);
  });

  // DynamoDB stores and returns copies, so a caller changing its own object after a put, or a
  // record a read returned, never changes what the table holds. The fixture must match.
  it('keeps what was stored when the caller mutates the written or the returned record', async () => {
    const { records } = await minimizeFixture();
    const original = records[0];
    if (original === undefined) throw new Error('expected at least one minimized record');
    const record = structuredClone(original);
    const key = { pk: record.pk, sk: record.sk };
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);

    record.messageId = 'changed-after-put';
    expect((await store.getRecord(key))?.messageId).toBe(original.messageId);

    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;
    const [returned] = await store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, nowMs);
    if (returned === undefined) throw new Error('expected the stored record back');
    returned.messageId = 'changed-after-read';
    const fetched = await store.getRecord(key);
    if (fetched === undefined) throw new Error('expected the stored record back');
    fetched.fields.bounceType = 'changed-after-get';
    expect(await store.getRecord(key)).toEqual(original);
  });

  it('finds a record by its recipient hash, then a delete makes a re-read return undefined', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    if (record.recipientHmac === undefined) throw new Error('expected the record to carry a recipient hash');
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);

    const keys = await store.queryByRecipient(record.recipientHmac);
    expect(keys).toEqual([{ pk: record.pk, sk: record.sk }]);

    await store.deleteRecord({ pk: record.pk, sk: record.sk });
    expect(await store.getRecord({ pk: record.pk, sk: record.sk })).toBeUndefined();
  });

  it('rejects a put configured to fail, and the dead letter records batches and rejects when configured to fail', async () => {
    const { records } = await minimizeFixture();

    const failingStore = createFixtureEventStore({ eventStoreFailure: 'put' });
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    await expect(failingStore.putIfAbsent(record)).rejects.toThrow(FixtureWriteError);

    const deadLetter = createFixtureDeadLetter();
    const sentCopy = structuredClone(records);
    await deadLetter.send(sentCopy);
    const firstSent = sentCopy[0];
    if (firstSent !== undefined) firstSent.messageId = 'changed-after-send';
    expect(deadLetter.sent).toEqual([records]);

    const failingDeadLetter = createFixtureDeadLetter({ deadLetterFailure: 'send' });
    await expect(failingDeadLetter.send(records)).rejects.toThrow(FixtureWriteError);
  });

  it('selects the key version active at or before the send time', () => {
    const rotationMs = 1_700_000_000_000;
    const keySet: AddressKeySet = {
      versions: [
        { id: 'k1', secret: 'k1-secret', activeFromMs: 0 },
        { id: 'k2', secret: 'k2-secret', activeFromMs: rotationMs },
      ],
    };
    expect(selectKeyVersion(keySet, rotationMs - 1).id).toBe('k1');
    expect(selectKeyVersion(keySet, rotationMs).id).toBe('k2');
  });
});
