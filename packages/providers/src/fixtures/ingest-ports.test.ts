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
import { BUCKET_MS, bucketStartMs, countRecords, isCountedRecord } from '@fothering/core/buckets';
import { REQUIRED_EVENT_TYPES, checkCloseability, type SesConfigurationFacts } from '@fothering/core/closeability';
import { decideLane } from '@fothering/core/decision';
import {
  buildEvidenceRecord,
  counterDayKey,
  evidenceRecordSchema,
  incidentIdFor,
  incidentItemKey,
  recordHash,
  type EvidenceRecord,
} from '@fothering/core/evidence-record';
import { buildTagRows } from '@fothering/core/evidence-rows';
import { findLane, parseLaneMap } from '@fothering/core/lanes';
import { minimizeEvent } from '@fothering/core/minimize';
import { parseSesEvent } from '@fothering/core/ses-events';
import { selectKeyVersion, type AddressKeySet } from '@fothering/core/address';
import { scenarioRecords, type LaneScenario } from '@fothering/core/test/event-arbitraries';
import { LANE_RATIO_LABELS, LANE_SHARE_LABEL, laneSpikeVerdict, renderPercent } from '@fothering/core/verdicts';
import {
  MAX_WINDOW_BUCKETS,
  WindowTooLongError,
  createWindowFold,
  spikeWindowFor,
  summarizeWindow,
  type LaneFold,
} from '@fothering/core/window-fold';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import { createDryRunLog } from '../dry-run.js';
import type { LaneAttemptRequest, ReservationRequest, UsageRecord } from '../port-types.js';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture } from './ses-events/index.js';
import {
  FixtureWriteError,
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureDecisionStore,
  createFixtureEventStore,
  createFixtureTableState,
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
  // live adapter pads them into sort-key strings with bucketSortKeyPrefix, which refuses a bound
  // no key could hold. The fixture refuses both, never storing the record or reading a NaN bound
  // as "every bucket".
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

  it('rejects a lane query whose bucket bounds cannot be sort keys or whose clock is not a finite number', async () => {
    const { records } = await minimizeFixture();
    const record = records[0];
    if (record === undefined) throw new Error('expected at least one minimized record');
    const store = createFixtureEventStore();
    await store.putIfAbsent(record);
    const nowMs = record.mailTimestampMs + ONE_HOUR_MS;

    for (const bound of [Number.NaN, -BUCKET_MS, record.bucketStartMs + 0.5]) {
      await expect(store.queryLane(record.configurationSet, bound, record.bucketStartMs, nowMs)).rejects.toThrow(RangeError);
      await expect(store.queryLane(record.configurationSet, record.bucketStartMs, bound, nowMs)).rejects.toThrow(RangeError);
    }
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

    await expect(store.deleteRecord({ pk: record.pk, sk: record.sk })).resolves.toBe(true);
    expect(await store.getRecord({ pk: record.pk, sk: record.sk })).toBeUndefined();
    // A second delete of the same key removes nothing, as the live conditional delete reports it.
    await expect(store.deleteRecord({ pk: record.pk, sk: record.sk })).resolves.toBe(false);
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

const LANES = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const TRACER_NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);

const ONE_BAD_BATCH: LaneScenario = {
  configurationSet: BULK,
  streamTag: 'newsletter',
  callerIdentity: 'bulk-sender',
  fromDomain: 'news.example.com',
  groups: [
    { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ],
};

const BULK_SES_FACTS: SesConfigurationFacts = {
  configurationSets: new Set(LANES.lanes.map((lane) => lane.configurationSet)),
  defaultConfigurationSets: new Set(),
  eventDestinations: new Map([[BULK, [{ enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] }]]]),
};

async function tracerRecord() {
  const records = scenarioRecords(ONE_BAD_BATCH, TRACER_NOW_MS, LANES, TEST_ADDRESS_KEY_SET);
  const table = createFixtureTableState();
  const events = createFixtureEventStore({ pageSize: 2, store: table });
  for (const record of records) expect(await events.putIfAbsent(record)).toBe('written');

  const window = spikeWindowFor(TRACER_NOW_MS);
  const fold = createWindowFold({ lane: BULK, window, nowMs: TRACER_NOW_MS });
  const summary = summarizeWindow(await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS, fold));
  const spike = laneSpikeVerdict(summary.totals);
  const rows = buildTagRows('batch', summary, spike);
  const closeability = checkCloseability(BULK, { laneMap: LANES, observed: new Map([[BULK, summary.observed]]), ses: BULK_SES_FACTS });
  const decision = decideLane({ spike, rows, configurationRows: [], closeability, coverageNoData: false, bound: null, otherSpikingLanes: [] });
  const countable = records.filter(isCountedRecord).length;

  const record = buildEvidenceRecord({
    incidentId: incidentIdFor(BULK, bucketStartMs(TRACER_NOW_MS)),
    lane: { configurationSet: BULK, lane: BULK },
    window,
    laneTotals: {
      recipientSends: summary.totals.recipientSends,
      permanentBounces: summary.totals.permanentBounces,
      complaints: summary.totals.complaints,
      hardBounceRatio: spike.hardBounceRatio,
      complaintRatio: spike.complaintRatio,
      verdict: spike.verdict,
      triggers: [...spike.triggers],
      label: { hardBounceRatio: LANE_RATIO_LABELS.hardBounce, complaintRatio: LANE_RATIO_LABELS.complaint },
    },
    share: { laneCountableEvents: countable, storedCountableEvents: countable, percent: renderPercent(countable, countable), label: LANE_SHARE_LABEL },
    rows,
    configurationRows: [],
    isolation: 'confined',
    decision: { ...decision, noData: false, bound: null, otherSpikingLanes: [], sharedCause: null },
    question: null,
    fix: null,
    expiresAt: Math.floor(TRACER_NOW_MS / 1000) + RETENTION_SECONDS,
  });
  return { records, table, summary, spike, rows, closeability, decision, record };
}

describe('tracer: one bad import batch on fothering-bulk becomes an evidence record with one approved option', () => {
  it('folds the stored batch page by page into a spike, a cause row, a closeable lane, an approval and a hashed record', async () => {
    const { table, summary, spike, rows, closeability, decision, record } = await tracerRecord();

    expect(spike.verdict).toBe('spike');
    expect(spike.hardBounceRatio).toBe('7.50%');
    expect(summary.totals.recipientSends).toBe(200);
    expect(summary.totals.permanentBounces).toBe(15);
    expect(Object.fromEntries(rows.map((row) => [row.value, row.verdict]))).toEqual({
      'import-0915': 'cause',
      'import-0901': 'ruled-out',
    });
    expect(closeability.state).toBe('closeable');
    expect(decision.outcome).toBe('approved');

    expect(record.approvedOptions).toHaveLength(1);
    const [option] = record.approvedOptions;
    expect(option?.optionId).toMatch(/^opt-[0-9a-f]{24}$/);
    expect(option?.optionId).not.toContain(BULK);
    expect(recordHash(record)).toBe(record.hash);

    const decisions = createFixtureDecisionStore({ store: table });
    const key = incidentItemKey(record.incidentId, 'EVIDENCE');
    const item = { ...key, expiresAt: record.expiresAt, record };
    expect(await decisions.putIfAbsent(item, TRACER_NOW_MS)).toBe('written');
    expect(await decisions.putIfAbsent(item, TRACER_NOW_MS)).toBe('duplicate');
    const stored = await decisions.getItem(key, TRACER_NOW_MS);
    const storedRecord = evidenceRecordSchema.parse(stored?.record);
    expect(recordHash(storedRecord)).toBe(record.hash);
  });

  it('puts no recipient hash, address or receiving domain into the record', async () => {
    const { records, record } = await tracerRecord();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('@');
    for (const stored of records) {
      if (stored.recipientHmac !== undefined) expect(serialized).not.toContain(stored.recipientHmac);
      if (stored.receivingDomain !== undefined) expect(serialized).not.toContain(stored.receivingDomain);
    }
  });

  it('refuses a record with an extra key and a record holding a non-integer count', async () => {
    const { record } = await tracerRecord();
    expect(evidenceRecordSchema.safeParse(record).success).toBe(true);
    expect(evidenceRecordSchema.safeParse({ ...record, note: 'extra' }).success).toBe(false);
    const fractional: EvidenceRecord = { ...record, laneTotals: { ...record.laneTotals, recipientSends: 200.5 } };
    expect(evidenceRecordSchema.safeParse(fractional).success).toBe(false);
  });
});

function bulkRecords(groups: LaneScenario['groups'], nowMs: number = TRACER_NOW_MS): EventRecord[] {
  return scenarioRecords({ ...ONE_BAD_BATCH, groups }, nowMs, LANES, TEST_ADDRESS_KEY_SET);
}

function bulkFold(window = spikeWindowFor(TRACER_NOW_MS), nowMs: number = TRACER_NOW_MS) {
  return createWindowFold({ lane: BULK, window, nowMs });
}

// Wraps a fold so a test sees every page the store delivers, in order, without changing the result.
function watched<S>(fold: LaneFold<S>, onPage: (page: readonly EventRecord[], index: number) => void): LaneFold<S> {
  let index = 0;
  return {
    initial: fold.initial,
    step(state, page) {
      onPage(page, index);
      index += 1;
      return fold.step(state, page);
    },
  };
}

async function storeHolding(records: readonly EventRecord[], pageSize = 2) {
  const table = createFixtureTableState();
  const events = createFixtureEventStore({ pageSize, store: table });
  for (const record of records) await events.putIfAbsent(record);
  return { table, events };
}

describe('the fixture store reads a lane window page by page into a fold (R1)', () => {
  it('delivers 1,000 records of one lane in exactly 500 pages at page size 2 (AC-1)', async () => {
    const records = bulkRecords([{ bucketOffset: 0, count: 500 }]);
    expect(records).toHaveLength(1_000);
    const { events } = await storeHolding(records);
    const window = spikeWindowFor(TRACER_NOW_MS);
    const pageSizes: number[] = [];
    const state = await events.foldLane(
      BULK,
      window.fromBucketMs,
      window.toBucketMs,
      TRACER_NOW_MS,
      watched(bulkFold(), (page) => pageSizes.push(page.length)),
    );
    expect(state.pages).toBe(500);
    expect(pageSizes.every((size) => size === 2)).toBe(true);
    expect(summarizeWindow(state).totals.recipientSends).toBe(500);
  });

  it('counts nowhere a record stored already expired inside the window, and counts it inside its retention (AC-2)', async () => {
    const oldNowMs = TRACER_NOW_MS - 31 * 24 * 60 * 60 * 1000;
    const oldWindow = spikeWindowFor(oldNowMs);
    const records = bulkRecords([{ bucketOffset: 0, count: 4, batch: 'stale', permanentBounces: 1 }], oldNowMs);
    const { events } = await storeHolding(records);
    const fold = () => bulkFold(oldWindow, TRACER_NOW_MS);
    const delivered: EventRecord[] = [];
    const expired = summarizeWindow(
      await events.foldLane(BULK, oldWindow.fromBucketMs, oldWindow.toBucketMs, TRACER_NOW_MS, watched(fold(), (page) => delivered.push(...page))),
    );
    expect(delivered).toHaveLength(0);
    expect(expired.totals).toMatchObject({ recipientSends: 0, permanentBounces: 0 });
    expect(expired.dimensions.batch.size).toBe(0);
    expect(expired.observed.recordCount).toBe(0);

    const live = summarizeWindow(
      await events.foldLane(BULK, oldWindow.fromBucketMs, oldWindow.toBucketMs, oldNowMs, bulkFold(oldWindow, oldNowMs)),
    );
    expect(live.totals).toMatchObject({ recipientSends: 4, permanentBounces: 1 });
  });

  it('folds a window of exactly MAX_WINDOW_BUCKETS buckets and refuses one more before any page reaches the fold (AC-E1)', async () => {
    const { events } = await storeHolding(bulkRecords([{ bucketOffset: 0, count: 3 }]));
    const toBucketMs = bucketStartMs(TRACER_NOW_MS);
    const longest = { fromBucketMs: toBucketMs - (MAX_WINDOW_BUCKETS - 1) * BUCKET_MS, toBucketMs };
    const folded = await events.foldLane(BULK, longest.fromBucketMs, longest.toBucketMs, TRACER_NOW_MS, bulkFold(longest));
    expect(summarizeWindow(folded).buckets).toHaveLength(MAX_WINDOW_BUCKETS);

    let steps = 0;
    const counting = watched(bulkFold(), () => {
      steps += 1;
    });
    await expect(
      events.foldLane(BULK, toBucketMs - MAX_WINDOW_BUCKETS * BUCKET_MS, toBucketMs, TRACER_NOW_MS, counting),
    ).rejects.toThrow(WindowTooLongError);
    expect(steps).toBe(0);
  });

  it('skips a stored record whose expiresAt equals now in seconds and counts it one second earlier (AC-E2)', async () => {
    const [send] = bulkRecords([{ bucketOffset: 0, count: 1, deliverRest: false }]);
    if (send === undefined) throw new Error('expected one send');
    send.expiresAt = Math.floor(TRACER_NOW_MS / 1000);
    const { events } = await storeHolding([send]);
    const window = spikeWindowFor(TRACER_NOW_MS);
    const at = await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS, bulkFold());
    expect(summarizeWindow(at).totals.recipientSends).toBe(0);
    const before = await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS - 1000, bulkFold(window, TRACER_NOW_MS - 1000));
    expect(summarizeWindow(before).totals.recipientSends).toBe(1);
  });

  it('delivers one empty page for an empty window, as a DynamoDB query answers one (AC-E3)', async () => {
    const { events } = await storeHolding([]);
    const window = spikeWindowFor(TRACER_NOW_MS);
    const pages: number[] = [];
    const state = await events.foldLane(
      BULK,
      window.fromBucketMs,
      window.toBucketMs,
      TRACER_NOW_MS,
      watched(bulkFold(), (page) => pages.push(page.length)),
    );
    expect(pages).toEqual([0]);
    expect(summarizeWindow(state).buckets.every((bucket) => bucket.send === 0)).toBe(true);
  });

  it('returns records in the UTF-8 byte order of the sort key, whatever order they were written in (D-43)', async () => {
    const records = bulkRecords([{ bucketOffset: 3, count: 5, permanentBounces: 2 }]);
    const [send] = records.filter((record) => record.kind === 'send');
    if (send === undefined) throw new Error('expected a send');
    // U+FF5E sorts after U+10000 by UTF-16 code unit (0xFF5E against the surrogate 0xD800) and before
    // it by UTF-8 byte (0xEF against 0xF0), so only a byte comparison puts the first one first.
    const bmp = { ...structuredClone(send), sk: `${send.sk}#～` };
    const astral = { ...structuredClone(send), sk: `${send.sk}#\u{10000}` };
    expect([bmp.sk, astral.sk].sort()).toEqual([astral.sk, bmp.sk]);
    const written = [...records, bmp, astral].sort((left, right) => (left.sk < right.sk ? 1 : -1));
    const { events } = await storeHolding(written, 3);
    const window = spikeWindowFor(TRACER_NOW_MS);
    const order: string[] = [];
    await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS, watched(bulkFold(), (page) => order.push(...page.map((record) => record.sk))));
    const byBytes = written.map((record) => record.sk).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect(order).toEqual(byBytes);
    expect(order.indexOf(bmp.sk)).toBeLessThan(order.indexOf(astral.sk));
  });

  it('counts at most once a record written to the shared table while a fold runs (R1 concurrency backstop)', async () => {
    const records = bulkRecords([{ bucketOffset: 0, count: 6 }]);
    const { events } = await storeHolding(records);
    const [extra] = bulkRecords([{ bucketOffset: 1, count: 1, deliverRest: false }]);
    if (extra === undefined) throw new Error('expected one send');
    const window = spikeWindowFor(TRACER_NOW_MS);
    let pending: Promise<'written' | 'duplicate'> | undefined;
    const delivered: string[] = [];
    const during = await events.foldLane(
      BULK,
      window.fromBucketMs,
      window.toBucketMs,
      TRACER_NOW_MS,
      watched(bulkFold(), (page, index) => {
        if (index === 0) pending = events.putIfAbsent(extra);
        delivered.push(...page.map((record) => record.sk));
      }),
    );
    expect(await pending).toBe('written');
    expect(new Set(delivered).size).toBe(delivered.length);
    expect([6, 7]).toContain(summarizeWindow(during).totals.recipientSends);
    const after = await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS, bulkFold());
    expect(summarizeWindow(after).totals.recipientSends).toBe(7);
  });
});

