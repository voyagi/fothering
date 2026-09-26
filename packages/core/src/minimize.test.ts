import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { identityFor } from './identity.js';
import { minimizeEvent, UnstorableEventError, type MinimizeContext } from './minimize.js';
import { parseSesEvent, type SesEnvelope } from './ses-events.js';
import { findLane } from './lanes.js';
import { UNCLASSIFIED, type EventFields, type EventRecord } from './records.js';
import { propertySeed } from './test/property-seed.js';
import { DOC_EXAMPLE_LANE_MAP, loadSesEventFixture, type SesEventFixtureName } from '@fothering/providers/fixtures/ses-events/index';
import { TEST_ADDRESS_KEY_SET } from '@fothering/providers/fixtures/ingest-ports';

function docLane() {
  const lane = findLane(DOC_EXAMPLE_LANE_MAP, 'ConfigSet');
  if (lane === undefined) throw new Error('fixture configuration set missing from DOC_EXAMPLE_LANE_MAP');
  return lane;
}

const FIXED_NOW_MS = Date.parse('2023-07-17T16:48:05Z') + 60 * 60 * 1000;

function contextFor(overrides: Partial<MinimizeContext> = {}): MinimizeContext {
  return {
    lane: docLane(),
    laneMap: DOC_EXAMPLE_LANE_MAP,
    keySet: TEST_ADDRESS_KEY_SET,
    provenance: 'doc-derived',
    envelopeTimeMs: FIXED_NOW_MS,
    arrivalTimeMs: FIXED_NOW_MS,
    ...overrides,
  };
}

function mustParse(raw: unknown): SesEnvelope {
  const parsed = parseSesEvent(raw);
  if (!parsed.ok) throw new Error('expected the edited event to parse');
  return parsed.event;
}

function minimizeFixture(name: SesEventFixtureName, contextOverrides: Partial<MinimizeContext> = {}): EventRecord[] {
  return minimizeEvent(mustParse(loadSesEventFixture(name).event), contextFor(contextOverrides));
}

interface EditableBounceRaw {
  detail: {
    bounce: {
      timestamp: string;
      reportingMTA?: string;
      bouncedRecipients: { emailAddress: string; diagnosticCode?: string; status?: string; action?: string }[];
    };
    mail: { timestamp: string; tags: Record<string, string[]> };
  };
}

function editableBounceEvent(): EditableBounceRaw {
  return structuredClone(loadSesEventFixture('bounce').event) as EditableBounceRaw;
}

interface EditableComplaintRaw {
  detail: {
    complaint: { feedbackId: string; complainedRecipients: { emailAddress: string }[] };
  };
}

function editableComplaintEvent(): EditableComplaintRaw {
  return structuredClone(loadSesEventFixture('complaint').event) as EditableComplaintRaw;
}

describe('identityFor', () => {
  it('builds each event type identity per the field schedule, never the EventBridge envelope id', () => {
    expect(identityFor({ kind: 'Send', messageId: 'm1', recipientHmac: 'h1' })).toBe('Send#m1#h1');
    expect(identityFor({ kind: 'Reject', messageId: 'm1' })).toBe('Reject#m1');
    expect(identityFor({ kind: 'Delivery', messageId: 'm1', recipientHmac: 'h1' })).toBe('m1#h1');
    expect(identityFor({ kind: 'Bounce', feedbackId: 'fb1', recipientHmac: 'h1' })).toBe('fb1#h1');
    expect(identityFor({ kind: 'Complaint', feedbackId: 'fb1' })).toBe('fb1');
    expect(identityFor({ kind: 'ComplaintRecipient', feedbackId: 'fb1', recipientHmac: 'h1' })).toBe('fb1#h1');
    expect(identityFor({ kind: 'DeliveryDelay', messageId: 'm1', recipientHmac: 'h1', delayTimestampMs: 42 })).toBe('m1#h1#42');
  });

  it('gives Send and Reject different identities for the same message id (AC-E19)', () => {
    const sendIdentity = identityFor({ kind: 'Send', messageId: 'm1', recipientHmac: 'h1' });
    const rejectIdentity = identityFor({ kind: 'Reject', messageId: 'm1' });
    expect(sendIdentity).not.toBe(rejectIdentity);
  });

  it('gives a complaint recipient item a longer identity than the counting record under the same feedbackId, so the two never collide', () => {
    const counting = identityFor({ kind: 'Complaint', feedbackId: 'fb1' });
    const recipient = identityFor({ kind: 'ComplaintRecipient', feedbackId: 'fb1', recipientHmac: 'h1' });
    expect(recipient).not.toBe(counting);
    expect(recipient.startsWith(`${counting}#`)).toBe(true);
  });
});

