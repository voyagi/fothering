import { describe, expect, it } from 'vitest';
import { bucketStartMs, countLaneBuckets, countRecords } from '@fothering/core/buckets';
import { parseSesEvent } from '@fothering/core/ses-events';
import { createLogger, type LogEntry } from '@fothering/core/log';
import { parseLaneMap } from '@fothering/core/lanes';
import { NoActiveKeyVersionError, type AddressKeySet } from '@fothering/core/address';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture } from '@fothering/providers/fixtures/ses-events/index';
import {
  createFixtureAddressKey,
  createFixtureDeadLetter,
  createFixtureEventStore,
  FixtureWriteError,
  type FixtureDeadLetterPort,
} from '@fothering/providers/fixtures/ingest-ports';
import { PORT_TABLE, resolvePortTable, type PortName, type PortRow } from '@fothering/providers/ports';
import { NotBuiltError, type EventStorePort } from '@fothering/providers/port-types';
import { buildIngestRoot, type IngestDeps } from './root.js';
import { ingestEvent, type IngestResult } from './ingest.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const BOUNCE_MESSAGE_ID = 'EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000';

function fixtureConfigurationSet(): string {
  const parsed = parseSesEvent(loadSesEventFixture('bounce').event);
  if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
  const configurationSet = parsed.event.detail.mail.tags['ses:configuration-set']?.[0];
  if (configurationSet === undefined) throw new Error('fixture bounce event carries no configuration-set tag');
  return configurationSet;
}

function fixtureMailTimestampMs(): number {
  const parsed = parseSesEvent(loadSesEventFixture('bounce').event);
  if (!parsed.ok) throw new Error('fixture bounce event failed to parse');
  return Date.parse(parsed.event.detail.mail.timestamp);
}

