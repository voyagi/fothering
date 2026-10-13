import { describe, expect, it } from 'vitest';
import { canonicalJson } from './evidence-record.js';
import {
  PROVIDER_MAPPING,
  ROW_LIMIT,
  SIMULATOR_DOMAIN,
  buildProviderRows,
  buildShareRow,
  buildTagRows,
  countableEventsOf,
  providerOf,
  receivingDomainsNeedingMx,
  type DnsMxOutcome,
  type EvidenceRow,
  type TagDimension,
} from './evidence-rows.js';
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