describe('minimizeEvent: Send', () => {
  it('writes one send record per destination address (AC-9)', () => {
    const withThree = structuredClone(loadSesEventFixture('send').event) as {
      detail: { mail: { destination: string[] } };
    };
    withThree.detail.mail.destination = ['recipient@example.com', 'second@example.org', 'third@example.net'];
    const records = minimizeEvent(mustParse(withThree), contextFor());
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.kind === 'send' && record.eventType === 'Send')).toBe(true);
    expect(new Set(records.map((record) => record.sk)).size).toBe(3);
  });

  it('reads the stream tag value from the lane’s own stream tag key', () => {
    const [record] = minimizeFixture('send');
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.streamTagValue).toBe('myCustomTagValue1');
  });

  it('carries no delivery- or bounce-only field', () => {
    const [record] = minimizeFixture('send');
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.bounceType).toBeUndefined();
    expect(record.fields.remoteMtaIp).toBeUndefined();
  });
});

describe('minimizeEvent: Reject', () => {
  it('writes one record for the whole event, carrying no recipient identity', () => {
    const [record] = minimizeFixture('reject');
    if (record === undefined) throw new Error('expected a record');
    expect(record.kind).toBe('outcome');
    expect(record.eventType).toBe('Reject');
    expect(record.recipientHmac).toBeUndefined();
    expect(record.receivingDomain).toBeUndefined();
  });

  it('gives Send and Reject records of the same message id two different keys (AC-E19)', () => {
    const sendParsed = parseSesEvent(loadSesEventFixture('send').event);
    const rejectParsed = parseSesEvent(loadSesEventFixture('reject').event);
    if (!sendParsed.ok || !rejectParsed.ok) throw new Error('expected both fixtures to parse');
    expect(sendParsed.event.detail.mail.messageId).toBe(rejectParsed.event.detail.mail.messageId);
    const sendKeys = new Set(minimizeEvent(sendParsed.event, contextFor()).map((record) => record.sk));
    const rejectKeys = new Set(minimizeEvent(rejectParsed.event, contextFor()).map((record) => record.sk));
    for (const key of rejectKeys) expect(sendKeys.has(key)).toBe(false);
  });
});

describe('minimizeEvent: Delivery', () => {
  it('writes one outcome record per delivered recipient, with codes drawn from smtpResponse', () => {
    const [record] = minimizeFixture('delivery');
    if (record === undefined) throw new Error('expected a record');
    expect(record.kind).toBe('outcome');
    expect(record.eventType).toBe('Delivery');
    expect(record.fields.enhancedStatusCode).toBe('2.6.0');
    expect(record.fields.basicReplyCode).toBe('250');
    // the doc example's remoteMtaIp, "123.456.789.012", is not a valid IPv4 address (D-37)
    expect(record.fields.remoteMtaIp).toBe('unclassified');
    expect(record.fields.reportingMta).toBe('mta.example.com');
    expect(record.fields.outgoingIp).toBe('192.0.2.0');
    expect(record.recipientHmac).toBeDefined();
    expect(record.receivingDomain).toBe('example.com');
  });
});

