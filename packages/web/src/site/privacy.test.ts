import { parseLaneMap } from '@fothering/core/lanes';
import { minimizeEvent, type MinimizeContext } from '@fothering/core/minimize';
import { parseSesEvent, type SesEnvelope } from '@fothering/core/ses-events';
import { describe, expect, it } from 'vitest';
import { readRepoText, repoRoot } from './repo-facts.js';
import { identifyingFields, STORED_FIELDS, type StoredField, type StoredFieldPath } from './stored-fields.js';

const ROOT = repoRoot(process.cwd());
const FIXTURES = ['send', 'delivery', 'bounce', 'complaint', 'reject', 'delivery-delay'] as const;

// The doc-derived fixtures' configuration set, with every custom tag key set so the minimizer
// stores the four tag values and the run id too.
const LANE_MAP = parseLaneMap({
  runIdTagKey: 'siteRunId',
  lanes: [
    {
      configurationSet: 'ConfigSet',
      lane: 'site-check',
      criticality: 'bulk',
      declaredStreams: ['receipts'],
      streamTagKey: 'siteStream',
      batchTagKey: 'siteBatch',
      templateTagKey: 'siteTemplate',
      campaignTagKey: 'siteCampaign',
      operatorAlert: false,
    },
  ],
});
const PLANTED_TAGS = { siteStream: ['receipts'], siteBatch: ['batch-1'], siteTemplate: ['welcome'], siteCampaign: ['autumn'], siteRunId: ['run-1'] };

function contextFor(): MinimizeContext {
  const [lane] = LANE_MAP.lanes;
  if (lane === undefined) throw new Error('the planted lane map holds no lane');
  return {
    lane,
    laneMap: LANE_MAP,
    keySet: { versions: [{ id: 'k1', secret: 'planted-site-key-not-a-real-secret-0123456789', activeFromMs: 0 }] },
    provenance: 'doc-derived',
    envelopeTimeMs: 1_500_000_000_000,
    arrivalTimeMs: 1_500_000_000_000,
  };
}

function fixtureEnvelope(name: (typeof FIXTURES)[number]): SesEnvelope {
  const fixture = JSON.parse(readRepoText(`packages/providers/src/fixtures/ses-events/${name}.json`, ROOT)) as {
    event: { detail: { mail: { tags: Record<string, string[]> } } };
  };
  Object.assign(fixture.event.detail.mail.tags, PLANTED_TAGS);
  const parsed = parseSesEvent(fixture.event);
  if (!parsed.ok) throw new Error(`fixture ${name} does not parse at ${parsed.field ?? 'an unnamed field'}`);
  return parsed.event;
}

function storedPaths(record: object): string[] {
  return Object.entries(record).flatMap(([key, value]) => (key === 'fields' ? Object.keys(value as object).map((field) => `fields.${field}`) : [key]));
}

describe('the stored-field map', () => {
  it('lists the fields that can identify a person, in map order, with their row text', () => {
    expect(identifyingFields()).toEqual([
      {
        path: 'recipientHmac',
        identifies: 'Recipient',
        row: "An HMAC-SHA-256 of the lowercased address under a key kept in the operator's account. It is pseudonymised personal data: whoever holds the key can match an address to it.",
      },
      { path: 'receivingDomain', identifies: 'Recipient', row: 'The domain part of the recipient address.' },
      {
        path: 'sk',
        identifies: 'Recipient',
        row: "The record's key within its lane. On a record about one recipient it ends in that recipient's HMAC, so it is pseudonymised personal data in the same way.",
      },
      { path: 'fields.sourceIp', identifies: 'Sender', row: 'The IP address the sending application called SES from.' },
      { path: 'fields.fromDomain', identifies: 'Sender', row: 'The domain of the From address.' },
      { path: 'fields.callerIdentity', identifies: 'Sender', row: 'The IAM identity that called SES to send. It can name a person when a user, not a role, sends.' },
    ]);
  });

  it('classes every other field as neither', () => {
    const identifying = new Set(identifyingFields().map((field) => field.path));
    for (const [path, field] of Object.entries(STORED_FIELDS)) {
      if (!identifying.has(path)) expect(field, path).toEqual({ class: 'neither' });
    }
  });

  it('fails type checking for a map missing a field and for a map with a field the record lacks', () => {
    const { pk, ...withoutPk } = STORED_FIELDS;
    expect(pk).toEqual({ class: 'neither' });
    // @ts-expect-error pk is missing, so this is not a map over every stored field path
    const missingPk = withoutPk satisfies Record<StoredFieldPath, StoredField>;
    expect(Object.hasOwn(missingPk, 'pk')).toBe(false);
    // @ts-expect-error fields.notAField is not a field of the record type
    const extraField = { ...STORED_FIELDS, 'fields.notAField': { class: 'neither' } } satisfies Record<StoredFieldPath, StoredField>;
    expect(Object.hasOwn(extraField, 'fields.notAField')).toBe(true);
  });
});

describe('what minimize stores', () => {
  it('stores no key path outside the stored-field map, for every committed SES fixture event', () => {
    for (const name of FIXTURES) {
      const records = minimizeEvent(fixtureEnvelope(name), contextFor());
      expect(records.length, name).toBeGreaterThan(0);
      for (const path of records.flatMap(storedPaths)) expect(Object.hasOwn(STORED_FIELDS, path), `${name}: ${path}`).toBe(true);
    }
  });

  it('reaches every identifying field and the planted tag values, so the check above is not vacuous', () => {
    const seen = new Set(FIXTURES.flatMap((name) => minimizeEvent(fixtureEnvelope(name), contextFor()).flatMap(storedPaths)));
    for (const path of [...identifyingFields().map((field) => field.path), 'runId', 'fields.streamTagValue', 'fields.campaignTagValue']) {
      expect(seen.has(path), path).toBe(true);
    }
  });
});
