import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, evidenceRecordSchema } from './evidence-record.js';
import {
  DNS_LOOKUP_CONCURRENCY,
  MAX_DNS_LOOKUPS_PER_CYCLE,
  PROVIDER_MAPPING,
  ROW_LIMIT,
  SIMULATOR_DOMAIN,
  buildConfigurationRows,
  buildLaneConfigurationRows,
  buildProviderRows,
  buildShareRow,
  buildTagRows,
  configurationFromDomains,
  countableEventsOf,
  identityFor,
  organizationalDomain,
  planDnsLookups,
  providerOf,
  receivingDomainsNeedingMx,
  type ConfigurationRow,
  type DnsMxOutcome,
  type DnsTxtOutcome,
  type EvidenceRow,
  type IdentityAuthFacts,
  type TagDimension,
} from './evidence-rows.js';
import { propertySeed } from './test/property-seed.js';
import type { ConfigurationRecord } from './window-fold.js';
import { SES_TAG_PATTERN, type LaneEntry, type LaneMap } from './lanes.js';
import type { EventFields, EventRecord } from './records.js';
import { TEST_CONFIGURATION_SET, TEST_KEY_SET, TEST_LANE, TEST_LANE_MAP, scenarioRecords, type ScenarioGroup } from './test/event-arbitraries.js';
import { LANE_SHARE_LABEL, ROW_MIN_RECIPIENT_SENDS, laneSpikeVerdict, renderPercent, type LaneSpikeVerdict } from './verdicts.js';
import { createWindowFold, spikeWindowFor, summarizeWindow, type WindowSummary } from './window-fold.js';

const NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
const WINDOW = spikeWindowFor(NOW_MS);
const FROM_DOMAIN = 'news.example.com';

const OTHER_LANE: LaneEntry = { ...TEST_LANE, configurationSet: 'OtherLane', lane: 'other-lane' };
const TWO_LANE_MAP: LaneMap = { ...TEST_LANE_MAP, lanes: [TEST_LANE, OTHER_LANE] };

function recordsOf(groups: readonly ScenarioGroup[], configurationSet: string = TEST_CONFIGURATION_SET): EventRecord[] {
  return scenarioRecords(
    { configurationSet, streamTag: 'stream-a', callerIdentity: 'prop-caller', fromDomain: FROM_DOMAIN, groups },
    NOW_MS,
    TWO_LANE_MAP,
    TEST_KEY_SET,
  );
}

function summaryOf(records: readonly EventRecord[], lane: string = TEST_CONFIGURATION_SET): WindowSummary {
  const fold = createWindowFold({ lane, window: WINDOW, nowMs: NOW_MS });
  return summarizeWindow(fold.step(fold.initial, records));
}

interface Lane {
  records: EventRecord[];
  summary: WindowSummary;
  spike: LaneSpikeVerdict;
}

function laneOf(groups: readonly ScenarioGroup[]): Lane {
  const records = recordsOf(groups);
  const summary = summaryOf(records);
  return { records, summary, spike: laneSpikeVerdict(summary.totals) };
}

const FIELD_BY_TAG: Record<TagDimension, keyof EventFields> = {
  batch: 'batchTagValue',
  template: 'templateTagValue',
  campaign: 'campaignTagValue',
};

// Counts straight from the stored records, never through the fold, so a row that drifts from the
// records it claims to summarize fails here (AC-7).
function independentCount(records: readonly EventRecord[], matches: (record: EventRecord) => boolean) {
  return {
    sends: records.filter((record) => record.kind === 'send' && matches(record)).length,
    permanentBounces: records.filter(
      (record) =>
        record.eventType === 'Bounce' &&
        record.fields.bounceType === 'Permanent' &&
        record.fields.bounceSubType !== 'OnAccountSuppressionList' &&
        matches(record),
    ).length,
    complaints: records.filter((record) => record.kind === 'complaint' && matches(record)).length,
  };
}

function countsOf(row: EvidenceRow) {
  return { sends: row.sends, permanentBounces: row.permanentBounces, complaints: row.complaints };
}

function sumRows(rows: readonly EvidenceRow[]) {
  return rows.reduce(
    (sum, row) => ({
      sends: sum.sends + row.sends,
      permanentBounces: sum.permanentBounces + row.permanentBounces,
      complaints: sum.complaints + row.complaints,
    }),
    { sends: 0, permanentBounces: 0, complaints: 0 },
  );
}

function laneCounts(summary: WindowSummary) {
  return {
    sends: summary.totals.recipientSends,
    permanentBounces: summary.totals.permanentBounces,
    complaints: summary.totals.complaints,
  };
}

function rowFor(rows: readonly EvidenceRow[], value: string): EvidenceRow {
  const row = rows.find((candidate) => candidate.kind === 'value' && candidate.value === value);
  if (row === undefined) throw new Error(`expected a value row for ${value}`);
  return row;
}

function verdictsByValue(rows: readonly EvidenceRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.value ?? row.kind, row.verdict]));
}