describe('minimizeEvent: Bounce', () => {
  it('fills the full bounce field schedule from the doc fixture', () => {
    const [record] = minimizeFixture('bounce');
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.bounceType).toBe('Permanent');
    expect(record.fields.bounceSubType).toBe('General');
    expect(record.fields.recipientStatus).toBe('5.1.1');
    expect(record.fields.recipientAction).toBe('failed');
    expect(record.fields.enhancedStatusCode).toBe('5.1.1');
    expect(record.fields.basicReplyCode).toBe('550');
    expect(record.fields.reportingMta).toBe('mta.example.com');
    expect(record.fields.sourceIp).toBe('192.0.2.0');
    expect(record.fields.fromDomain).toBe('example.com');
    expect(record.fields.callerIdentity).toBe('ses_user');
  });
});

describe('minimizeEvent: Complaint (D-33)', () => {
  it('writes one counting record with no recipient field, plus one complaintRecipient item per complained recipient', () => {
    const twoRecipients = editableComplaintEvent();
    twoRecipients.detail.complaint.complainedRecipients = [
      { emailAddress: 'recipient@example.com' },
      { emailAddress: 'second@example.org' },
    ];
    const records = minimizeEvent(mustParse(twoRecipients), contextFor());
    expect(records).toHaveLength(3);
    const counting = records.find((record) => record.kind === 'complaint');
    const recipients = records.filter((record) => record.kind === 'complaintRecipient');
    if (counting === undefined) throw new Error('expected a counting record');
    expect(counting.recipientCount).toBe(2);
    expect(counting.recipientHmac).toBeUndefined();
    expect(counting.receivingDomain).toBeUndefined();
    expect(recipients).toHaveLength(2);
    for (const recipient of recipients) {
      expect(recipient.feedbackId).toBe(counting.feedbackId);
      expect(recipient.recipientHmac).toBeDefined();
    }
    expect(new Set(records.map((record) => record.sk)).size).toBe(3);
  });

  it('reads complaintFeedbackType onto the counting record, and leaves complaintSubType absent when the event carries none', () => {
    const records = minimizeFixture('complaint');
    const counting = records.find((record) => record.kind === 'complaint');
    if (counting === undefined) throw new Error('expected a counting record');
    expect(counting.fields.complaintFeedbackType).toBe('abuse');
    expect(counting.fields.complaintSubType).toBeUndefined();
  });
});

describe('minimizeEvent: DeliveryDelay', () => {
  it('fills delayType, delayTimestampMs and the recipient status/code fields', () => {
    const [record] = minimizeFixture('delivery-delay');
    if (record === undefined) throw new Error('expected a record');
    expect(record.kind).toBe('outcome');
    expect(record.eventType).toBe('DeliveryDelay');
    expect(record.fields.delayType).toBe('TransientCommunicationFailure');
    expect(record.fields.delayTimestampMs).toBe(Date.parse('2020-06-16T00:25:40.095Z'));
    expect(record.fields.recipientStatus).toBe('4.4.1');
    expect(record.fields.enhancedStatusCode).toBe('4.4.1');
    expect(record.fields.basicReplyCode).toBe('421');
    expect(record.eventTimestampMs).toBe(Date.parse('2020-06-16T00:25:40.095Z'));
  });

  it('bakes the delay timestamp into the record identity, so repeated delays on one message stay distinct', () => {
    const parsed = mustParse(loadSesEventFixture('delivery-delay').event);
    const later = structuredClone(parsed) as typeof parsed;
    (later.detail as { deliveryDelay: { timestamp: string } }).deliveryDelay.timestamp = new Date(
      Date.parse((parsed.detail as { deliveryDelay: { timestamp: string } }).deliveryDelay.timestamp) + 60_000,
    ).toISOString();
    const first = minimizeEvent(parsed, contextFor());
    const second = minimizeEvent(later, contextFor());
    expect(first[0]?.sk).not.toBe(second[0]?.sk);
  });
});