describe('the fixture decision store shares the table without touching event reads (D-65)', () => {
  it('keeps decision items out of every event read and refuses a decision item under a LANE# key', async () => {
    const records = bulkRecords([{ bucketOffset: 0, count: 2 }]);
    const { table, events } = await storeHolding(records);
    const decisions = createFixtureDecisionStore({ store: table });
    const key = incidentItemKey('0'.repeat(32), 'STATE');
    expect(await decisions.putIfAbsent({ ...key, expiresAt: Math.floor(TRACER_NOW_MS / 1000) + 60 }, TRACER_NOW_MS)).toBe('written');

    const window = spikeWindowFor(TRACER_NOW_MS);
    expect(await events.queryLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS)).toHaveLength(records.length);
    expect(await events.getRecord(key)).toBeUndefined();
    const folded = await events.foldLane(BULK, window.fromBucketMs, window.toBucketMs, TRACER_NOW_MS, bulkFold());
    expect(summarizeWindow(folded).totals.recipientSends).toBe(2);

    const [record] = records;
    if (record === undefined) throw new Error('expected a record');
    await expect(decisions.putIfAbsent({ pk: record.pk, sk: 'X', expiresAt: 1 }, TRACER_NOW_MS)).rejects.toThrow(RangeError);
    expect(await decisions.getItem({ pk: record.pk, sk: record.sk }, TRACER_NOW_MS)).toBeUndefined();
  });

  it('answers an item only while its expiresAt is after now, and as a copy', async () => {
    const decisions = createFixtureDecisionStore();
    const nowSeconds = Math.floor(TRACER_NOW_MS / 1000);
    const key = incidentItemKey('1'.repeat(32), 'DECISION');
    await decisions.putIfAbsent({ ...key, expiresAt: nowSeconds, note: 'kept' }, TRACER_NOW_MS);
    expect(await decisions.getItem(key, TRACER_NOW_MS)).toBeUndefined();
    const before = await decisions.getItem(key, TRACER_NOW_MS - 1000);
    expect(before).toEqual({ ...key, expiresAt: nowSeconds, note: 'kept' });
    if (before !== undefined) before.note = 'changed';
    expect((await decisions.getItem(key, TRACER_NOW_MS - 1000))?.note).toBe('kept');
  });

  it('refuses a fixture page size that is not a whole number from 1 up', () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN]) {
      expect(() => createFixtureEventStore({ pageSize })).toThrow(RangeError);
    }
  });
});