describe('tag rows recount from the stored records (AC-7)', () => {
  const lane = laneOf([
    { bucketOffset: 3, count: 40, batch: 'bad-import', template: 'welcome', permanentBounces: 10 },
    { bucketOffset: 3, count: 40, batch: 'worse-import', template: 'welcome', permanentBounces: 10 },
    { bucketOffset: 2, count: 120, batch: 'clean', template: 'receipt' },
    { bucketOffset: 1, count: 19, batch: 'tiny', template: 'receipt', permanentBounces: 10 },
  ]);

  it('gives each of cause, elevated, ruled out and not enough volume a fixture', () => {
    expect(lane.spike.verdict).toBe('spike');
    const causeLane = laneOf([
      { bucketOffset: 3, count: 40, batch: 'bad-import', permanentBounces: 15 },
      { bucketOffset: 2, count: 160, batch: 'clean' },
    ]);
    expect(rowFor(buildTagRows('batch', causeLane.summary, causeLane.spike), 'bad-import').verdict).toBe('cause');
    const rows = buildTagRows('batch', lane.summary, lane.spike);
    expect(verdictsByValue(rows)).toEqual({ 'bad-import': 'elevated', 'worse-import': 'elevated', clean: 'ruled-out', tiny: 'not-enough-volume' });
  });

  it('equals an independent count of the records carrying each tag value, in every tag dimension', () => {
    for (const dimension of ['batch', 'template', 'campaign'] as const) {
      const field = FIELD_BY_TAG[dimension];
      for (const row of buildTagRows(dimension, lane.summary, lane.spike)) {
        const expected =
          row.kind === 'value'
            ? independentCount(lane.records, (record) => record.fields[field] === row.value)
            : independentCount(lane.records, (record) => record.fields[field] === undefined);
        expect(countsOf(row)).toEqual(expected);
      }
    }
  });
});

describe('the row volume floor (AC-E15)', () => {
  it('judges a row of exactly ROW_MIN_RECIPIENT_SENDS and reads 19 as not enough volume', () => {
    const lane = laneOf([
      { bucketOffset: 2, count: ROW_MIN_RECIPIENT_SENDS, batch: 'at-floor', permanentBounces: 5 },
      { bucketOffset: 2, count: ROW_MIN_RECIPIENT_SENDS - 1, batch: 'under-floor', permanentBounces: 5 },
      { bucketOffset: 1, count: 100, batch: 'clean' },
    ]);
    const rows = buildTagRows('batch', lane.summary, lane.spike);
    expect(rowFor(rows, 'at-floor').verdict).toBe('cause');
    expect(rowFor(rows, 'under-floor').verdict).toBe('not-enough-volume');
  });
});

describe('one record in several dimensions and exact tag bytes (AC-E16, AC-E18)', () => {
  it('counts a value used as both batch and template once in each dimension', () => {
    const lane = laneOf([
      { bucketOffset: 1, count: 30, batch: 'spring', template: 'spring', permanentBounces: 6 },
      { bucketOffset: 1, count: 90, batch: 'other', template: 'other' },
    ]);
    expect(rowFor(buildTagRows('batch', lane.summary, lane.spike), 'spring').sends).toBe(30);
    expect(rowFor(buildTagRows('template', lane.summary, lane.spike), 'spring').sends).toBe(30);
  });

  it('keeps Batch1 and batch1 as two rows', () => {
    const lane = laneOf([
      { bucketOffset: 1, count: 30, batch: 'Batch1', permanentBounces: 6 },
      { bucketOffset: 1, count: 90, batch: 'batch1' },
    ]);
    const values = buildTagRows('batch', lane.summary, lane.spike).map((row) => row.value);
    expect(values).toEqual(['batch1', 'Batch1']);
  });
});

describe('no-value rows (AC-E17)', () => {
  const lane = laneOf([
    { bucketOffset: 2, count: 300, batch: 'clean' },
    { bucketOffset: 1, count: 40, permanentBounces: 20, complaints: 4 },
  ]);

  it('counts records with no value for a tag key in one no-value row so each dimension sums to the lane totals', () => {
    for (const dimension of ['batch', 'template', 'campaign'] as const) {
      const rows = buildTagRows(dimension, lane.summary, lane.spike);
      expect(rows.filter((row) => row.kind === 'no-value')).toHaveLength(1);
      expect(sumRows(rows)).toEqual(laneCounts(lane.summary));
    }
  });

  it('reads a no-value row carrying the spike as elevated, never cause (D-56)', () => {
    const noValue = buildTagRows('batch', lane.summary, lane.spike).find((row) => row.kind === 'no-value');
    expect(noValue?.value).toBeNull();
    expect(noValue?.verdict).toBe('elevated');
  });

  it('adds no no-value row when every record carries the tag', () => {
    const tagged = laneOf([{ bucketOffset: 1, count: 120, batch: 'all', permanentBounces: 6 }]);
    expect(buildTagRows('batch', tagged.summary, tagged.spike).map((row) => row.kind)).toEqual(['value']);
  });
});