describe('AC-10: a diagnosticCode holding a sentence, an address and a URL', () => {
  it('stores only the enhanced status code and the basic reply code, and no other substring', () => {
    const event = editableBounceEvent();
    const recipient = event.detail.bounce.bouncedRecipients[0];
    if (recipient === undefined) throw new Error('fixture bounce has no recipient');
    recipient.diagnosticCode =
      'smtp; 550 5.1.1 the mailbox for jane@example.com is full, see https://example.com/bounce-help for details';
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.enhancedStatusCode).toBe('5.1.1');
    expect(record.fields.basicReplyCode).toBe('550');
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('jane@example.com');
    expect(serialized).not.toContain('https://example.com/bounce-help');
    expect(serialized).not.toContain('mailbox');
  });
});

describe('the status code of SES’s own expiry bounce', () => {
  // SES writes this when its retry window closes (verbatim from an AWS re:Post question about mail
  // sent through SES): a 550 reply whose status slot holds 4.4.7.
  it('stores 4.4.7 and 550, and nothing else of the line', () => {
    const event = editableBounceEvent();
    const recipient = event.detail.bounce.bouncedRecipients[0];
    if (recipient === undefined) throw new Error('fixture bounce has no recipient');
    recipient.diagnosticCode =
      'smtp; 550 4.4.7 Message expired: unable to deliver in 840 minutes.<421 4.4.1 Failed to establish connection>';
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.enhancedStatusCode).toBe('4.4.7');
    expect(record.fields.basicReplyCode).toBe('550');
    expect(JSON.stringify(record)).not.toContain('Message expired');
  });
});

type StringField = Exclude<keyof EventFields, 'delayTimestampMs'>;

const ENHANCED_CODE_RE = /^[245]\.\d{1,3}\.\d{1,3}$/;
const HOSTNAME_LABEL_CHECK = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Written apart from extract.ts on purpose: a check that called the extractors would agree with
// them by construction and prove nothing.
function isAddress(value: string): boolean {
  return isIP(value) !== 0 && !value.includes('%');
}

function isHostname(value: string): boolean {
  const labels = value.split('.');
  const topLevel = labels[labels.length - 1] ?? '';
  return value.length <= 253 && labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL_CHECK.test(label)) && /[a-z]/.test(topLevel);
}

const FIELD_CHECKS: Record<StringField, (value: string) => boolean> = {
  bounceType: (value) => ['Undetermined', 'Permanent', 'Transient'].includes(value),
  bounceSubType: (value) => /^[A-Za-z]+$/.test(value),
  complaintFeedbackType: (value) => ['abuse', 'auth-failure', 'fraud', 'not-spam', 'other', 'virus'].includes(value),
  complaintSubType: (value) => ['OnAccountSuppressionList', 'OnTenantSuppressionList'].includes(value),
  delayType: (value) => /^[A-Za-z]+$/.test(value),
  recipientStatus: (value) => ENHANCED_CODE_RE.test(value),
  recipientAction: (value) => ['failed', 'delayed', 'delivered', 'relayed', 'expanded'].includes(value),
  enhancedStatusCode: (value) => ENHANCED_CODE_RE.test(value),
  basicReplyCode: (value) => /^[245]\d{2}$/.test(value),
  remoteMtaIp: isAddress,
  reportingMta: (value) => isAddress(value) || isHostname(value),
  outgoingIp: isAddress,
  sourceIp: isAddress,
  fromDomain: isHostname,
  callerIdentity: (value) => /^[A-Za-z0-9+=,._-]{1,128}$/.test(value),
  streamTagValue: (value) => /^[A-Za-z0-9_-]{1,256}$/.test(value),
  batchTagValue: (value) => /^[A-Za-z0-9_-]{1,256}$/.test(value),
  templateTagValue: (value) => /^[A-Za-z0-9_-]{1,256}$/.test(value),
  campaignTagValue: (value) => /^[A-Za-z0-9_-]{1,256}$/.test(value),
};

function strayFields(fields: EventFields): string[] {
  const strays: string[] = [];
  for (const [name, check] of Object.entries(FIELD_CHECKS) as [StringField, (value: string) => boolean][]) {
    const value = fields[name];
    if (value === undefined || value === UNCLASSIFIED) continue;
    if (!check(value)) strays.push(`${name}=${JSON.stringify(value)}`);
  }
  return strays;
}

