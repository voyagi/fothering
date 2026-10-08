import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { bucketStartMs, countLaneBuckets, hardBounceRatio } from '@fothering/core/buckets';
import { REQUIRED_EVENT_TYPES, checkCloseability, observeLanes, type SesConfigurationFacts } from '@fothering/core/closeability';
import { validHostname, validIp } from '@fothering/core/extract';
import { identityFor, type IdentityInput } from '@fothering/core/identity';
import { parseLaneMap } from '@fothering/core/lanes';
import { expiresAtFor, recordKey, type EventRecord } from '@fothering/core/records';
import { createFixtureEventStore } from '../ingest-ports.js';
import { SIMULATOR_SCENARIOS, loadSimulatorRecordFixture } from './index.js';
import lanesJson from '../../../../../lanes.json' with { type: 'json' };

const LANE_MAP = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const TRANSACTIONAL = 'fothering-transactional';
const SENDER_DOMAIN_PLACEHOLDER = 'example.com';
const SOURCE_IP_PLACEHOLDER = '192.0.2.1';
const FIXTURE_TEXT = readFileSync(new URL('./simulator-sends.json', import.meta.url), 'utf8');

// RFC 5737 sets these three /24 blocks aside for documentation, so no real host answers on them.
const DOCUMENTATION_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];
// The receiving and sending mail servers SES reported: AWS's own hosts, kept as captured.
const AWS_SERVER_IP_FIELDS = ['remoteMtaIp', 'outgoingIp'] as const;

function isDocumentationIpv4(value: string): boolean {
  return isIP(value) === 4 && DOCUMENTATION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// The two values a capture replaces before it is committed: the sending identity's domain and the
// address the SendEmail calls came from. Only the placeholders pass, so any real value fails
// without this file naming one, and no message repeats the value it found.
function capturedSenderValues(records: readonly EventRecord[]): string[] {
  const problems: string[] = [];
  for (const [index, record] of records.entries()) {
    if (record.fields.fromDomain !== SENDER_DOMAIN_PLACEHOLDER) {
      problems.push(`record ${index}: fromDomain is not the placeholder`);
    }
    const sourceIp = record.fields.sourceIp;
    if (sourceIp === undefined || !isDocumentationIpv4(sourceIp)) {
      problems.push(`record ${index}: sourceIp is not a documentation address`);
    }
  }
  return problems;
}

// The whole file, not just the two fields: an address or an account id moved anywhere else (a
// tag value, the source note) fails here too.
function strayIdentifiers(text: string, records: readonly EventRecord[]): string[] {
  const awsServerIps = new Set<string>();
  for (const record of records) {
    for (const field of AWS_SERVER_IP_FIELDS) {
      const value = record.fields[field];
      if (value !== undefined) awsServerIps.add(value);
    }
  }
  const problems: string[] = [];
  if (text.includes('@')) problems.push('the file holds an @');
  if (/(?<!\d)\d{12}(?!\d)/.test(text)) problems.push('the file holds a twelve-digit number');
  for (const match of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
    const ip = match[0];
    if (!isDocumentationIpv4(ip) && !awsServerIps.has(ip)) {
      problems.push('the file holds an IPv4 address outside the documentation ranges and the SES server fields');
    }
  }
  return problems;
}

function identityInputOf(record: EventRecord): IdentityInput {
  const recipientHmac = record.recipientHmac ?? '';
  const feedbackId = record.feedbackId ?? '';
  switch (record.kind) {
    case 'send':
      return { kind: 'Send', messageId: record.messageId, recipientHmac };
    case 'complaint':
      return { kind: 'Complaint', feedbackId };
    case 'complaintRecipient':
      return { kind: 'ComplaintRecipient', feedbackId, recipientHmac };
    case 'outcome':
      if (record.eventType === 'Bounce') return { kind: 'Bounce', feedbackId, recipientHmac };
      if (record.eventType === 'Delivery') return { kind: 'Delivery', messageId: record.messageId, recipientHmac };
      throw new Error(`the run captured no ${record.eventType} outcome`);
  }
}

function shapeOf(record: EventRecord): string {
  const fields = record.fields;
  if (record.eventType === 'Bounce') {
    return ['Bounce', `${fields.bounceType}/${fields.bounceSubType}`, fields.enhancedStatusCode].filter(Boolean).join(' ');
  }
  if (record.kind === 'complaint') return `Complaint ${fields.complaintFeedbackType}`;
  if (record.kind === 'complaintRecipient') return 'Complaint recipient';
  return record.eventType;
}

function laneRecords(records: readonly EventRecord[], configurationSet: string): EventRecord[] {
  return records.filter((record) => record.configurationSet === configurationSet);
}

// Constructed, not captured: every lane-map set exists, none is an identity's default, and each
// publishes all six event types, so in the closeability tests only the records decide.
function fullSesFacts(): SesConfigurationFacts {
  const sets = LANE_MAP.lanes.map((lane) => lane.configurationSet);
  return {
    configurationSets: new Set(sets),
    defaultConfigurationSets: new Set(),
    eventDestinations: new Map(
      sets.map((set) => [set, [{ enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] }]]),
    ),
  };
}

