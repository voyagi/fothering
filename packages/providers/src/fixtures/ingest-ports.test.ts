import { describe, expect, it } from 'vitest';
import {
  PARTITION_KEY,
  RECIPIENT_INDEX_NAME,
  RECIPIENT_KEY,
  RETENTION_SECONDS,
  SORT_KEY,
  TTL_ATTRIBUTE,
  expiresAtFor,
  type EventRecord,
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

// The fields the breaking cases below rewrite on a copy of the doc-derived Bounce.
interface EditableBounce {
  detail: {
    mail: { timestamp: string };
    bounce: { timestamp: string; bouncedRecipients: { emailAddress: string }[] };
  };
}

function editableBounce(): EditableBounce {
  return structuredClone(loadSesEventFixture('bounce').event) as EditableBounce;
}

function docLane() {
  const lane = findLane(DOC_EXAMPLE_LANE_MAP, 'ConfigSet');
  if (lane === undefined) throw new Error('fixture configuration set is not in DOC_EXAMPLE_LANE_MAP');
  return lane;
}

function minimizeRaw(raw: unknown, keySet: AddressKeySet = TEST_ADDRESS_KEY_SET): EventRecord[] {
  const parsed = parseSesEvent(raw);
  if (!parsed.ok) throw new Error('expected the edited event to parse');
  return minimizeEvent(parsed.event, {
    lane: docLane(),
    laneMap: DOC_EXAMPLE_LANE_MAP,
    keySet,
    provenance: 'doc-derived',
    envelopeTimeMs: 0,
    arrivalTimeMs: 0,
  });
}

function onlyRecord(records: EventRecord[]): EventRecord {
  const [record] = records;
  if (record === undefined || records.length !== 1) throw new Error(`expected one record, got ${records.length}`);
  return record;
}

describe('breaking cases on the parse and minimize path', () => {
  it('reads hostile or partial input as a failed parse, keeping a readable message id and nothing else', () => {
    for (const raw of [null, undefined, 'text', 42, [], {}, { detail: null }, { detail: { mail: null } }]) {
      expect(parseSesEvent(raw)).toEqual({ ok: false });
    }
    expect(parseSesEvent({ detail: { mail: { messageId: 42 } } })).toEqual({ ok: false });
    expect(parseSesEvent({ detail: { mail: { messageId: 'm-1' } } })).toEqual({ ok: false, messageId: 'm-1' });
  });

  // JSON.parse makes "__proto__" an own key, the shape an EventBridge payload arrives in. Copying
  // it into a fresh object with plain assignment would swap that object's prototype instead.
  it('parses a __proto__ tag key without changing the tags object prototype or Object.prototype', () => {
    const text = JSON.stringify(loadSesEventFixture('bounce').event).replace('"tags":{', '"tags":{"__proto__":["polluted"],');
    expect(text).toContain('"__proto__"');
    const parsed = parseSesEvent(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { tags } = parsed.event.detail.mail;
    expect(Array.isArray(Object.getPrototypeOf(tags))).toBe(false);
    expect(tags['ses:configuration-set']).toEqual(['ConfigSet']);
    expect((Object.prototype as Record<string, unknown>)['0']).toBeUndefined();
    expect(({} as Record<string, unknown>).length).toBeUndefined();
  });

  it('gives one record key to one mailbox however the bounce spells it, so a respelled retry stays a duplicate', async () => {
    const respelled = editableBounce();
    const recipient = respelled.detail.bounce.bouncedRecipients[0];
    if (recipient === undefined) throw new Error('fixture bounce has no recipient');
    recipient.emailAddress = '  Recipient@EXAMPLE.com ';

    const plain = onlyRecord(minimizeRaw(editableBounce()));
    const other = onlyRecord(minimizeRaw(respelled));
    expect(other.sk).toBe(plain.sk);
    expect(other.receivingDomain).toBe('example.com');

    const store = createFixtureEventStore();
    expect(await store.putIfAbsent(plain)).toBe('written');
    expect(await store.putIfAbsent(other)).toBe('duplicate');
  });

  it('writes one counted record per bounced recipient, each under its own key', async () => {
    const two = editableBounce();
    two.detail.bounce.bouncedRecipients.push({ emailAddress: 'second@example.org' });
    const records = minimizeRaw(two);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.sk)).size).toBe(2);
    expect(records.map((record) => record.receivingDomain)).toEqual(['example.com', 'example.org']);

    const store = createFixtureEventStore();
    for (const record of records) expect(await store.putIfAbsent(record)).toBe('written');
    const first = records[0];
    if (first === undefined) throw new Error('expected records');
    const stored = await store.queryLane('ConfigSet', first.bucketStartMs, first.bucketStartMs, first.mailTimestampMs + ONE_HOUR_MS);
    expect(countRecords(stored).Bounce).toBe(2);
  });

  it('chooses the address key by send time, so a rotation one millisecond later leaves the key unchanged', () => {
    const event = editableBounce();
    const sendMs = Date.parse(event.detail.mail.timestamp);
    const keySetWith = (k2ActiveFromMs: number): AddressKeySet => ({
      versions: [
        { id: 'k1', secret: 'k1-fixture-secret-not-for-deployed-use', activeFromMs: 0 },
        { id: 'k2', secret: 'k2-fixture-secret-not-for-deployed-use', activeFromMs: k2ActiveFromMs },
      ],
    });
    const before = onlyRecord(minimizeRaw(event, keySetWith(sendMs + 1)));
    const at = onlyRecord(minimizeRaw(event, keySetWith(sendMs)));
    expect(before.keyVersion).toBe('k1');
    expect(at.keyVersion).toBe('k2');
    expect(at.recipientHmac).not.toBe(before.recipientHmac);
  });

  it('buckets and expires a late bounce by its send time, keeping the bounce time as the event time', () => {
    const late = editableBounce();
    const sendMs = Date.parse(late.detail.mail.timestamp);
    const bounceMs = sendMs + 6 * ONE_HOUR_MS;
    late.detail.bounce.timestamp = new Date(bounceMs).toISOString();
    const record = onlyRecord(minimizeRaw(late));
    expect(record.bucketStartMs).toBe(bucketStartMs(sendMs));
    expect(record.expiresAt).toBe(expiresAtFor(sendMs));
    expect(record.eventTimestampMs).toBe(bounceMs);
  });

  // A record's partition is its lane, and a lane's counts decide whether that lane is closed, so
  // a lane that is not the event's own must stop the minimize rather than file records under it.
  it('refuses to minimize an event under a lane other than its configuration set', () => {
    const parsed = parseSesEvent(loadSesEventFixture('bounce').event);
    if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
    const context = {
      laneMap: DOC_EXAMPLE_LANE_MAP,
      keySet: TEST_ADDRESS_KEY_SET,
      provenance: 'doc-derived' as const,
      envelopeTimeMs: 0,
      arrivalTimeMs: 0,
    };
    expect(() => minimizeEvent(parsed.event, { ...context, lane: { ...docLane(), configurationSet: 'OtherSet' } })).toThrow(
      'does not match the lane',
    );
    expect(minimizeEvent(parsed.event, { ...context, lane: docLane() })).toHaveLength(1);
  });

  it('keeps the receiving server diagnostic text out of every record', () => {
    const serialized = JSON.stringify(minimizeRaw(editableBounce()));
    expect(JSON.stringify(loadSesEventFixture('bounce'))).toContain('user unknown');
    expect(serialized).not.toContain('user unknown');
    expect(serialized).not.toContain('smtp;');
  });
});

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

  // The DynamoDB document client refuses NaN and the infinities when it marshals a number
  // ("Special numeric value NaN is not allowed", util-dynamodb convertToAttr), so a record or a
  // query clock holding one fails live. A query's bucket bounds never reach the marshaller: the
  // live adapter pads them into sort-key strings, where NaN would silently select nothing, so
  // plan 01-03's adapter refuses them explicitly. The fixture refuses both, never storing the
  // record or reading a NaN bound as "every bucket".
  it('rejects a record holding NaN or an infinity anywhere, and stores nothing', async () => {
    const { records } = await minimizeFixture();
    const original = records[0];
    if (original === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();

    const nanBucket = { ...structuredClone(original), bucketStartMs: Number.NaN };
    await expect(store.putIfAbsent(nanBucket)).rejects.toThrow('Special numeric value NaN is not allowed');
    expect(await store.getRecord({ pk: nanBucket.pk, sk: nanBucket.sk })).toBeUndefined();

    const infiniteField = structuredClone(original);
    infiniteField.fields.delayTimestampMs = Number.POSITIVE_INFINITY;
    await expect(store.putIfAbsent(infiniteField)).rejects.toThrow('Special numeric value Infinity is not allowed');
  });

  // The same marshaller, with the default options plan 01-03's adapter uses, also refuses an
  // undefined value at any depth and a number outside the safe integer range (util-dynamodb
  // convertToAttr and convertToNumberAttr). exactOptionalPropertyTypes keeps undefined out of
  // typed code, so these records are built through a cast, the way untyped data would arrive.
  it('rejects a record holding an undefined value or an unsafe integer, and stores nothing', async () => {
    const { records } = await minimizeFixture();
    const original = records[0];
    if (original === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();
    const undefinedMessage = 'Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.';

    const topLevelUndefined = { ...structuredClone(original), feedbackId: undefined } as unknown as EventRecord;
    await expect(store.putIfAbsent(topLevelUndefined)).rejects.toThrow(undefinedMessage);
    expect(await store.getRecord({ pk: original.pk, sk: original.sk })).toBeUndefined();

    const nestedUndefined = structuredClone(original);
    (nestedUndefined.fields as Record<string, unknown>).bounceType = undefined;
    await expect(store.putIfAbsent(nestedUndefined)).rejects.toThrow(undefinedMessage);

    const tooLarge = { ...structuredClone(original), recipientCount: Number.MAX_SAFE_INTEGER + 2 };
    await expect(store.putIfAbsent(tooLarge)).rejects.toThrow('is greater than Number.MAX_SAFE_INTEGER');

    const tooSmall = { ...structuredClone(original), recipientCount: Number.MIN_SAFE_INTEGER - 2 };
    await expect(store.putIfAbsent(tooSmall)).rejects.toThrow('is lesser than Number.MIN_SAFE_INTEGER');
    expect(await store.getRecord({ pk: original.pk, sk: original.sk })).toBeUndefined();
  });

  it('rejects a lane query whose bucket bounds or clock are not finite numbers', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);
    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;

    await expect(store.queryLane(record.configurationSet, Number.NaN, Number.NaN, nowMs)).rejects.toThrow(
      'Special numeric value NaN is not allowed',
    );
    await expect(
      store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, Number.NaN),
    ).rejects.toThrow('Special numeric value NaN is not allowed');
  });

  // DynamoDB answers an inverted BETWEEN key condition with a ValidationException rather than an
  // empty page, so a caller that computes its window backwards fails live and must fail here too.
  it('rejects a lane query whose first bucket lies after its last, as DynamoDB rejects an inverted BETWEEN', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);
    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;

    await expect(
      store.queryLane(record.configurationSet, record.bucketStartMs + BUCKET_MS, record.bucketStartMs, nowMs),
    ).rejects.toThrow('The BETWEEN operator requires upper bound to be greater than or equal to lower bound');
    expect(await store.queryLane(record.configurationSet, record.bucketStartMs, record.bucketStartMs, nowMs)).toHaveLength(1);
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

  // The live queue's message body is the JSON of the records (plan 01-03), so a record the store
  // refused for holding NaN reaches the queue with null there, and an undefined key is gone.
  it('dead-letters a JSON copy, as the live queue message body is, so NaN reads back as null', async () => {
    const { records } = await minimizeFixture();
    const original = records[0];
    if (original === undefined) throw new Error('expected at least one minimized record');
    const refused = { ...structuredClone(original), bucketStartMs: Number.NaN, feedbackId: undefined } as unknown as EventRecord;
    const store = createFixtureEventStore();
    await expect(store.putIfAbsent(refused)).rejects.toThrow();

    const deadLetter = createFixtureDeadLetter();
    await deadLetter.send([refused]);
    const [batch] = deadLetter.sent;
    const [queued] = batch ?? [];
    expect((queued as unknown as Record<string, unknown>).bucketStartMs).toBeNull();
    expect(queued !== undefined && Object.hasOwn(queued, 'feedbackId')).toBe(false);
    expect(queued?.messageId).toBe(original.messageId);
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