const NOW_SECONDS = Math.floor(TRACER_NOW_MS / 1000);
const STATE_KEY = incidentItemKey('2'.repeat(32), 'STATE');
const INCIDENT_COUNTER = incidentItemKey('3'.repeat(32), 'COUNTER');
const DAY_COUNTER = counterDayKey('2026-10-11');

function reservation(overrides: Partial<ReservationRequest> = {}): ReservationRequest {
  return {
    incidentKey: INCIDENT_COUNTER,
    dayKey: DAY_COUNTER,
    incidentCap: 3,
    dayInvocationCap: 10,
    dayTokenCap: 1_000,
    tokenReservation: 100,
    expiresAt: NOW_SECONDS + RETENTION_SECONDS,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { incidentKey: INCIDENT_COUNTER, dayKey: DAY_COUNTER, inputTokens: 1_200, outputTokens: 80, modelCalls: 2, ...overrides };
}

describe('the fixture decision store writes once and updates by version (D-66, AC-E33)', () => {
  it('keeps the first item when a second put names the same key', async () => {
    const decisions = createFixtureDecisionStore();
    expect(await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, note: 'first' }, TRACER_NOW_MS)).toBe('written');
    expect(await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, note: 'second' }, TRACER_NOW_MS)).toBe('duplicate');
    expect((await decisions.getItem(STATE_KEY, TRACER_NOW_MS))?.note).toBe('first');
  });

  it('overwrites an item past its expiresAt that DynamoDB has not deleted yet, and answers written', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS, note: 'expired' }, TRACER_NOW_MS - 60_000);
    expect(await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, note: 'fresh' }, TRACER_NOW_MS)).toBe('written');
    expect((await decisions.getItem(STATE_KEY, TRACER_NOW_MS))?.note).toBe('fresh');
  });

  it('answers duplicate for an item whose expiresAt is one second after now', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 1, note: 'live' }, TRACER_NOW_MS);
    expect(await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, note: 'second' }, TRACER_NOW_MS)).toBe('duplicate');
    expect((await decisions.getItem(STATE_KEY, TRACER_NOW_MS))?.note).toBe('live');
  });

  it('answers duplicate for a stored item that carries no expiresAt', async () => {
    const table = createFixtureTableState();
    table.items.set(`${STATE_KEY.pk}\u0000${STATE_KEY.sk}`, { ...STATE_KEY, note: 'no expiry' });
    const decisions = createFixtureDecisionStore({ store: table });
    expect(await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, note: 'second' }, TRACER_NOW_MS)).toBe('duplicate');
    expect(table.items.get(`${STATE_KEY.pk}\u0000${STATE_KEY.sk}`)).toEqual({ ...STATE_KEY, note: 'no expiry' });
  });

  it('updates an item whose stored version is the expected one, bumping the version and refreshing expiresAt', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1, state: 'open' }, TRACER_NOW_MS);
    expect(await decisions.updateIfVersion(STATE_KEY, 1, { state: 'closed' }, TRACER_NOW_MS)).toBe('updated');
    expect(await decisions.getItem(STATE_KEY, TRACER_NOW_MS)).toEqual({
      ...STATE_KEY,
      expiresAt: NOW_SECONDS + RETENTION_SECONDS,
      version: 2,
      state: 'closed',
    });
  });

  it('answers conflict and changes nothing for a stale version or an item that is not stored', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1, state: 'open' }, TRACER_NOW_MS);
    await decisions.updateIfVersion(STATE_KEY, 1, { state: 'closed' }, TRACER_NOW_MS);
    expect(await decisions.updateIfVersion(STATE_KEY, 1, { state: 'open' }, TRACER_NOW_MS)).toBe('conflict');
    expect((await decisions.getItem(STATE_KEY, TRACER_NOW_MS))?.state).toBe('closed');

    const missing = incidentItemKey('4'.repeat(32), 'STATE');
    expect(await decisions.updateIfVersion(missing, 0, { state: 'open' }, TRACER_NOW_MS)).toBe('conflict');
    expect(await decisions.getItem(missing, TRACER_NOW_MS)).toBeUndefined();
  });

  it('updates only while the stored item also holds each expected attribute value, and changes nothing otherwise', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1, incidentId: 'first', status: 'open' }, TRACER_NOW_MS);
    expect(await decisions.updateIfVersion(STATE_KEY, 1, { status: 'closed' }, TRACER_NOW_MS, { incidentId: 'second' })).toBe('conflict');
    expect(await decisions.updateIfVersion(STATE_KEY, 1, { status: 'closed' }, TRACER_NOW_MS, { note: 'first' })).toBe('conflict');
    expect(await decisions.getItem(STATE_KEY, TRACER_NOW_MS)).toMatchObject({ version: 1, status: 'open' });
    expect(await decisions.updateIfVersion(STATE_KEY, 1, { status: 'closed' }, TRACER_NOW_MS, { incidentId: 'first' })).toBe('updated');
    expect(await decisions.getItem(STATE_KEY, TRACER_NOW_MS)).toMatchObject({ version: 2, status: 'closed', incidentId: 'first' });
  });

  it('refuses an update naming an attribute it writes itself, and any put or update of a counter item', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1 }, TRACER_NOW_MS);
    for (const attribute of ['pk', 'sk', 'version', 'expiresAt']) {
      await expect(decisions.updateIfVersion(STATE_KEY, 1, { [attribute]: 0 }, TRACER_NOW_MS)).rejects.toThrow(RangeError);
    }
    await expect(decisions.updateIfVersion(STATE_KEY, 1.5, {}, TRACER_NOW_MS)).rejects.toThrow(RangeError);
    await expect(decisions.putIfAbsent({ ...DAY_COUNTER, expiresAt: NOW_SECONDS + 60, invocations: -5 }, TRACER_NOW_MS)).rejects.toThrow(RangeError);
    await expect(decisions.updateIfVersion(INCIDENT_COUNTER, 0, { invocations: 0 }, TRACER_NOW_MS)).rejects.toThrow(RangeError);
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toBeUndefined();
    expect((await decisions.getItem(STATE_KEY, TRACER_NOW_MS))?.version).toBe(1);
  });
});