describe('the row limit (AC-E21)', () => {
  const groups: ScenarioGroup[] = [
    ...Array.from({ length: ROW_LIMIT }, (_, index) => ({ bucketOffset: 2, count: 30, batch: `big-${String(index).padStart(2, '0')}` })),
    { bucketOffset: 1, count: 20, batch: 'small-a', permanentBounces: 10 },
    { bucketOffset: 1, count: 20, batch: 'small-b', permanentBounces: 10 },
  ];
  const lane = laneOf(groups);

  it('lists the 10 largest values by sends and one other row that sums the rest', () => {
    const rows = buildTagRows('batch', lane.summary, lane.spike);
    expect(ROW_LIMIT).toBe(10);
    expect(rows.map((row) => row.kind)).toEqual([...Array.from({ length: ROW_LIMIT }, () => 'value'), 'other']);
    expect(countsOf(rows[ROW_LIMIT] as EvidenceRow)).toEqual({ sends: 40, permanentBounces: 20, complaints: 0 });
    expect(sumRows(rows)).toEqual(laneCounts(lane.summary));
  });

  it('reads the other row at most elevated even when its ratio alone would be a cause (D-56)', () => {
    const other = buildTagRows('batch', lane.summary, lane.spike).find((row) => row.kind === 'other');
    expect(other?.value).toBeNull();
    expect(other?.verdict).toBe('elevated');
  });

  it('puts the no-value row after the value rows and before the other row', () => {
    const withNoValue = laneOf([...groups, { bucketOffset: 0, count: 5 }]);
    const kinds = buildTagRows('batch', withNoValue.summary, withNoValue.spike).map((row) => row.kind);
    expect(kinds.slice(ROW_LIMIT)).toEqual(['no-value', 'other']);
  });
});

