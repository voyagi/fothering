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
import { bucketStartMs, countRecords } from '@fothering/core/buckets';
import { findLane } from '@fothering/core/lanes';
import { minimizeEvent } from '@fothering/core/minimize';
import { parseSesEvent } from '@fothering/core/ses-events';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture } from './ses-events/index.js';
import { createFixtureAddressKey, createFixtureEventStore, TEST_ADDRESS_KEY_SET } from './ingest-ports.js';

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