describe('the fixture decision store reserves both counters all or nothing (D-67)', () => {
  it('creates the day counter at one invocation on the first reservation of a UTC day (AC-E46)', async () => {
    const decisions = createFixtureDecisionStore();
    expect(await decisions.reserveInvocation(reservation())).toEqual({ ok: true });
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toEqual({
      ...DAY_COUNTER,
      invocations: 1,
      tokenReservations: 100,
      expiresAt: NOW_SECONDS + RETENTION_SECONDS,
    });
    expect((await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS))?.invocations).toBe(1);
  });

  it('keeps the expiresAt of the first reservation, so a later one never extends a counter', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.reserveInvocation(reservation());
    await decisions.reserveInvocation(reservation({ expiresAt: NOW_SECONDS + 2 * RETENTION_SECONDS }));
    expect((await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS))?.expiresAt).toBe(NOW_SECONDS + RETENTION_SECONDS);
    expect((await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS))?.expiresAt).toBe(NOW_SECONDS + RETENTION_SECONDS);
  });

  it('allows one reservation one below the incident cap and refuses at the cap, naming the incident (AC-E48)', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.reserveInvocation(reservation());
    await decisions.reserveInvocation(reservation());
    expect((await decisions.reserveInvocation(reservation())).ok).toBe(true);
    expect(await decisions.reserveInvocation(reservation())).toEqual({ ok: false, reason: 'cap', items: ['incident'] });
    expect((await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS))?.invocations).toBe(3);
    expect((await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS))?.invocations).toBe(3);
  });

  it('refuses the day when its invocations or its token reservations are at their cap (AC-E48)', async () => {
    const byInvocations = createFixtureDecisionStore();
    await byInvocations.reserveInvocation(reservation({ dayInvocationCap: 1 }));
    const second = reservation({ incidentKey: incidentItemKey('5'.repeat(32), 'COUNTER'), dayInvocationCap: 1 });
    expect(await byInvocations.reserveInvocation(second)).toEqual({ ok: false, reason: 'cap', items: ['day'] });

    const byTokens = createFixtureDecisionStore();
    const tokens = { incidentCap: 10, dayTokenCap: 1_000, tokenReservation: 400 };
    expect((await byTokens.reserveInvocation(reservation(tokens))).ok).toBe(true);
    expect((await byTokens.reserveInvocation(reservation(tokens))).ok).toBe(true);
    expect(await byTokens.reserveInvocation(reservation(tokens))).toEqual({ ok: false, reason: 'cap', items: ['day'] });
    expect((await byTokens.getItem(DAY_COUNTER, TRACER_NOW_MS))?.tokenReservations).toBe(800);
  });

  it('lets exactly one of ten racing reservations through at one below the incident cap (AC-E49)', async () => {
    const decisions = createFixtureDecisionStore({}, createDryRunLog({ sink: () => {}, addressKey: createFixtureAddressKey(), now: () => TRACER_NOW_MS }));
    await decisions.reserveInvocation(reservation());
    await decisions.reserveInvocation(reservation());
    const results = await Promise.all(Array.from({ length: 10 }, () => decisions.reserveInvocation(reservation())));
    expect(results.filter((result) => result.ok).length).toBe(1);
    expect((await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS))?.invocations).toBe(3);
  });

  it('refuses once, naming both items, a reservation past the incident cap and the day cap together (AC-E45)', async () => {
    const decisions = createFixtureDecisionStore();
    const tight = reservation({ incidentCap: 1, dayInvocationCap: 1 });
    await decisions.reserveInvocation(tight);
    expect(await decisions.reserveInvocation(tight)).toEqual({ ok: false, reason: 'cap', items: ['incident', 'day'] });
    expect((await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS))?.invocations).toBe(1);
  });

  it('answers conflict for each injected transaction conflict, changing nothing, and then reserves (Pitfall 6)', async () => {
    const decisions = createFixtureDecisionStore({ transactionConflicts: 2 });
    expect(await decisions.reserveInvocation(reservation())).toEqual({ ok: false, reason: 'conflict' });
    expect(await decisions.reserveInvocation(reservation())).toEqual({ ok: false, reason: 'conflict' });
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toBeUndefined();
    expect(await decisions.reserveInvocation(reservation())).toEqual({ ok: true });
    expect((await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS))?.invocations).toBe(1);
  });

  it('refuses a reservation whose caps are not whole numbers or whose token reservation exceeds the day cap', async () => {
    const decisions = createFixtureDecisionStore();
    for (const overrides of [{ incidentCap: 0 }, { dayInvocationCap: 1.5 }, { tokenReservation: -1 }, { tokenReservation: 1_001 }, { dayKey: STATE_KEY }]) {
      await expect(decisions.reserveInvocation(reservation(overrides))).rejects.toThrow(RangeError);
    }
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toBeUndefined();
  });
});