describe('the doc-derived Bounce through the ingest composition root', () => {
  it('stores the Bounce once and counts it in its send-time bucket', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps: IngestDeps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });

    const result: IngestResult = await ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' });
    expect(result).toEqual({ outcome: 'stored', stored: 1, duplicates: 0 });

    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const stored = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, deps.now());
    expect(countRecords(stored).Bounce).toBe(1);
    // the doc fixture's own bounceType is Permanent, so plan 01-12's finer per-bucket shape
    // reads the same one bounce as permanentBounce, not just the flat per-type count above
    const [bucketCount] = countLaneBuckets(stored, { fromBucketMs: bucket, toBucketMs: bucket, nowMs: deps.now() });
    expect(bucketCount?.permanentBounce).toBe(1);
  });

  it('absorbs a second delivery of the same envelope as a duplicate', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });
    const event = loadSesEventFixture('bounce').event;

    await ingestEvent(event, deps, { provenance: 'doc-derived' });
    const second = await ingestEvent(event, deps, { provenance: 'doc-derived' });
    expect(second).toEqual({ outcome: 'stored', stored: 0, duplicates: 1 });

    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const stored = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, deps.now());
    expect(stored).toHaveLength(1);
  });

  it('drops an event with no configuration-set tag and logs its message id only', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const raw = structuredClone(loadSesEventFixture('bounce').event) as {
      detail: { mail: { tags: Record<string, string[]> } };
    };
    delete raw.detail.mail.tags['ses:configuration-set'];
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent(raw, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'dropped-no-configuration-set', level: 'info' });
  });

  it('drops an event whose configuration set is not in the lane map and logs its message id only', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const raw = structuredClone(loadSesEventFixture('bounce').event) as {
      detail: { mail: { tags: Record<string, string[]> } };
    };
    raw.detail.mail.tags['ses:configuration-set'] = ['NotInTheLaneMap'];
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent(raw, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'dropped-unmapped', level: 'info' });
  });

  it('drops a Send with an empty destination list and logs its message id only (AC-E15)', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const raw = structuredClone(loadSesEventFixture('send').event) as {
      detail: { mail: { messageId: string; destination: string[] } };
    };
    raw.detail.mail.destination = [];
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent(raw, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'dropped-empty-destination', level: 'info', messageId: raw.detail.mail.messageId });
  });

  it('does not match bulk-2 or Bulk against a bulk lane entry, and writes nothing (AC-E14)', async () => {
    const baseLane = DOC_EXAMPLE_LANE_MAP.lanes[0];
    if (baseLane === undefined) throw new Error('expected at least one lane in DOC_EXAMPLE_LANE_MAP');
    const laneMap = parseLaneMap({
      runIdTagKey: DOC_EXAMPLE_LANE_MAP.runIdTagKey,
      lanes: [{ ...baseLane, configurationSet: 'bulk', lane: 'bulk' }],
    });
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap });
    for (const configurationSet of ['bulk-2', 'Bulk']) {
      const raw = structuredClone(loadSesEventFixture('bounce').event) as {
        detail: { mail: { tags: Record<string, string[]> } };
      };
      raw.detail.mail.tags['ses:configuration-set'] = [configurationSet];
      const result = await ingestEvent(raw, deps, { provenance: 'doc-derived' });
      expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    }
  });

  // A key set with no version active at the send time is a key configuration gap (a pruned or
  // future-dated first version), not a bad event, so it takes the unreadable key set's path: logged
  // and rethrown for the asynchronous retry, never dropped and never written.
  it('rethrows when the address key set has no version active at the send time, logging key-version-missing and writing nothing', async () => {
    const base = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const futureKeySet: AddressKeySet = { versions: [{ id: 'k1', secret: 'x', activeFromMs: Number.MAX_SAFE_INTEGER }] };
    const lines: string[] = [];
    const deps: IngestDeps = {
      ...base,
      ports: { ...base.ports, addressKey: { getKeySet: async () => futureKeySet } },
      log: createLogger((line) => lines.push(line)),
    };

    await expect(ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' })).rejects.toThrow(
      NoActiveKeyVersionError,
    );
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'key-version-missing', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'NoActiveKeyVersionError' },
    ]);
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    await expect(deps.ports.eventStore.queryLane(fixtureConfigurationSet(), bucket, bucket, bucket)).resolves.toEqual([]);
  });

  // Only an event whose send time has no storable bucket is dropped. Any other minimize failure
  // (unusable key material, a crypto fault, a code defect) is not the event's own fault, so it is
  // logged by name and rethrown for the retry, never dropped as if the event were bad.
  it('rethrows a minimize failure that is not the event’s own fault, logging minimize-failed and writing nothing', async () => {
    const base = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    // A secret that is not a string makes the HMAC itself throw a TypeError.
    const unusableKeySet = { versions: [{ id: 'k1', secret: 42, activeFromMs: 0 }] } as unknown as AddressKeySet;
    const lines: string[] = [];
    const deps: IngestDeps = {
      ...base,
      ports: { ...base.ports, addressKey: { getKeySet: async () => unusableKeySet } },
      log: createLogger((line) => lines.push(line)),
    };

    await expect(ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' })).rejects.toThrow(TypeError);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'minimize-failed', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'TypeError' },
    ]);
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    await expect(deps.ports.eventStore.queryLane(fixtureConfigurationSet(), bucket, bucket, bucket)).resolves.toEqual([]);
  });

  it('sends every minimized record to the dead-letter port, logs the write error by name, and resolves dead-lettered when a put fails', async () => {
    const base = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      fixtures: { eventStoreFailure: 'put' },
    });
    const lines: string[] = [];
    const deps: IngestDeps = { ...base, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dead-lettered', stored: 0, duplicates: 0 });
    const deadLetter = deps.ports.deadLetter as FixtureDeadLetterPort;
    expect(deadLetter.sent).toHaveLength(1);
    expect(deadLetter.sent[0]).toHaveLength(1);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'dead-lettered', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'FixtureWriteError' },
    ]);
  });

  // The dead-letter-failed line names the send error; without a line of its own the write error that
  // started it all would reach no reader. The send error gets its own name here so the test can tell
  // which error each line names.
  it('rethrows when the dead-letter send itself fails, logging the write error and then the send error by name, so the caller’s retry can rerun the whole event', async () => {
    class DeadLetterSendError extends Error {
      override name = 'DeadLetterSendError';
    }
    const base = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      fixtures: { eventStoreFailure: 'put' },
    });
    const lines: string[] = [];
    const deps: IngestDeps = {
      ...base,
      ports: { ...base.ports, deadLetter: { send: async () => Promise.reject(new DeadLetterSendError('queue unreachable')) } },
      log: createLogger((line) => lines.push(line)),
    };

    await expect(ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' })).rejects.toThrow(
      DeadLetterSendError,
    );
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'put-failed', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'FixtureWriteError' },
      { event: 'dead-letter-failed', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'DeadLetterSendError' },
    ]);
  });

  // A put that fails partway leaves the records before it written. The dead letter still carries
  // every record of the event, so a replay re-puts them all and the conditional puts absorb the
  // ones already stored.
  it('dead-letters every record of the event, the already-written one included, when a later put fails', async () => {
    const base = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    let puts = 0;
    const eventStore: EventStorePort = {
      ...base.ports.eventStore,
      putIfAbsent: async (record) => {
        puts += 1;
        if (puts === 2) throw new FixtureWriteError('the second put fails');
        return base.ports.eventStore.putIfAbsent(record);
      },
    };
    const lines: string[] = [];
    const deps: IngestDeps = { ...base, ports: { ...base.ports, eventStore }, log: createLogger((line) => lines.push(line)) };
    const raw = structuredClone(loadSesEventFixture('send').event) as { detail: { mail: { messageId: string; destination: string[] } } };
    raw.detail.mail.destination = ['first@example.com', 'second@example.org', 'third@example.net'];

    const result = await ingestEvent(raw, deps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dead-lettered', stored: 1, duplicates: 0 });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'dead-lettered', level: 'error', messageId: raw.detail.mail.messageId, errorName: 'FixtureWriteError' },
    ]);
    const deadLetter = deps.ports.deadLetter as FixtureDeadLetterPort;
    const [queued] = deadLetter.sent;
    if (queued === undefined) throw new Error('expected one dead-letter message');
    expect(queued).toHaveLength(3);
    const replayed: string[] = [];
    for (const record of queued) replayed.push(await base.ports.eventStore.putIfAbsent(record));
    expect(replayed).toEqual(['duplicate', 'written', 'written']);
  });

  // The sort key holds 13 digits of epoch milliseconds, which ends in November 2286: a later mail
  // timestamp has no key that sorts by time, so the event is dropped as unminimizable under the one
  // error name ingest drops, never written under a wrongly ordered key. The control just inside the
  // limit is stored.
  it('drops an event whose mail timestamp lies past the sort key range, logging UnstorableEventError, and stores one just inside it', async () => {
    const insideLimit = '2286-11-20T00:00:00Z';
    const pastLimit = '2287-01-01T00:00:00Z';
    expect(Date.parse(insideLimit)).toBeLessThan(10 ** 13);
    expect(Date.parse(pastLimit)).toBeGreaterThanOrEqual(10 ** 13);

    const base = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const lines: string[] = [];
    const deps: IngestDeps = { ...base, log: createLogger((line) => lines.push(line)) };
    const withTimestamp = (timestamp: string) => {
      const raw = structuredClone(loadSesEventFixture('bounce').event) as { detail: { mail: { timestamp: string } } };
      raw.detail.mail.timestamp = timestamp;
      return raw;
    };

    expect(await ingestEvent(withTimestamp(pastLimit), deps, { provenance: 'doc-derived' })).toEqual({
      outcome: 'dropped',
      stored: 0,
      duplicates: 0,
    });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      event: 'dropped-unminimizable',
      level: 'error',
      messageId: BOUNCE_MESSAGE_ID,
      errorName: 'UnstorableEventError',
    });
    expect(await ingestEvent(withTimestamp(insideLimit), deps, { provenance: 'doc-derived' })).toEqual({
      outcome: 'stored',
      stored: 1,
      duplicates: 0,
    });
  });

  // A Complaint's counting record stands for the complaint itself, not for a recipient, so a
  // complaint that names no recipient still counts once (plan 01-04 required a non-empty list only
  // where an empty one would minimize to no record at all).
  it('counts a Complaint that lists no recipient as one complaint, with no recipient item', async () => {
    const parsedFixture = parseSesEvent(loadSesEventFixture('complaint').event);
    if (!parsedFixture.ok) throw new Error('fixture complaint event failed to parse');
    const mailTimestampMs = Date.parse(parsedFixture.event.detail.mail.timestamp);
    const nowMs = mailTimestampMs + ONE_HOUR_MS;
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP, now: () => nowMs });
    const raw = structuredClone(loadSesEventFixture('complaint').event) as { detail: { complaint: { complainedRecipients: unknown[] } } };
    raw.detail.complaint.complainedRecipients = [];

    expect(await ingestEvent(raw, deps, { provenance: 'doc-derived' })).toEqual({ outcome: 'stored', stored: 1, duplicates: 0 });

    const bucket = bucketStartMs(mailTimestampMs);
    const stored = await deps.ports.eventStore.queryLane(fixtureConfigurationSet(), bucket, bucket, nowMs);
    expect(stored.map((record) => record.kind)).toEqual(['complaint']);
    expect(stored[0]?.recipientCount).toBe(0);
    const [bucketCount] = countLaneBuckets(stored, { fromBucketMs: bucket, toBucketMs: bucket, nowMs });
    expect(bucketCount?.complaint).toBe(1);
  });

  it('rethrows when the address key set cannot be read, logging the error by name, so the caller’s retry can rerun the event', async () => {
    class KeyStoreError extends Error {
      override name = 'KeyStoreError';
    }
    const base = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const lines: string[] = [];
    const deps: IngestDeps = {
      ...base,
      ports: { ...base.ports, addressKey: { getKeySet: async () => Promise.reject(new KeyStoreError('secret unreadable')) } },
      log: createLogger((line) => lines.push(line)),
    };

    await expect(ingestEvent(loadSesEventFixture('bounce').event, deps, { provenance: 'doc-derived' })).rejects.toThrow(KeyStoreError);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'key-set-unavailable', level: 'error', messageId: BOUNCE_MESSAGE_ID, errorName: 'KeyStoreError' },
    ]);
  });

  it('leaves one item and a count of one when two ingestEvent calls for the same event run under Promise.all (AC-E22)', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });
    const event = loadSesEventFixture('bounce').event;

    const [first, second] = await Promise.all([
      ingestEvent(event, deps, { provenance: 'doc-derived' }),
      ingestEvent(event, deps, { provenance: 'doc-derived' }),
    ]);

    expect(first.stored + second.stored).toBe(1);
    expect(first.duplicates + second.duplicates).toBe(1);
    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const stored = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, nowMs);
    expect(stored).toHaveLength(1);
  });

  it('keeps the first write when a re-delivered Bounce carries the same feedbackId and recipient but a changed diagnosticCode (AC-E19)', async () => {
    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;
    const deps = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      now: () => nowMs,
    });
    const first = structuredClone(loadSesEventFixture('bounce').event) as {
      detail: { bounce: { bouncedRecipients: { diagnosticCode?: string }[] } };
    };
    await ingestEvent(first, deps, { provenance: 'doc-derived' });

    const redelivered = structuredClone(first);
    const recipient = redelivered.detail.bounce.bouncedRecipients[0];
    if (recipient === undefined) throw new Error('expected a recipient');
    recipient.diagnosticCode = 'smtp; 421 4.4.1 different diagnostic text';
    const second = await ingestEvent(redelivered, deps, { provenance: 'doc-derived' });
    expect(second).toEqual({ outcome: 'stored', stored: 0, duplicates: 1 });

    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const [stored] = await deps.ports.eventStore.queryLane(configurationSet, bucket, bucket, nowMs);
    if (stored === undefined) throw new Error('expected the record to remain stored');
    expect(stored.fields.basicReplyCode).toBe('550');
  });

  it('finds a planted address in the raw event and nowhere in stored items, dead-letter payloads or log lines (AC-12, AC-P3)', async () => {
    const idnLabel = String.fromCodePoint(0x62, 0xfc, 0x63, 0x68, 0x65, 0x72); // b, U+00FC, cher
    const address = `Jane+Tag@${idnLabel}.Example`;
    const lowerAddress = address.toLowerCase();

    function buildRaw() {
      const raw = structuredClone(loadSesEventFixture('bounce').event) as {
        detail: {
          mail: {
            source: string;
            destination: string[];
            headers: { name: string; value: string }[];
            commonHeaders: { from: string[]; to: string[] };
            tags: Record<string, string[]>;
          };
          bounce: { bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[] };
        };
      };
      raw.detail.mail.source = `Sender <${address}>`;
      raw.detail.mail.destination = [address];
      raw.detail.mail.commonHeaders.from = [address];
      raw.detail.mail.commonHeaders.to = [address];
      for (const header of raw.detail.mail.headers) header.value = address;
      raw.detail.mail.tags.myCustomTag1 = [address];
      const recipient = raw.detail.bounce.bouncedRecipients[0];
      if (recipient === undefined) throw new Error('fixture bounce has no recipient');
      recipient.emailAddress = address;
      recipient.diagnosticCode = `smtp; 550 5.1.1 ${address} is unknown`;
      return raw;
    }

    expect(JSON.stringify(buildRaw())).toContain(address);

    const nowMs = fixtureMailTimestampMs() + ONE_HOUR_MS;

    const cleanRoot = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP, now: () => nowMs });
    const cleanLines: string[] = [];
    const cleanDeps: IngestDeps = { ...cleanRoot, log: createLogger((line) => cleanLines.push(line)) };
    const storedResult = await ingestEvent(buildRaw(), cleanDeps, { provenance: 'doc-derived' });
    expect(storedResult.outcome).toBe('stored');
    const configurationSet = fixtureConfigurationSet();
    const bucket = bucketStartMs(fixtureMailTimestampMs());
    const storedRecords = await cleanDeps.ports.eventStore.queryLane(configurationSet, bucket, bucket, nowMs);
    const serializedStored = JSON.stringify(storedRecords);

    const failingRoot = buildIngestRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      laneMap: DOC_EXAMPLE_LANE_MAP,
      fixtures: { eventStoreFailure: 'put' },
      now: () => nowMs,
    });
    const failingLines: string[] = [];
    const failingDeps: IngestDeps = { ...failingRoot, log: createLogger((line) => failingLines.push(line)) };
    const deadResult = await ingestEvent(buildRaw(), failingDeps, { provenance: 'doc-derived' });
    expect(deadResult.outcome).toBe('dead-lettered');
    const deadLetter = failingRoot.ports.deadLetter as FixtureDeadLetterPort;
    const serializedDeadLetter = JSON.stringify(deadLetter.sent);

    const serializedLogs = [...cleanLines, ...failingLines].join('\n');

    for (const needle of [address, lowerAddress]) {
      expect(serializedStored.toLowerCase()).not.toContain(needle.toLowerCase());
      expect(serializedDeadLetter.toLowerCase()).not.toContain(needle.toLowerCase());
      expect(serializedLogs.toLowerCase()).not.toContain(needle.toLowerCase());
    }
    expect(serializedStored).not.toContain('is unknown');
    expect(serializedDeadLetter).not.toContain('is unknown');
  });

  // The rule forwards only the six SES event types from mapped sets, so an event that fails to parse
  // is a lost SES event, not a routine drop: it is logged at error, where a reader filtering on
  // level sees an SES format change that fails every event.
  it('drops an unparseable event and logs it dropped-unparseable at error, keeping only a readable message id', async () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP });
    const lines: string[] = [];
    const loggedDeps: IngestDeps = { ...deps, log: createLogger((line) => lines.push(line)) };

    const result = await ingestEvent({ detail: { mail: { messageId: 'm-1' } } }, loggedDeps, { provenance: 'doc-derived' });

    expect(result).toEqual({ outcome: 'dropped', stored: 0, duplicates: 0 });
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'dropped-unparseable', level: 'error', messageId: 'm-1' });
  });
});

