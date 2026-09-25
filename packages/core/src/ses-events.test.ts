import { describe, expect, it } from 'vitest';
import {
  loadSesEventFixture,
  SES_EVENT_FIXTURE_NAMES,
  type SesEventFixtureName,
} from '@fothering/providers/fixtures/ses-events/index';
import { parseSesEvent, type SesEvent } from './ses-events.js';

const BOUNCE_MESSAGE_ID = 'EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000';

function fixtureEvent(name: SesEventFixtureName): Record<string, unknown> {
  return structuredClone(loadSesEventFixture(name).event) as Record<string, unknown>;
}

function detailOf(event: Record<string, unknown>): Record<string, unknown> {
  return event.detail as Record<string, unknown>;
}

// The plan's own doc-derived fixtures are the only shapes worth asserting on; a helper narrows the
// discriminated union the same way a real caller would, so a test reads like calling code, not a cast.
function narrow<T extends SesEvent['eventType']>(event: SesEvent, eventType: T): Extract<SesEvent, { eventType: T }> {
  if (event.eventType !== eventType) throw new Error(`expected eventType ${eventType}, got ${event.eventType}`);
  return event as Extract<SesEvent, { eventType: T }>;
}

describe('parseSesEvent: the six doc-derived fixtures', () => {
  it.each(SES_EVENT_FIXTURE_NAMES)('loads %s by name, carries a doc-derived source, and parses with ok true', (name) => {
    const fixture = loadSesEventFixture(name);
    expect(fixture.provenance).toBe('doc-derived');
    expect(fixture.source).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//);
    expect(parseSesEvent(fixture.event)).toMatchObject({ ok: true });
  });
});

describe('parseSesEvent: envelope-level cross-checks', () => {
  it('fails without throwing when detail-type does not match the parsed eventType, and field reads envelope', () => {
    const event = fixtureEvent('bounce');
    event['detail-type'] = 'Email Sent';
    let result;
    expect(() => {
      result = parseSesEvent(event);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'envelope' });
  });

  it('fails without throwing when the envelope source is not aws.ses', () => {
    const event = fixtureEvent('bounce');
    event.source = 'aws.sns';
    expect(() => parseSesEvent(event)).not.toThrow();
    expect(parseSesEvent(event).ok).toBe(false);
  });
});

describe('parseSesEvent: unknown enum values map to unclassified', () => {
  it('maps an unfamiliar bounceType and bounceSubType to unclassified', () => {
    const event = fixtureEvent('bounce');
    const bounce = detailOf(event).bounce as Record<string, unknown>;
    bounce.bounceType = 'Astonishing';
    bounce.bounceSubType = 'NeverListed';
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Bounce');
    expect(parsed.bounce.bounceType).toBe('unclassified');
    expect(parsed.bounce.bounceSubType).toBe('unclassified');
  });

  it('maps an unfamiliar complaintFeedbackType to unclassified', () => {
    const event = fixtureEvent('complaint');
    const complaint = detailOf(event).complaint as Record<string, unknown>;
    complaint.complaintFeedbackType = 'never-listed';
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(parsed.complaint.complaintFeedbackType).toBe('unclassified');
  });

  it('maps an unfamiliar delayType to unclassified', () => {
    const event = fixtureEvent('delivery-delay');
    const delay = detailOf(event).deliveryDelay as Record<string, unknown>;
    delay.delayType = 'NeverListed';
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'DeliveryDelay');
    expect(parsed.deliveryDelay.delayType).toBe('unclassified');
  });
});

