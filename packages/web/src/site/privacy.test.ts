import { parseLaneMap } from '@fothering/core/lanes';
import { minimizeEvent, type MinimizeContext } from '@fothering/core/minimize';
import { parseSesEvent, type SesEnvelope } from '@fothering/core/ses-events';
import { describe, expect, it } from 'vitest';
import { CONTROLLER, FORGET_DOC, MODEL_FORBIDDEN, MODEL_REQUIRED, modelRecordRows, modelStatements, PRIVACY_REQUIRED, SIX_RIGHTS, WEBSITE_FACTS } from './content.js';
import { readForgetCommand, readRepoText, repoRoot } from './repo-facts.js';
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
    const identifying = new Set<string>(identifyingFields().map((field) => field.path));
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

// One planted positive per forbidden claim (AC-25), each also written in the negated form the
// model-role elements use (AC-E18).
const FORBIDDEN_POSITIVES: Readonly<Record<string, string>> = {
  'cause': 'The model works out the cause.',
  'stored-data': 'The agent reads stored events.',
  'lane-choice': 'The model approves a lane.',
  'lane-change': 'The agent pauses the lane.',
  'ses-call': 'The model calls SES.',
  'reply': 'The agent reads the reply.',
};
const negated = (sentence: string): string => sentence.replace(/^The (model|agent) /, 'The $1 never ');
const claimsIn = (text: string): string[] => MODEL_FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ claim }) => claim);

describe('the model-role lists (AC-24, AC-25, AC-E18)', () => {
  it('finds no forbidden claim in any required statement, the runtime-role sentence included', () => {
    expect(MODEL_REQUIRED.length).toBeGreaterThan(0);
    for (const statement of MODEL_REQUIRED) expect(claimsIn(statement.text), statement.id).toEqual([]);
  });

  it('finds no forbidden claim in the negated sentence "The model never names the cause."', () => {
    expect(claimsIn('The model never names the cause.')).toEqual([]);
  });

  it('has one planted positive per forbidden claim', () => {
    expect(MODEL_FORBIDDEN.map(({ claim }) => claim).sort()).toEqual(Object.keys(FORBIDDEN_POSITIVES).sort());
  });

  it.each(Object.entries(FORBIDDEN_POSITIVES))('the %s claim matches "%s" and not its negated form', (claim, sentence) => {
    expect(claimsIn(sentence)).toEqual([claim]);
    expect(claimsIn(negated(sentence))).toEqual([]);
  });

  it('keeps the runtime-role sentence only while the runtime role holds no data action', () => {
    const ids = (holdsNone: boolean): string[] => modelStatements(holdsNone).map((statement) => statement.id);
    expect(ids(true)).toContain('runtime-role');
    expect(ids(false)).not.toContain('runtime-role');
    expect(ids(true).length - ids(false).length).toBe(1);
  });
});

describe('the privacy lists (AC-19, AC-21, AC-P16)', () => {
  it('names the controller and the contact route by role only', () => {
    expect(CONTROLLER).toEqual({ name: 'the developer who built this hackathon entry', contact: "open an issue on the project's repository" });
    const website = WEBSITE_FACTS.map((fact) => fact.text).join(' ');
    expect(website).toContain(CONTROLLER.name);
    expect(website).toContain(CONTROLLER.contact);
    expect(website).not.toContain('@');
  });

  it('lists the six rights once each', () => {
    expect([...SIX_RIGHTS].sort()).toEqual(['access', 'data portability', 'erasure', 'objection', 'rectification', 'restriction of processing']);
  });

  it('holds every AC-19 statement, the Bedrock one carrying the AWS page as its link', () => {
    expect(PRIVACY_REQUIRED.map((statement) => statement.id)).toEqual([
      'event-region', 'model-requests', 'keyed-hash', 'retention', 'dead-letter', 'logs', 'forget', 'forget-reach', 'addresses', 'deployment-controller', 'tag-values',
    ]);
    expect(PRIVACY_REQUIRED.find((statement) => statement.id === 'model-requests')?.link).toBe('https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html');
    expect(PRIVACY_REQUIRED.find((statement) => statement.id === 'forget')?.text).toContain(FORGET_DOC);
  });

  it('never says deletion happens exactly at 30 days, nor that everything stays in one Region', () => {
    const all = [...PRIVACY_REQUIRED, ...WEBSITE_FACTS].map((statement) => statement.text).join(' ');
    expect(all).not.toMatch(/exactly\s+30|deleted\s+(?:at|on|after)?\s*30\s+days|\beverything\b|\ball\s+(?:of\s+)?(?:the\s+)?data\b/i);
    expect(all).toContain('deleted within a few days after that');
  });
});

describe('modelRecordRows (AC-26, UI-SPEC E12)', () => {
  it('gives the four fixed rows with the pinned id and Region filled in', () => {
    const rows = modelRecordRows('eu.planted.model-v1', 'eu-planted-1');
    expect(rows.map((row) => row.label)).toEqual(['Model', 'Region', 'Default', 'Labelled output']);
    expect(rows[0]).toEqual({ label: 'Model', text: '`eu.planted.model-v1`', attrs: { 'data-model-id': '' } });
    expect(rows[3]?.attrs).toEqual({ 'data-model-role': '' });
    expect(rows[1]?.text).toContain('`eu-planted-1`');
  });

  it('refuses an inference profile outside the EU, which the privacy section could not describe truthfully', () => {
    expect(() => modelRecordRows('global.planted.model-v1', 'eu-planted-1')).toThrow(/global\.planted\.model-v1 is not an EU inference profile/);
  });
});

describe('readForgetCommand (AC-23)', () => {
  it('reads the invoke command and the stack output naming its function from the committed doc', () => {
    expect(readForgetCommand(readRepoText(FORGET_DOC, ROOT))).toEqual({ command: 'aws lambda invoke', output: 'ForgetFunctionName' });
  });

  it('refuses a doc with no invoke line in a sh block, naming the doc', () => {
    expect(() => readForgetCommand('# Forget\n\n```sh\naws cloudformation describe-stacks\n```\n')).toThrow(/docs\/forget-one-recipient\.md: no aws lambda invoke line/);
  });

  it('refuses a doc that names no stack output for the function', () => {
    expect(() => readForgetCommand('```sh\naws lambda invoke \\\n  --function-name planted\n```\n')).toThrow(/docs\/forget-one-recipient\.md: no stack output names the function/);
  });
});