describe('the simulator-captured stored records', () => {
  const fixture = loadSimulatorRecordFixture();
  const records = fixture.records;
  const runBucketMs = bucketStartMs(Math.min(...records.map((record) => record.mailTimestampMs)));
  const lastArrivalMs = Math.max(...records.map((record) => record.arrivalTimeMs));

  it('holds the 26 records of ten sends, five scenarios through each of two lanes, labeled simulator-captured', () => {
    expect(fixture.provenance).toBe('simulator-captured');
    expect(records).toHaveLength(26);
    expect(records.filter((record) => record.provenance !== 'simulator-captured')).toEqual([]);
    for (const lane of [BULK, TRANSACTIONAL]) {
      const scenarios = fixture.messages.filter((message) => message.configurationSet === lane).map((message) => message.scenario);
      expect(scenarios.toSorted()).toEqual([...SIMULATOR_SCENARIOS].toSorted());
      expect(laneRecords(records, lane)).toHaveLength(13);
    }
    const listed = new Set(fixture.messages.map((message) => message.messageId));
    expect(records.filter((record) => !listed.has(record.messageId))).toEqual([]);
    expect(new Set(records.map((record) => record.runId)).size).toBe(1);
  });

  describe('the sender values replaced before commit', () => {
    it('holds only the placeholders, which the minimizer itself would store', () => {
      expect(capturedSenderValues(records)).toEqual([]);
      expect(validHostname(SENDER_DOMAIN_PLACEHOLDER)).toBe(SENDER_DOMAIN_PLACEHOLDER);
      expect(validIp(SOURCE_IP_PLACEHOLDER)).toBe(SOURCE_IP_PLACEHOLDER);
      expect(records.filter((record) => record.fields.sourceIp !== SOURCE_IP_PLACEHOLDER)).toEqual([]);
    });

    it('fails on any other sender domain or a source address outside the documentation ranges, without repeating it', () => {
      // Built from the placeholders, not taken as is, so this test checks the check whatever the file holds.
      const [first] = records;
      if (first === undefined) throw new Error('the fixture holds no record');
      const clean = { ...first, fields: { ...first.fields, fromDomain: SENDER_DOMAIN_PLACEHOLDER, sourceIp: SOURCE_IP_PLACEHOLDER } };
      const domain = { ...clean, fields: { ...clean.fields, fromDomain: 'shop-mail.net' } };
      const address = { ...clean, fields: { ...clean.fields, sourceIp: '10.20.30.40' } };
      const documented = { ...clean, fields: { ...clean.fields, sourceIp: '203.0.113.9' } };

      expect(capturedSenderValues([domain])).toEqual(['record 0: fromDomain is not the placeholder']);
      expect(capturedSenderValues([address])).toEqual(['record 0: sourceIp is not a documentation address']);
      expect(capturedSenderValues([documented])).toEqual([]);
      expect(capturedSenderValues([domain, address]).join(' ')).not.toMatch(/shop-mail|10\.20/);
    });

    it('carries no address, account id or caller IP anywhere in the file, the SES server addresses aside', () => {
      expect(strayIdentifiers(FIXTURE_TEXT, records)).toEqual([]);
      expect(strayIdentifiers(`${FIXTURE_TEXT} 10.20.30.40`, records)).toEqual([
        'the file holds an IPv4 address outside the documentation ranges and the SES server fields',
      ]);
      expect(strayIdentifiers(`${FIXTURE_TEXT} 870000000001 a@b`, records)).toEqual([
        'the file holds an @',
        'the file holds a twelve-digit number',
      ]);
      const hostnames = records.flatMap((record) => [record.receivingDomain, record.fields.reportingMta]).filter((value) => value !== undefined);
      expect(hostnames.filter((host) => host !== 'simulator.amazonses.com' && !host.endsWith('.amazonses.com'))).toEqual([]);
    });
  });

  it('keys, buckets and expiry every record exactly as the current code would, so the live table and the code still agree', () => {
    const mismatched = records.filter((record) => {
      const expected = recordKey({
        configurationSet: record.configurationSet,
        bucketStartMs: bucketStartMs(record.mailTimestampMs),
        eventType: record.eventType,
        identity: identityFor(identityInputOf(record)),
      });
      return (
        record.pk !== expected.pk ||
        record.sk !== expected.sk ||
        record.bucketStartMs !== bucketStartMs(record.mailTimestampMs) ||
        record.expiresAt !== expiresAtFor(record.mailTimestampMs)
      );
    });
    expect(mismatched.map((record) => record.sk)).toEqual([]);
    expect(new Set(records.map((record) => `${record.pk}\u0000${record.sk}`)).size).toBe(records.length);
  });

  it('stores each scenario as SES delivered it: a complaint as two records, ooto as a transient bounce, suppressionlist as an ordinary hard bounce', () => {
    const expected: Record<(typeof SIMULATOR_SCENARIOS)[number], string[]> = {
      success: ['Delivery', 'Send'],
      bounce: ['Bounce Permanent/General 5.1.1', 'Send'],
      complaint: ['Complaint abuse', 'Complaint recipient', 'Delivery', 'Send'],
      ooto: ['Bounce Transient/General', 'Delivery', 'Send'],
      suppressionlist: ['Bounce Permanent/General 5.1.1', 'Send'],
    };
    for (const message of fixture.messages) {
      const own = records.filter((record) => record.messageId === message.messageId);
      expect({ message: `${message.configurationSet} ${message.scenario}`, shapes: own.map(shapeOf).toSorted() }).toEqual({
        message: `${message.configurationSet} ${message.scenario}`,
        shapes: expected[message.scenario],
      });

      // One recipient per message: every record that names one names the same keyed hash, and the
      // complaint's counting record names none.
      const hashes = new Set(own.map((record) => record.recipientHmac).filter((hmac) => hmac !== undefined));
      expect(hashes.size).toBe(1);
      for (const complaint of own.filter((record) => record.kind === 'complaint')) {
        expect(complaint.recipientHmac).toBeUndefined();
        expect(complaint.recipientCount).toBe(1);
      }
    }
  });

  it('counts the suppressionlist bounce in each lane hard-bounce numerator, since SES reported it as Permanent/General', () => {
    for (const lane of [BULK, TRANSACTIONAL]) {
      const [bucket, ...rest] = countLaneBuckets(laneRecords(records, lane), {
        fromBucketMs: runBucketMs,
        toBucketMs: runBucketMs,
        nowMs: lastArrivalMs,
      });
      expect(rest).toEqual([]);
      expect(bucket).toEqual({
        bucketStartMs: runBucketMs,
        complete: false,
        send: 5,
        delivery: 3,
        permanentBounce: 2,
        transientBounce: 1,
        undeterminedBounce: 0,
        complaint: 1,
        reject: 0,
        deliveryDelay: 0,
        suppressedBounce: 0,
        suppressedComplaint: 0,
        notSpamComplaint: 0,
      });
      if (bucket === undefined) throw new Error('no bucket counted');
      expect(hardBounceRatio(bucket)).toBe(0.4);
    }
  });

  it('refuses the bulk lane because one caller sent through both sets, and finds it closeable on its own records', () => {
    const options = { laneMap: LANE_MAP, windowStartMs: runBucketMs, nowMs: lastArrivalMs };
    const ses = fullSesFacts();

    const together = observeLanes(records, options);
    expect(checkCloseability(BULK, { laneMap: LANE_MAP, observed: together, ses })).toEqual({
      state: 'refused',
      reasons: ['caller-on-another-set'],
    });
    expect(checkCloseability(TRANSACTIONAL, { laneMap: LANE_MAP, observed: together, ses })).toEqual({
      state: 'refused',
      reasons: ['caller-on-another-set', 'transactional'],
    });

    const bulkOnly = observeLanes(laneRecords(records, BULK), options);
    expect(checkCloseability(BULK, { laneMap: LANE_MAP, observed: bulkOnly, ses }).state).toBe('closeable');
  });

  it('writes once through the fixture store, then reads each lane back until the 30-day expiry', async () => {
    const store = createFixtureEventStore();
    const first = await Promise.all(records.map((record) => store.putIfAbsent(record)));
    const again = await Promise.all(records.map((record) => store.putIfAbsent(record)));
    expect(first.filter((result) => result !== 'written')).toEqual([]);
    expect(again.filter((result) => result !== 'duplicate')).toEqual([]);

    const bulk = laneRecords(records, BULK);
    const firstExpiryMs = Math.min(...bulk.map((record) => record.expiresAt)) * 1000;
    const lastExpiryMs = Math.max(...bulk.map((record) => record.expiresAt)) * 1000;
    const read = await store.queryLane(BULK, runBucketMs, runBucketMs, lastArrivalMs);
    expect(read.map((record) => record.sk).toSorted()).toEqual(bulk.map((record) => record.sk).toSorted());
    expect(await store.queryLane(BULK, runBucketMs, runBucketMs, firstExpiryMs - 1000)).toHaveLength(13);
    expect(await store.queryLane(BULK, runBucketMs, runBucketMs, lastExpiryMs)).toEqual([]);
  });
});
