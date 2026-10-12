import {
  LANE_MIN_RECIPIENT_SENDS,
  MIN_RATIO_EVENTS,
  ROW_MIN_RECIPIENT_SENDS,
  THRESHOLD_BY_TRIGGER,
  ratioAtOrAbove,
  renderPercent,
  type LaneSpikeVerdict,
  type LaneTotals,
  type LaneTrigger,
} from './verdicts.js';
import type { ConfigurationRecord, DimensionTally, WindowSummary } from './window-fold.js';

export const ROW_VERDICTS = ['cause', 'elevated', 'ruled-out', 'not-enough-volume'] as const;
export type RowVerdict = (typeof ROW_VERDICTS)[number];

export const ROW_DIMENSIONS = ['batch', 'template', 'campaign', 'provider'] as const;
export type RowDimension = (typeof ROW_DIMENSIONS)[number];
export type TagDimension = Exclude<RowDimension, 'provider'>;

export const ROW_KINDS = ['value', 'no-value', 'other'] as const;
export type RowKind = (typeof ROW_KINDS)[number];

export interface AppliedThreshold {
  ratio: LaneTrigger;
  numerator: number;
  denominator: number;
  minEvents: number;
  minSends: number;
}

export interface EvidenceRow {
  dimension: RowDimension;
  kind: RowKind;
  value: string | null;
  sends: number;
  permanentBounces: number;
  complaints: number;
  hardBounceRatio: string | null;
  complaintRatio: string | null;
  sharePercent: string | null;
  verdict: RowVerdict;
  thresholds: AppliedThreshold[];
  fromBucketMs: number;
  toBucketMs: number;
}

export const CONFIGURATION_STATES = ['present', 'missing', 'unknown', 'not-applicable'] as const;
export const CONFIGURATION_VERDICTS = ['cause', 'elevated', 'ruled-out', 'unknown', 'not-applicable'] as const;

export type ConfigurationLookup =
  | { kind: 'ses'; operation: 'GetEmailIdentity'; identity: string | null }
  | { kind: 'dns'; name: string; recordType: 'TXT' | 'MX'; outcome: 'records' | 'missing' | 'unknown' };

export interface ConfigurationRow {
  fromDomain: string;
  record: ConfigurationRecord;
  state: (typeof CONFIGURATION_STATES)[number];
  verdict: (typeof CONFIGURATION_VERDICTS)[number];
  lookups: ConfigurationLookup[];
  corroboration: { corroboratingBounces: number; permanentBounces: number };
}

// Strongest first: a row reports the strongest verdict any trigger gives it (D-56).
const VERDICT_STRENGTH: readonly RowVerdict[] = ['cause', 'elevated', 'ruled-out', 'not-enough-volume'];

const COUNT_BY_TRIGGER: Readonly<Record<LaneTrigger, 'permanentBounces' | 'complaints'>> = {
  'hard-bounce': 'permanentBounces',
  complaint: 'complaints',
};

function verdictForTrigger(row: DimensionTally, lane: LaneTotals, trigger: LaneTrigger): RowVerdict {
  const field = COUNT_BY_TRIGGER[trigger];
  const threshold = THRESHOLD_BY_TRIGGER[trigger];
  if (!ratioAtOrAbove(row[field], row.sends, threshold)) return 'ruled-out';
  const remainderSends = lane.recipientSends - row.sends;
  // D-50: a remainder under the lane minimum cannot read a spike on its own, so it counts as below.
  const laneStillAtOrAbove =
    remainderSends >= LANE_MIN_RECIPIENT_SENDS && ratioAtOrAbove(lane[field] - row[field], remainderSends, threshold);
  return laneStillAtOrAbove ? 'elevated' : 'cause';
}

export function rowVerdict(row: DimensionTally, laneTotals: LaneTotals, triggers: readonly LaneTrigger[]): RowVerdict {
  if (row.sends < ROW_MIN_RECIPIENT_SENDS) return 'not-enough-volume';
  let strongest: RowVerdict = 'ruled-out';
  for (const trigger of triggers) {
    const verdict = verdictForTrigger(row, laneTotals, trigger);
    if (VERDICT_STRENGTH.indexOf(verdict) < VERDICT_STRENGTH.indexOf(strongest)) strongest = verdict;
  }
  return strongest;
}

function appliedThresholds(triggers: readonly LaneTrigger[]): AppliedThreshold[] {
  return triggers.map((ratio) => ({
    ratio,
    numerator: THRESHOLD_BY_TRIGGER[ratio].numerator,
    denominator: THRESHOLD_BY_TRIGGER[ratio].denominator,
    minEvents: MIN_RATIO_EVENTS,
    minSends: ROW_MIN_RECIPIENT_SENDS,
  }));
}

function compareValueBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** One row per tracked value of a tag dimension, largest by sends first and then by value bytes, so
 * two runs over the same records serialize identically (AC-E19). */
export function buildTagRows(dimension: TagDimension, summary: WindowSummary, spike: LaneSpikeVerdict): EvidenceRow[] {
  const lane: LaneTotals = summary.totals;
  const thresholds = appliedThresholds(spike.triggers);
  return [...summary.dimensions[dimension]]
    .sort(([leftValue, left], [rightValue, right]) => right.sends - left.sends || compareValueBytes(leftValue, rightValue))
    .map(([value, tally]) => ({
      dimension,
      kind: 'value',
      value,
      sends: tally.sends,
      permanentBounces: tally.permanentBounces,
      complaints: tally.complaints,
      hardBounceRatio: renderPercent(tally.permanentBounces, tally.sends),
      complaintRatio: renderPercent(tally.complaints, tally.sends),
      sharePercent: renderPercent(tally.sends, lane.recipientSends),
      verdict: rowVerdict(tally, lane, spike.triggers),
      thresholds: thresholds.map((threshold) => ({ ...threshold })),
      fromBucketMs: summary.window.fromBucketMs,
      toBucketMs: summary.window.toBucketMs,
    }));
}