describe('the fixture decision store records usage by adding only (AC-P6 store half)', () => {
  it('adds each amount to both counter items, call after call', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.reserveInvocation(reservation());
    expect(await decisions.recordUsage(usage())).toBe('recorded');
    expect(await decisions.recordUsage(usage({ inputTokens: 300, outputTokens: 20, modelCalls: 1 }))).toBe('recorded');
    for (const key of [INCIDENT_COUNTER, DAY_COUNTER]) {
      expect(await decisions.getItem(key, TRACER_NOW_MS)).toMatchObject({ inputTokens: 1_500, outputTokens: 100, modelCalls: 3, invocations: 1 });
    }
  });

  // A counter item made by usage alone would carry no expiresAt and outlive the 30-day retention.
  it('answers not-reserved and writes nothing for usage on counters no reservation created', async () => {
    const decisions = createFixtureDecisionStore();
    expect(await decisions.recordUsage(usage())).toBe('not-reserved');
    expect(await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS)).toBeUndefined();
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toBeUndefined();
  });

  it('answers not-reserved and leaves the reserved counter unchanged when only one of the two exists', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.reserveInvocation(reservation({ incidentKey: incidentItemKey('6'.repeat(32), 'COUNTER') }));
    const before = await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS);
    expect(await decisions.recordUsage(usage())).toBe('not-reserved');
    expect(await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS)).toEqual(before);
    expect(await decisions.getItem(INCIDENT_COUNTER, TRACER_NOW_MS)).toBeUndefined();
  });

  it('throws a RangeError for a negative or fractional amount before anything is written', async () => {
    const decisions = createFixtureDecisionStore();
    await decisions.reserveInvocation(reservation());
    for (const overrides of [{ inputTokens: -1 }, { outputTokens: 0.5 }, { modelCalls: Number.NaN }]) {
      await expect(decisions.recordUsage(usage(overrides))).rejects.toThrow(RangeError);
    }
    expect((await decisions.getItem(DAY_COUNTER, TRACER_NOW_MS))?.inputTokens).toBeUndefined();
  });
});