describe('row order and integers (AC-E19, AC-E20)', () => {
  const groups: ScenarioGroup[] = [
    { bucketOffset: 3, count: 25, batch: 'b-tie', permanentBounces: 6 },
    { bucketOffset: 3, count: 25, batch: 'a-tie' },
    { bucketOffset: 2, count: 60, batch: 'largest' },
    { bucketOffset: 1, count: 10 },
  ];

  it('sorts by sends descending and then by value bytes, so two runs over the same records serialize identically', () => {
    const forward = laneOf(groups);
    const reversedSummary = summaryOf([...forward.records].reverse());
    const first = buildTagRows('batch', forward.summary, forward.spike);
    const second = buildTagRows('batch', reversedSummary, laneSpikeVerdict(reversedSummary.totals));
    expect(first.map((row) => row.value)).toEqual(['largest', 'a-tie', 'b-tie', null]);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  it('stores integer counts and renders every ratio from them', () => {
    const lane = laneOf(groups);
    for (const row of buildTagRows('batch', lane.summary, lane.spike)) {
      for (const value of [row.sends, row.permanentBounces, row.complaints]) expect(Number.isInteger(value)).toBe(true);
      expect(row.hardBounceRatio).toBe(renderPercent(row.permanentBounces, row.sends));
      expect(row.complaintRatio).toBe(renderPercent(row.complaints, row.sends));
      expect(row.sharePercent).toBe(renderPercent(row.sends, lane.summary.totals.recipientSends));
    }
  });
});

describe('the lane remainder rule (D-50, review fold 2026-10-12)', () => {
  it('reads cause beside a remainder of 99 recipient-sends at the threshold and elevated beside 100', () => {
    const under = laneOf([
      { bucketOffset: 2, count: 20, batch: 'row', permanentBounces: 10 },
      { bucketOffset: 1, count: 99, batch: 'remainder', permanentBounces: 5 },
    ]);
    const at = laneOf([
      { bucketOffset: 2, count: 20, batch: 'row', permanentBounces: 10 },
      { bucketOffset: 1, count: 100, batch: 'remainder', permanentBounces: 5 },
    ]);
    expect(rowFor(buildTagRows('batch', under.summary, under.spike), 'row').verdict).toBe('cause');
    expect(rowFor(buildTagRows('batch', at.summary, at.spike), 'row').verdict).toBe('elevated');
  });
});

describe('the provider mapping (D-57)', () => {
  it('lists Google, Microsoft, Apple and Yahoo under names a row value can carry', () => {
    expect(PROVIDER_MAPPING.map((entry) => entry.name)).toEqual(['Google', 'Microsoft', 'Apple', 'Yahoo']);
    for (const entry of PROVIDER_MAPPING) {
      expect(entry.name).toMatch(SES_TAG_PATTERN);
      expect(entry.mxSuffixes.length).toBeGreaterThan(0);
      expect(entry.receivingDomains.length).toBeGreaterThan(0);
    }
  });

  it('names a listed consumer domain without an MX answer', () => {
    expect(providerOf('gmail.com')).toBe('Google');
    expect(providerOf('outlook.com')).toBe('Microsoft');
    expect(providerOf('icloud.com')).toBe('Apple');
    expect(providerOf('yahoo.com')).toBe('Yahoo');
  });

  it('matches an MX exchange label-aligned, lowercased and without its trailing dot', () => {
    const mx = (...exchanges: string[]): DnsMxOutcome => ({ kind: 'records', exchanges });
    expect(providerOf('acme.example.org', mx('ASPMX.L.GOOGLE.COM.'))).toBe('Google');
    expect(providerOf('acme.example.org', mx('acme-org.mail.protection.outlook.com'))).toBe('Microsoft');
    expect(providerOf('acme.example.org', mx('yahoodns.net'))).toBe('Yahoo');
    expect(providerOf('acme.example.org', mx('mx.notgoogle.com'))).toBe('other');
    expect(providerOf('acme.example.org', mx('evilprotection.outlook.com'))).toBe('other');
  });

  it('reads other for a missing, unknown or absent MX answer and null for the simulator', () => {
    expect(providerOf('acme.example.org', { kind: 'missing' })).toBe('other');
    expect(providerOf('acme.example.org', { kind: 'unknown' })).toBe('other');
    expect(providerOf('acme.example.org')).toBe('other');
    expect(providerOf(SIMULATOR_DOMAIN)).toBeNull();
  });
});

describe('provider rows (R5, AC-P3)', () => {
  const lane = laneOf([
    { bucketOffset: 3, count: 60, batch: 'mixed', receivingDomains: ['gmail.com', 'outlook.com'] },
    { bucketOffset: 2, count: 40, batch: 'mixed', receivingDomains: ['example.org'], permanentBounces: 12 },
    { bucketOffset: 1, count: 30, batch: 'mixed', receivingDomains: [SIMULATOR_DOMAIN], permanentBounces: 3 },
  ]);
  const mxAnswers = new Map<string, DnsMxOutcome>([['example.org', { kind: 'missing' }]]);

  it('lists only the unlisted, non-simulator receiving domains for an MX lookup', () => {
    expect(receivingDomainsNeedingMx(lane.summary)).toEqual(['example.org']);
  });

  it('aggregates by mapping name, leaves the simulator out and sums to the lane totals minus simulator recipients', () => {
    const rows = buildProviderRows(lane.summary, lane.spike, mxAnswers);
    expect(rows.map((row) => [row.kind, row.value])).toEqual([
      ['value', 'Google'],
      ['value', 'Microsoft'],
      ['other', null],
    ]);
    const simulator = independentCount(lane.records, (record) => record.receivingDomain === SIMULATOR_DOMAIN);
    const lanes = laneCounts(lane.summary);
    expect(sumRows(rows)).toEqual({
      sends: lanes.sends - simulator.sends,
      permanentBounces: lanes.permanentBounces - simulator.permanentBounces,
      complaints: lanes.complaints - simulator.complaints,
    });
  });

  it('counts simulator recipients in the lane ratio and the tag rows', () => {
    expect(lane.summary.totals.recipientSends).toBe(130);
    expect(rowFor(buildTagRows('batch', lane.summary, lane.spike), 'mixed').sends).toBe(130);
  });

  it('reads the provider other row at most elevated', () => {
    const other = buildProviderRows(lane.summary, lane.spike, mxAnswers).find((row) => row.kind === 'other');
    expect(other?.permanentBounces).toBe(12);
    expect(other?.verdict).toBe('elevated');
  });

  it('serializes no receiving domain, only mapping names', () => {
    const serialized = canonicalJson([
      ...buildTagRows('batch', lane.summary, lane.spike),
      ...buildProviderRows(lane.summary, lane.spike, mxAnswers),
    ]);
    for (const domain of ['gmail.com', 'outlook.com', 'example.org', SIMULATOR_DOMAIN]) expect(serialized).not.toContain(domain);
    expect(serialized).not.toContain('recipientHmac');
  });
});

describe('the lane share of stored events (AC-8)', () => {
  it('counts every counted record kind for the lane and for all lane-map lanes under the share label', () => {
    const lane = laneOf([{ bucketOffset: 2, count: 50, permanentBounces: 5, complaints: 2 }]);
    const otherRecords = recordsOf([{ bucketOffset: 1, count: 150 }], OTHER_LANE.configurationSet);
    const otherSummary = summaryOf(otherRecords, OTHER_LANE.configurationSet);
    const counted = (records: readonly EventRecord[]) => records.filter((record) => record.kind !== 'complaintRecipient').length;
    expect(countableEventsOf(lane.summary)).toBe(counted(lane.records));
    const share = buildShareRow(lane.summary, [lane.summary, otherSummary]);
    expect(share).toEqual({
      laneCountableEvents: counted(lane.records),
      storedCountableEvents: counted(lane.records) + counted(otherRecords),
      percent: renderPercent(counted(lane.records), counted(lane.records) + counted(otherRecords)),
      label: LANE_SHARE_LABEL,
    });
    expect(share.label).not.toMatch(/SES account/i);
  });

  it('refuses a lane summary that is not among the lane-map summaries', () => {
    const lane = laneOf([{ bucketOffset: 1, count: 10 }]);
    expect(() => buildShareRow(lane.summary, [])).toThrow(RangeError);
  });
});

const records = (...values: string[]): DnsTxtOutcome => ({ kind: 'records', records: values });
const MISSING: DnsTxtOutcome = { kind: 'missing' };
const UNKNOWN: DnsTxtOutcome = { kind: 'unknown' };
const DMARC = 'v=DMARC1; p=none';
const SPF = 'v=spf1 include:amazonses.com ~all';

const HEALTHY: IdentityAuthFacts = {
  identity: 'example.com',
  dkimStatus: 'SUCCESS',
  dkimSigningEnabled: true,
  mailFromDomain: 'bounce.example.com',
  mailFromStatus: 'SUCCESS',
  identityType: 'DOMAIN',
};
const BROKEN: IdentityAuthFacts = { ...HEALTHY, dkimStatus: 'FAILED', mailFromStatus: 'FAILED' };
const BROKEN_ANSWERS = new Map<string, DnsTxtOutcome>([
  ['_dmarc.news.example.com', MISSING],
  ['_dmarc.example.com', MISSING],
  ['bounce.example.com', records('google-site-verification=abc')],
]);
const NO_BOUNCES = laneOf([{ bucketOffset: 1, count: 40 }]).summary.totals;

interface RowsCase {
  fromDomain?: string;
  identities?: readonly IdentityAuthFacts[];
  answers?: ReadonlyMap<string, DnsTxtOutcome> | Record<string, DnsTxtOutcome>;
  totals?: WindowSummary['totals'];
}

function configurationRows(input: RowsCase = {}): Partial<Record<ConfigurationRecord, ConfigurationRow>> {
  const answers = input.answers instanceof Map ? input.answers : new Map(Object.entries(input.answers ?? {}));
  const rows = buildConfigurationRows({
    fromDomain: input.fromDomain ?? 'news.example.com',
    identities: input.identities ?? [HEALTHY],
    txtAnswers: answers,
    totals: input.totals ?? NO_BOUNCES,
  });
  return Object.fromEntries(rows.map((row) => [row.record, row]));
}

function bouncesCarrying(...groups: [count: number, diagnosticCode: string][]): WindowSummary['totals'] {
  return laneOf([
    { bucketOffset: 2, count: 60 },
    ...groups.map(([count, diagnosticCode]): ScenarioGroup => ({ bucketOffset: 1, count, permanentBounces: count, diagnosticCode })),
  ]).summary.totals;
}

describe('the organizational domain (D-60, AC-E25)', () => {
  it('returns the registrable domain under an ICANN suffix', () => {
    expect(organizationalDomain('news.example.com')).toBe('example.com');
    expect(organizationalDomain('example.com')).toBe('example.com');
    expect(organizationalDomain('mail.example.co.uk')).toBe('example.co.uk');
  });

  it('reads an unknown TLD, a private suffix, an IP and a bare suffix as undetermined', () => {
    expect(organizationalDomain('a.example.unknowntld')).toBeUndefined();
    expect(organizationalDomain('news.github.io')).toBeUndefined();
    expect(organizationalDomain('192.0.2.1')).toBeUndefined();
    expect(organizationalDomain('co.uk')).toBeUndefined();
  });
});

describe('the identity of a from-domain (D-60)', () => {
  const identities: IdentityAuthFacts[] = [
    { identity: 'example.com' },
    { identity: 'news.example.com' },
    { identity: 'ops@example.org' },
  ];

  it('picks the exact domain identity, else the longest listed parent, label-aligned', () => {
    expect(identityFor('news.example.com', identities)?.identity).toBe('news.example.com');
    expect(identityFor('deep.news.example.com', identities)?.identity).toBe('news.example.com');
    expect(identityFor('shop.example.com', identities)?.identity).toBe('example.com');
    expect(identityFor('notexample.com', identities)).toBeUndefined();
  });

  it('considers domain identities only, never an email address identity', () => {
    expect(identityFor('example.org', identities)).toBeUndefined();
  });

  it('reads every row unknown when no identity covers the from-domain', () => {
    const rows = configurationRows({ fromDomain: 'example.org', identities, answers: { '_dmarc.example.org': records(DMARC) } });
    expect(Object.values(rows).map((row) => row.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(rows.dmarc?.lookups).toEqual([{ kind: 'ses', operation: 'GetEmailIdentity', identity: null }]);
  });
});

describe('the DKIM row', () => {
  it.each([
    ['SUCCESS', true, 'present'],
    ['FAILED', true, 'missing'],
    ['SUCCESS', false, 'missing'],
    ['NOT_STARTED', true, 'unknown'],
    ['PENDING', true, 'unknown'],
    ['TEMPORARY_FAILURE', true, 'unknown'],
    [undefined, true, 'unknown'],
  ] as const)('reads status %s with signing %s as %s', (dkimStatus, dkimSigningEnabled, state) => {
    const identity: IdentityAuthFacts = { identity: 'example.com', dkimSigningEnabled, ...(dkimStatus === undefined ? {} : { dkimStatus }) };
    expect(configurationRows({ identities: [identity] }).dkim?.state).toBe(state);
  });

  it('names its lookup as GetEmailIdentity with the identity (AC-9)', () => {
    expect(configurationRows().dkim?.lookups).toEqual([{ kind: 'ses', operation: 'GetEmailIdentity', identity: 'example.com' }]);
  });
});

describe('the MAIL FROM row', () => {
  it.each([
    ['SUCCESS', 'present'],
    ['FAILED', 'missing'],
    ['PENDING', 'unknown'],
    ['TEMPORARY_FAILURE', 'unknown'],
  ] as const)('reads a custom MAIL FROM with status %s as %s', (mailFromStatus, state) => {
    expect(configurationRows({ identities: [{ ...HEALTHY, mailFromStatus }] })['mail-from']?.state).toBe(state);
  });

  it('reads not applicable, never a cause, without a custom MAIL FROM domain', () => {
    const { mailFromDomain: _omitted, mailFromStatus: _status, ...withoutMailFrom } = BROKEN;
    const row = configurationRows({ identities: [withoutMailFrom], totals: bouncesCarrying([10, 'smtp; 550 5.7.26 multiple failed']) })['mail-from'];
    expect(row?.state).toBe('not-applicable');
    expect(row?.verdict).toBe('not-applicable');
    expect(row?.lookups).toEqual([{ kind: 'ses', operation: 'GetEmailIdentity', identity: 'example.com' }]);
  });
});

describe('the DMARC row (D-60, AC-E25, AC-E26)', () => {
  const dmarcOf = (fromDomain: string, answers: Record<string, DnsTxtOutcome>) => configurationRows({ fromDomain, answers }).dmarc;

  it('reads one record at the from-domain as present, with its lookup', () => {
    const row = dmarcOf('news.example.com', { '_dmarc.news.example.com': records(DMARC) });
    expect(row?.state).toBe('present');
    expect(row?.lookups).toEqual([{ kind: 'dns', name: '_dmarc.news.example.com', recordType: 'TXT', outcome: 'records' }]);
  });

  it('reads a subdomain with no record of its own under an organizational domain that has one as present', () => {
    const row = dmarcOf('news.example.com', { '_dmarc.news.example.com': MISSING, '_dmarc.example.com': records(DMARC) });
    expect(row?.state).toBe('present');
    expect(row?.lookups.map((lookup) => (lookup.kind === 'dns' ? `${lookup.name}:${lookup.outcome}` : lookup.kind))).toEqual([
      '_dmarc.news.example.com:missing',
      '_dmarc.example.com:records',
    ]);
  });

  it('reads missing at the organizational domain itself and one label below it', () => {
    expect(dmarcOf('example.com', { '_dmarc.example.com': MISSING })?.state).toBe('missing');
    expect(dmarcOf('news.example.com', { '_dmarc.news.example.com': records('unrelated'), '_dmarc.example.com': MISSING })?.state).toBe('missing');
  });

  it('reads a deep subdomain unknown when neither lookup finds a record (AI-SPEC 1b-1)', () => {
    expect(dmarcOf('a.b.example.com', { '_dmarc.a.b.example.com': MISSING, '_dmarc.example.com': MISSING })?.state).toBe('unknown');
  });

  it('reads two DMARC records at one name as unknown', () => {
    expect(dmarcOf('news.example.com', { '_dmarc.news.example.com': records(DMARC, 'v=DMARC1; p=reject') })?.state).toBe('unknown');
    expect(dmarcOf('news.example.com', { '_dmarc.news.example.com': MISSING, '_dmarc.example.com': records(DMARC, DMARC) })?.state).toBe('unknown');
  });

  it('reads an unknown DNS outcome as unknown, never missing (AC-E26)', () => {
    expect(dmarcOf('news.example.com', { '_dmarc.news.example.com': UNKNOWN })?.state).toBe('unknown');
    expect(dmarcOf('news.example.com', { '_dmarc.news.example.com': MISSING, '_dmarc.example.com': UNKNOWN })?.state).toBe('unknown');
    expect(dmarcOf('news.example.com', {})?.state).toBe('unknown');
  });

  it('reads an organizational domain tldts cannot determine as unknown (AC-E25)', () => {
    expect(dmarcOf('news.example.unknowntld', { '_dmarc.news.example.unknowntld': MISSING })?.state).toBe('unknown');
  });
});

describe('the SPF row', () => {
  const spfOf = (answer: DnsTxtOutcome | undefined) =>
    configurationRows({ answers: answer === undefined ? {} : { 'bounce.example.com': answer } }).spf;

  it('reads one v=spf1 record on the MAIL FROM domain as present, with its lookup', () => {
    const row = spfOf(records(SPF, 'unrelated'));
    expect(row?.state).toBe('present');
    expect(row?.lookups).toEqual([{ kind: 'dns', name: 'bounce.example.com', recordType: 'TXT', outcome: 'records' }]);
  });

  it('reads none as missing, two as unknown and an unknown outcome as unknown', () => {
    expect(spfOf(MISSING)?.state).toBe('missing');
    expect(spfOf(records('unrelated'))?.state).toBe('missing');
    expect(spfOf(records(SPF, 'v=spf1 -all'))?.state).toBe('unknown');
    expect(spfOf(UNKNOWN)?.state).toBe('unknown');
    expect(spfOf(undefined)?.state).toBe('unknown');
  });

  it('reads not applicable without a custom MAIL FROM domain', () => {
    const { mailFromDomain: _omitted, ...withoutMailFrom } = HEALTHY;
    expect(configurationRows({ identities: [withoutMailFrom] }).spf?.state).toBe('not-applicable');
  });
});

describe('configuration verdicts (D-61 as amended 2026-10-12)', () => {
  const verdictsWith = (totals: WindowSummary['totals']) =>
    Object.fromEntries(Object.entries(configurationRows({ identities: [BROKEN], answers: BROKEN_ANSWERS, totals })).map(([record, row]) => [record, row.verdict]));

  it('reads present as ruled out and a missing record without corroboration as elevated', () => {
    expect(configurationRows({ answers: { '_dmarc.news.example.com': records(DMARC) } }).dmarc?.verdict).toBe('ruled-out');
    expect(verdictsWith(NO_BOUNCES)).toEqual({ dkim: 'elevated', 'mail-from': 'elevated', dmarc: 'elevated', spf: 'elevated' });
  });

  it('reads the missing DMARC row elevated when every bounce is a 5.7.1 spam block (AI-SPEC 1b-2)', () => {
    expect(verdictsWith(bouncesCarrying([10, 'smtp; 550 5.7.1 message blocked as spam'])).dmarc).toBe('elevated');
  });

  it('reads the same missing DMARC row as cause when every bounce is a 5.7.26', () => {
    expect(verdictsWith(bouncesCarrying([10, 'smtp; 550 5.7.26 multiple authentication checks failed'])).dmarc).toBe('cause');
  });

  it('corroborates no row with 5.7.25 bounces', () => {
    expect(verdictsWith(bouncesCarrying([10, 'smtp; 550 5.7.25 reverse DNS validation failed']))).toEqual({
      dkim: 'elevated',
      'mail-from': 'elevated',
      dmarc: 'elevated',
      spf: 'elevated',
    });
  });

  it('lets a 5.7.23 majority corroborate SPF and MAIL FROM only', () => {
    expect(verdictsWith(bouncesCarrying([10, 'smtp; 550 5.7.23 SPF validation failed']))).toEqual({
      dkim: 'elevated',
      'mail-from': 'cause',
      dmarc: 'elevated',
      spf: 'cause',
    });
  });

  it('lets a 5.7.22 majority corroborate DKIM and DMARC only', () => {
    expect(verdictsWith(bouncesCarrying([10, 'smtp; 550 5.7.22 no author-matched DKIM signature']))).toEqual({
      dkim: 'cause',
      'mail-from': 'elevated',
      dmarc: 'cause',
      spf: 'elevated',
    });
  });

  it('needs half of the counted permanent bounces and at least 3 of them', () => {
    const auth = 'smtp; 550 5.7.26 multiple authentication checks failed';
    const other = 'smtp; 550 5.1.1 user unknown';
    expect(verdictsWith(bouncesCarrying([3, auth], [3, other])).dmarc).toBe('cause');
    expect(verdictsWith(bouncesCarrying([2, auth], [4, other])).dmarc).toBe('elevated');
    expect(verdictsWith(bouncesCarrying([2, auth])).dmarc).toBe('elevated');
    expect(configurationRows({ identities: [BROKEN], answers: BROKEN_ANSWERS, totals: bouncesCarrying([3, auth], [3, other]) }).dmarc?.corroboration).toEqual({
      corroboratingBounces: 3,
      permanentBounces: 6,
    });
  });

  it('never lets complaints corroborate an authentication cause', () => {
    const complaints = laneOf([{ bucketOffset: 1, count: 100, complaints: 20 }]).summary.totals;
    expect(verdictsWith(complaints)).toEqual({ dkim: 'elevated', 'mail-from': 'elevated', dmarc: 'elevated', spf: 'elevated' });
  });

  it('builds rows the evidence record schema accepts', () => {
    const rows = buildConfigurationRows({ fromDomain: 'news.example.com', identities: [BROKEN], txtAnswers: BROKEN_ANSWERS, totals: NO_BOUNCES });
    expect(rows).toHaveLength(4);
    expect(evidenceRecordSchema.shape.configurationRows.safeParse(rows).success).toBe(true);
  });
});

describe('no unknown DNS outcome ever reads missing (T-02-16)', () => {
  const outcomeArb = fc.oneof(
    fc.constant(MISSING),
    fc.constant(UNKNOWN),
    fc.subarray([DMARC, SPF, 'v=DMARC1; p=reject', 'unrelated']).map((values) => records(...values)),
  );

  it('keeps every row stating missing free of unknown DNS lookups', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('example.com', 'news.example.com', 'a.b.example.com', 'news.example.unknowntld'),
        fc.dictionary(fc.constantFrom('_dmarc.example.com', '_dmarc.news.example.com', '_dmarc.a.b.example.com', 'bounce.example.com'), outcomeArb),
        fc.option(fc.constantFrom('SUCCESS', 'FAILED', 'PENDING'), { nil: undefined }),
        (fromDomain, answers, mailFromStatus) => {
          const identity: IdentityAuthFacts = { ...HEALTHY, ...(mailFromStatus === undefined ? {} : { mailFromStatus }) };
          const rows = buildConfigurationRows({ fromDomain, identities: [identity], txtAnswers: new Map(Object.entries(answers)), totals: NO_BOUNCES });
          for (const row of rows) {
            if (row.state !== 'missing') continue;
            for (const lookup of row.lookups) if (lookup.kind === 'dns') expect(lookup.outcome).not.toBe('unknown');
          }
        },
      ),
      { seed: propertySeed() },
    );
  });
});

describe('a lane with no usable from-domain (AC-E24)', () => {
  it('yields no configuration rows and plans no TXT lookup when the from-domain is absent or unclassified', () => {
    const tagged = recordsOf([{ bucketOffset: 1, count: 120, permanentBounces: 10, diagnosticCode: 'smtp; 550 5.7.26 failed' }]);
    const absent = tagged.map((record) => {
      const { fromDomain: _dropped, ...fields } = record.fields;
      return { ...record, fields };
    });
    const unclassified = tagged.map((record) => ({ ...record, fields: { ...record.fields, fromDomain: 'unclassified' } }));
    expect(configurationFromDomains(summaryOf(tagged))).toEqual(['news.example.com']);
    for (const lane of [absent, unclassified]) {
      const summary = summaryOf(lane);
      expect(configurationFromDomains(summary)).toEqual([]);
      expect(buildLaneConfigurationRows({ summary, identities: [BROKEN], txtAnswers: BROKEN_ANSWERS })).toEqual([]);
      expect(planDnsLookups(configurationFromDomains(summary), [BROKEN], []).lookups).toEqual([]);
    }
  });

  it('builds the four rows of each from-domain the lane sends from', () => {
    const summary = summaryOf(recordsOf([{ bucketOffset: 1, count: 40 }]));
    const rows = buildLaneConfigurationRows({ summary, identities: [BROKEN], txtAnswers: BROKEN_ANSWERS });
    expect(rows.map((row) => `${row.fromDomain}:${row.record}`)).toEqual([
      'news.example.com:dkim',
      'news.example.com:mail-from',
      'news.example.com:dmarc',
      'news.example.com:spf',
    ]);
  });
});

describe('the DNS lookup plan and its bound (D-58)', () => {
  it('lists the worst-case lookups before any runs: both DMARC names, the SPF name and one MX per domain', () => {
    expect(planDnsLookups(['news.example.com', 'shop.example.com'], [HEALTHY], ['example.org'])).toEqual({
      lookups: [
        { name: '_dmarc.news.example.com', recordType: 'TXT' },
        { name: '_dmarc.example.com', recordType: 'TXT' },
        { name: 'bounce.example.com', recordType: 'TXT' },
        { name: '_dmarc.shop.example.com', recordType: 'TXT' },
        { name: 'example.org', recordType: 'MX' },
      ],
      bound: null,
    });
  });

  it('plans no SPF name without a custom MAIL FROM and nothing for a from-domain with no identity', () => {
    const { mailFromDomain: _omitted, ...withoutMailFrom } = HEALTHY;
    expect(planDnsLookups(['example.com'], [withoutMailFrom], []).lookups).toEqual([{ name: '_dmarc.example.com', recordType: 'TXT' }]);
    expect(planDnsLookups(['example.org'], [HEALTHY], []).lookups).toEqual([]);
  });

  it('reports dns-bound past MAX_DNS_LOOKUPS_PER_CYCLE and not at it', () => {
    const domains = (count: number) => Array.from({ length: count }, (_, index) => `d${index}.example.org`);
    expect(MAX_DNS_LOOKUPS_PER_CYCLE).toBe(200);
    expect(DNS_LOOKUP_CONCURRENCY).toBe(10);
    expect(planDnsLookups([], [], domains(MAX_DNS_LOOKUPS_PER_CYCLE)).bound).toBeNull();
    expect(planDnsLookups([], [], domains(MAX_DNS_LOOKUPS_PER_CYCLE + 1)).bound).toBe('dns-bound');
  });
});