describe('resolvePortTable in runtimeContext test', () => {
  it.each([undefined, '', 'true', 'LIVE', ' live', 'live'])(
    'resolves every port operation to fixture for switch %j',
    (switchValue) => {
      const { kinds } = resolvePortTable({ runtimeContext: 'test', switchValue });
      // A named operation first, so an empty kind table cannot pass the loop below by having no rows.
      expect(kinds.eventStore?.putIfAbsent).toBe('fixture');
      for (const row of Object.values(kinds)) {
        for (const kind of Object.values(row)) {
          expect(kind).toBe('fixture');
        }
      }
    },
  );
});

describe('resolvePortTable in runtimeContext deployed with a not-built table', () => {
  // The three product rows are planted not built; the four later rows stay the real ones and are
  // proven by the root matrix, so only the planted three are read below.
  function plantedNotBuiltTable(): Record<PortName, PortRow> {
    return {
      ...PORT_TABLE,
      eventStore: {
        operations: ['putIfAbsent', 'queryLane', 'queryByRecipient', 'deleteRecord', 'getRecord'],
        mutatingOperations: ['putIfAbsent', 'deleteRecord'],
        gatedOperations: [],
        fixture: () => createFixtureEventStore(),
        live: { notBuiltUntil: 1 },
      },
      addressKey: {
        operations: ['getKeySet'],
        mutatingOperations: [],
        gatedOperations: [],
        fixture: () => createFixtureAddressKey(),
        live: { notBuiltUntil: 1 },
      },
      deadLetter: {
        operations: ['send'],
        mutatingOperations: ['send'],
        gatedOperations: [],
        fixture: () => createFixtureDeadLetter(),
        live: { notBuiltUntil: 1 },
      },
    };
  }

  it('reports not-built-until-phase-1 for every operation and rejects with a named NotBuiltError', async () => {
    const { ports, kinds } = resolvePortTable({
      runtimeContext: 'deployed',
      switchValue: undefined,
      table: plantedNotBuiltTable(),
    });
    for (const portName of ['eventStore', 'addressKey', 'deadLetter'] as const) {
      for (const kind of Object.values(kinds[portName] ?? {})) {
        expect(kind).toBe('not-built-until-phase-1');
      }
    }
    await expect(ports.eventStore.putIfAbsent({} as never)).rejects.toThrow(NotBuiltError);
    await expect(ports.eventStore.putIfAbsent({} as never)).rejects.toThrow('phase 1');
  });
});