// Arbitrary text, plus near misses shaped like the values each field accepts, so the property
// reaches the accepting branches and not only the refusals.
const textArb = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.stringMatching(/^(?:smtp; ?)?[245]\d{2}[ -][245]\.\d{1,4}\.\d{1,4}[ .a-z@<>-]{0,24}$/),
  fc.stringMatching(/^(?:dsn; )?[a-z0-9-]{1,12}(?:\.[a-z0-9-]{1,12}){0,3}$/),
  fc.constantFrom('203.0.113.9', '2001:db8::1', 'fe80::1%eth0', 'jane@example.com', 'MTA.Example.COM', 'failed', '5.1.1', 'ses_user'),
);

describe('closed vocabulary under arbitrary text', () => {
  it('stores only a pattern-checked value or unclassified in every bounce and delivery field, whatever text the event carries', () => {
    // Non-vacuity: every field below must be stored as a real value at least once, or the property
    // only ever saw the refusals and never checked what an accepted value looks like.
    const accepted = new Set<string>();
    fc.assert(
      fc.property(fc.array(textArb, { minLength: 11, maxLength: 11 }), (texts) => {
        const [diagnostic, status, action, reportingMta, sourceIp, fromDomain, caller, stream, smtp, remoteIp, outgoingIp] =
          texts as [string, string, string, string, string, string, string, string, string, string, string];
        const bounce = editableBounceEvent();
        const recipient = bounce.detail.bounce.bouncedRecipients[0];
        if (recipient === undefined) throw new Error('fixture bounce has no recipient');
        recipient.diagnosticCode = diagnostic;
        recipient.status = status;
        recipient.action = action;
        bounce.detail.bounce.reportingMTA = reportingMta;
        Object.assign(bounce.detail.mail.tags, {
          'ses:source-ip': [sourceIp],
          'ses:from-domain': [fromDomain],
          'ses:caller-identity': [caller],
          myCustomTag1: [stream],
        });

        const delivery = structuredClone(loadSesEventFixture('delivery').event) as {
          detail: { delivery: { smtpResponse: string; remoteMtaIp: string; reportingMTA?: string }; mail: { tags: Record<string, string[]> } };
        };
        delivery.detail.delivery.smtpResponse = smtp;
        delivery.detail.delivery.remoteMtaIp = remoteIp;
        delivery.detail.delivery.reportingMTA = reportingMta;
        delivery.detail.mail.tags['ses:outgoing-ip'] = [outgoingIp];

        const records = [...minimizeEvent(mustParse(bounce), contextFor()), ...minimizeEvent(mustParse(delivery), contextFor())];
        expect(records.flatMap((record) => strayFields(record.fields))).toEqual([]);
        for (const record of records) {
          for (const [name, value] of Object.entries(record.fields)) {
            if (typeof value === 'string' && value !== UNCLASSIFIED) accepted.add(name);
          }
        }
      }),
      { seed: propertySeed(), numRuns: 300 },
    );
    const exercised: StringField[] = [
      'enhancedStatusCode', 'basicReplyCode', 'recipientStatus', 'recipientAction', 'reportingMta', 'remoteMtaIp',
      'outgoingIp', 'sourceIp', 'fromDomain', 'callerIdentity', 'streamTagValue',
    ];
    expect(exercised.filter((name) => !accepted.has(name))).toEqual([]);
  });
});