describe('parseSesEvent: complaintSubType', () => {
  it('reads an absent complaintSubType as no subtype', () => {
    const event = fixtureEvent('complaint');
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(parsed.complaint.complaintSubType).toBeUndefined();
  });

  it('reads an explicit null complaintSubType as no subtype', () => {
    const event = fixtureEvent('complaint');
    (detailOf(event).complaint as Record<string, unknown>).complaintSubType = null;
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(parsed.complaint.complaintSubType).toBeNull();
  });

  it.each(['OnAccountSuppressionList', 'OnTenantSuppressionList'])('keeps %s as is', (value) => {
    const event = fixtureEvent('complaint');
    (detailOf(event).complaint as Record<string, unknown>).complaintSubType = value;
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(parsed.complaint.complaintSubType).toBe(value);
  });

  it('maps any other complaintSubType value to unclassified', () => {
    const event = fixtureEvent('complaint');
    (detailOf(event).complaint as Record<string, unknown>).complaintSubType = 'SomethingElse';
    const result = parseSesEvent(event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(parsed.complaint.complaintSubType).toBe('unclassified');
  });
});

describe('parseSesEvent: unknown object keys are stripped', () => {
  it('drops mail.headers, commonHeaders, sourceArn, sendingAccountId and headersTruncated', () => {
    const result = parseSesEvent(fixtureEvent('bounce'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mail = result.event.detail.mail as Record<string, unknown>;
    expect(Object.hasOwn(mail, 'headers')).toBe(false);
    expect(Object.hasOwn(mail, 'commonHeaders')).toBe(false);
    expect(Object.hasOwn(mail, 'sourceArn')).toBe(false);
    expect(Object.hasOwn(mail, 'sendingAccountId')).toBe(false);
    expect(Object.hasOwn(mail, 'headersTruncated')).toBe(false);
  });

  it('drops complaint.userAgent and arrivalDate', () => {
    const result = parseSesEvent(fixtureEvent('complaint'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = narrow(result.event.detail, 'Complaint');
    expect(Object.hasOwn(parsed.complaint, 'userAgent')).toBe(false);
    expect(Object.hasOwn(parsed.complaint, 'arrivalDate')).toBe(false);
  });
});

describe('parseSesEvent: unparseable timestamps fail the parse', () => {
  it.each(['not a date', ''])('fails when mail.timestamp is %j, keeping the message id and the field', (bad) => {
    const event = fixtureEvent('bounce');
    (detailOf(event).mail as Record<string, unknown>).timestamp = bad;
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.mail.timestamp' });
  });

  it("fails when the Bounce object's own timestamp is unparseable, for the Bounce type too", () => {
    const event = fixtureEvent('bounce');
    (detailOf(event).bounce as Record<string, unknown>).timestamp = 'not a date';
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.bounce.timestamp' });
  });

  it('fails when the envelope time is unparseable, keeping the message id', () => {
    const event = fixtureEvent('bounce');
    event.time = 'not a date';
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID });
  });
});

describe('parseSesEvent: empty recipient lists fail the parse', () => {
  it('fails when bounce.bouncedRecipients is empty', () => {
    const event = fixtureEvent('bounce');
    (detailOf(event).bounce as Record<string, unknown>).bouncedRecipients = [];
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.bounce.bouncedRecipients' });
  });

  it('fails when delivery.recipients is empty', () => {
    const event = fixtureEvent('delivery');
    (detailOf(event).delivery as Record<string, unknown>).recipients = [];
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.delivery.recipients' });
  });

  it('fails when deliveryDelay.delayedRecipients is empty', () => {
    const event = fixtureEvent('delivery-delay');
    (detailOf(event).deliveryDelay as Record<string, unknown>).delayedRecipients = [];
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.deliveryDelay.delayedRecipients' });
  });
});

describe('parseSesEvent: field cuts after tags so no tag key from the input ever appears', () => {
  it('reports detail.mail.tags, never the tag key, when a tag value is not an array of strings', () => {
    const event = fixtureEvent('bounce');
    (detailOf(event).mail as Record<string, unknown>).tags = { 'ses:configuration-set': 'ConfigSet' };
    const result = parseSesEvent(event);
    expect(result).toEqual({ ok: false, messageId: BOUNCE_MESSAGE_ID, field: 'detail.mail.tags' });
  });
});

describe('parseSesEvent: mail.messageId is a pattern-checked identifier, never free text', () => {
  it.each([
    ['a space', 'bad id with space'],
    ['an @ sign', 'bad@id'],
    ['257 characters', 'a'.repeat(257)],
  ])('fails when mail.messageId holds %s', (_label, bad) => {
    const event = fixtureEvent('bounce');
    (detailOf(event).mail as Record<string, unknown>).messageId = bad;
    const result = parseSesEvent(event);
    expect(result.ok).toBe(false);
  });
});

describe('parseSesEvent: field is absent when the input is not an object', () => {
  // Each case wrapped in its own one-element array: a flat array containing both primitives and a
  // literal [] would let it.each spread that one array entry into zero arguments instead of binding
  // it as the value under test.
  it.each([[null], [undefined], ['not an object'], [42], [[]]])('omits field for %j', (raw) => {
    const result = parseSesEvent(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBeUndefined();
  });
});

// This exact set is pinned by packages/providers/src/fixtures/ingest-ports.test.ts (plan 01-01),
// which this plan's acceptance criteria requires to keep passing unchanged. It fixes the field
// derivation rule above: a first zod issue whose path does not start with "detail" (a missing
// top-level envelope field, the common shape of hostile or near-empty input) never surfaces a
// field, only the empty-path cross-check and detail-rooted content issues do.
describe('parseSesEvent: hostile or near-empty input carries no field, matching the pinned 01-01 case', () => {
  it.each([{}, { detail: null }, { detail: { mail: null } }, { detail: { mail: { messageId: 42 } } }])(
    'omits field for %j even though it is a plain object',
    (raw) => {
      const result = parseSesEvent(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.field).toBeUndefined();
    },
  );
});