describe('buildIngestRoot laneMap defaults', () => {
  it('defaults to the committed lanes.json when no laneMap is given in test', () => {
    const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined });
    expect(deps.laneMap.lanes.map((entry) => entry.lane).sort()).toEqual([
      'fothering-alerts',
      'fothering-bulk',
      'fothering-transactional',
    ]);
  });

  it('refuses a laneMap override outside runtimeContext test', () => {
    expect(() =>
      buildIngestRoot({ runtimeContext: 'deployed', switchValue: undefined, laneMap: DOC_EXAMPLE_LANE_MAP }),
    ).toThrow('runtimeContext test');
  });
});

describe('the port table type contract', () => {
  it('names the nine ports', () => {
    expect(Object.keys(PORT_TABLE).sort()).toEqual([
      'addressKey',
      'agentCore',
      'bedrockModel',
      'deadLetter',
      'decisionStore',
      'dns',
      'eventStore',
      'replyBucket',
      'ses',
    ]);
  });

  it('is exactly Record<PortName, PortRow>, so a table missing a row is a type error', () => {
    // @ts-expect-error a table missing the deadLetter row must fail gate:types
    const missingRow: Record<PortName, PortRow> = {
      eventStore: PORT_TABLE.eventStore,
      addressKey: PORT_TABLE.addressKey,
    };
    expect(Object.keys(missingRow).sort()).toEqual(['addressKey', 'eventStore']);
  });
});