describe('AC-E16: hostile tag values and an IDN receiving domain', () => {
  it('omits a stream tag value that fails the tag pattern, rather than storing it as unclassified', () => {
    const event = editableBounceEvent();
    event.detail.mail.tags.myCustomTag1 = ['has a space'];
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.streamTagValue).toBeUndefined();
  });

  it('omits a stream tag with an @ sign or a non-ASCII letter', () => {
    for (const hostile of ['jane@example.com', 'café']) {
      const event = editableBounceEvent();
      event.detail.mail.tags.myCustomTag1 = [hostile];
      const [record] = minimizeEvent(mustParse(event), contextFor());
      if (record === undefined) throw new Error('expected a record');
      expect(record.fields.streamTagValue).toBeUndefined();
    }
  });

  it('stores an IDN receiving domain in lowercase punycode', () => {
    const idnLabel = String.fromCodePoint(0x62, 0xfc, 0x63, 0x68, 0x65, 0x72); // b, U+00FC, cher
    const event = editableBounceEvent();
    const recipient = event.detail.bounce.bouncedRecipients[0];
    if (recipient === undefined) throw new Error('fixture bounce has no recipient');
    recipient.emailAddress = `Recipient@${idnLabel}.Example`;
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.receivingDomain).toBe('xn--bcher-kva.example');
  });
});

describe('custom tag reading follows the exact-key, single-value rule (Pitfall 5)', () => {
  it('ignores a stream tag with more than one value', () => {
    const event = editableBounceEvent();
    event.detail.mail.tags.myCustomTag1 = ['a', 'b'];
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.streamTagValue).toBeUndefined();
  });

  it('is unaffected by a __proto__ own tag key standing beside the stream tag key', () => {
    const text = JSON.stringify(editableBounceEvent()).replace('"tags":{', '"tags":{"__proto__":["polluted"],');
    const event = JSON.parse(text) as unknown;
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.fields.streamTagValue).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('runId (D-24)', () => {
  it('reads the run id from the lane map’s own runIdTagKey', () => {
    const event = editableBounceEvent();
    event.detail.mail.tags.fotheringRunId = ['run-42'];
    const [record] = minimizeEvent(mustParse(event), contextFor());
    if (record === undefined) throw new Error('expected a record');
    expect(record.runId).toBe('run-42');
  });

  it('leaves runId absent when the tag is missing', () => {
    const [record] = minimizeFixture('bounce');
    if (record === undefined) throw new Error('expected a record');
    expect(record.runId).toBeUndefined();
  });
});

function minimizeError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a mail timestamp with no storable send-time bucket', () => {
  // The key version covers each date, so only the bucket range can refuse these events.
  it.each([
    ['before 1970', '1969-12-31T23:59:59Z'],
    ['past the 13-digit sort key range', '2287-01-01T00:00:00Z'],
  ])('refuses one %s with UnstorableEventError, never filing it under another bucket', (_label, timestamp) => {
    const event = editableBounceEvent();
    event.detail.mail.timestamp = timestamp;
    const keySet = { versions: [{ id: 'k0', secret: 'range-test-key', activeFromMs: -1_000_000_000 }] };
    const error = minimizeError(() => minimizeEvent(mustParse(event), contextFor({ keySet })));
    expect(error).toBeInstanceOf(UnstorableEventError);
    expect((error as Error).name).toBe('UnstorableEventError');
  });

  // The shared test key is active only from 0, so a key lookup run first would refuse a 1969 send
  // as a missing key version, which ingest retries: the event can never be stored, so the range
  // refusal must come before any key is read.
  it('refuses a send before 1970 as unstorable even when no key version covers its date', () => {
    const event = editableBounceEvent();
    event.detail.mail.timestamp = '1969-12-31T23:59:59Z';
    const error = minimizeError(() => minimizeEvent(mustParse(event), contextFor()));
    expect((error as Error | undefined)?.name).toBe('UnstorableEventError');
  });
});

describe('the lane guard (unchanged from plan 01-01)', () => {
  it('still refuses to minimize an event under a lane other than its own configuration set, for every event type', () => {
    for (const name of ['send', 'delivery', 'bounce', 'complaint', 'reject', 'delivery-delay'] as const) {
      const parsed = mustParse(loadSesEventFixture(name).event);
      expect(() => minimizeEvent(parsed, contextFor({ lane: { ...docLane(), configurationSet: 'OtherSet' } }))).toThrow(
        'does not match the lane',
      );
    }
  });
});