const LANE_ATTEMPT: LaneAttemptRequest = {
  key: { pk: 'COUNTER_LANE_HOUR#fothering-bulk#2026-10-11T12', sk: 'COUNTER' },
  cap: 4,
  expiresAt: NOW_SECONDS + RETENTION_SECONDS,
};

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

// Pitfall 9: the yield sits before an operation's check, never between its check and its set, so it
// makes separately built roots interleave without inventing a race DynamoDB's conditional write lacks.
describe('the fixture stores can yield between operations, off by default (AC-9, AC-10)', () => {
  it.each([
    [false, ['get', 'put', 'microtasks drained']],
    [true, ['microtasks drained', 'get', 'put']],
  ] as const)('with yieldBetweenOperations %s, a getItem and a putIfAbsent issued together settle in the order %j', async (yieldBetweenOperations, order) => {
    const decisions = createFixtureDecisionStore({ yieldBetweenOperations });
    const settled: string[] = [];
    const read = decisions.getItem(STATE_KEY, TRACER_NOW_MS).then(() => settled.push('get'));
    const put = decisions.putIfAbsent({ ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1 }, TRACER_NOW_MS).then(() => settled.push('put'));
    await drainMicrotasks();
    settled.push('microtasks drained');
    await Promise.all([read, put]);
    expect(settled).toEqual(order);
  });

  it('yields before an event store operation too', async () => {
    const events = createFixtureEventStore({ yieldBetweenOperations: true });
    let read = false;
    const query = events.queryByRecipient('0'.repeat(64)).then(() => {
      read = true;
    });
    await drainMicrotasks();
    expect(read).toBe(false);
    await query;
    expect(read).toBe(true);
  });

  it('still answers one written and one duplicate for two puts of one key under Promise.all', async () => {
    const decisions = createFixtureDecisionStore({ yieldBetweenOperations: true });
    const item = { ...STATE_KEY, expiresAt: NOW_SECONDS + 60, version: 1 };
    const results = await Promise.all([decisions.putIfAbsent(item, TRACER_NOW_MS), decisions.putIfAbsent(item, TRACER_NOW_MS)]);
    expect([...results].sort()).toEqual(['duplicate', 'written']);
  });

  it('answers reserved for four lane attempts on one key and cap for the fifth (AC-10, store half)', async () => {
    const decisions = createFixtureDecisionStore({ yieldBetweenOperations: true });
    const answers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) answers.push(await decisions.reserveLaneAttempt(LANE_ATTEMPT));
    expect(answers).toEqual(['reserved', 'reserved', 'reserved', 'reserved', 'cap']);
    expect(await decisions.getItem(LANE_ATTEMPT.key, TRACER_NOW_MS)).toEqual({ ...LANE_ATTEMPT.key, attempts: 4, expiresAt: LANE_ATTEMPT.expiresAt });
  });

  it('lets exactly four of ten racing lane attempts through two stores built over one table (AC-10, store half)', async () => {
    const table = createFixtureTableState();
    const stores = [createFixtureDecisionStore({ store: table, yieldBetweenOperations: true }), createFixtureDecisionStore({ store: table, yieldBetweenOperations: true })];
    const answers = await Promise.all(Array.from({ length: 10 }, (_, index) => stores[index % 2]?.reserveLaneAttempt(LANE_ATTEMPT)));
    expect(answers.filter((answer) => answer === 'reserved')).toHaveLength(4);
    expect((await stores[0]?.getItem(LANE_ATTEMPT.key, TRACER_NOW_MS))?.attempts).toBe(4);
  });
});