describe('createLogger keeps free text out of every line', () => {
  it('drops any key outside the allowed set and downgrades an invalid value to unclassified', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const hostileEntry = {
      event: 'dropped-unparseable',
      level: 'a caller-supplied sentence',
      messageId: 'jane@example.com',
      errorName: 'a full sentence is not a name',
      field: 'a field with spaces in it',
      count: -1,
      recipient: 'jane@example.com',
    } as unknown as LogEntry;

    logger.info(hostileEntry);

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      event: 'dropped-unparseable',
      level: 'info',
      messageId: 'unclassified',
      errorName: 'unclassified',
      field: 'unclassified',
    });
  });

  // The level comes from the method called, never from the entry, so a reader can tell a failure
  // from a routine drop without knowing every event name.
  it('writes the same entry through info and error as two lines that differ only by level', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const entry: LogEntry = { event: 'dead-lettered', messageId: 'abc-123', errorName: 'TypeError' };

    logger.info(entry);
    logger.error(entry);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { ...entry, level: 'info' },
      { ...entry, level: 'error' },
    ]);
  });

  // The log line is the one trace a failed message leaves, so the logger keeps every id the event
  // parser accepts and stores; a narrower copy of the pattern logged some as unclassified.
  it.each([['a dot and an underscore', 'id.with_parts-1'], ['256 characters', 'a'.repeat(256)]])(
    'keeps a messageId the event parser accepts, with %s',
    (_label, messageId) => {
      const lines: string[] = [];
      createLogger((line) => lines.push(line)).error({ event: 'dead-letter-failed', messageId });
      expect(JSON.parse(lines[0] ?? '{}')).toEqual({ event: 'dead-letter-failed', level: 'error', messageId });
    },
  );

  it('keeps a valid messageId, errorName, field and count as given', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.error({ event: 'ingest-failure', messageId: 'abc-123', errorName: 'TypeError', field: 'detail.mail.tags', count: 3 });

    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      event: 'ingest-failure',
      level: 'error',
      messageId: 'abc-123',
      errorName: 'TypeError',
      field: 'detail.mail.tags',
      count: 3,
    });
  });
});
