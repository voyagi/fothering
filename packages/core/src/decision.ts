import type { CloseabilityResult, RefusalReason } from './closeability.js';
import type { ISOLATION_VERDICTS, SHARED_CAUSE_KINDS } from './evidence-record.js';
import type { ConfigurationRow, EvidenceRow } from './evidence-rows.js';
import type { LaneEntry, LaneMap } from './lanes.js';
import type { CoverageVerdict, LaneSpikeVerdict } from './verdicts.js';
import type { WindowSummary } from './window-fold.js';

export const DECISION_OUTCOMES = ['approved', 'unknown', 'refused'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

// D-62's unknown reasons, D-46's dimension bound and D-70's size ceiling, in one closed vocabulary.
export const DECISION_REASONS = [
  'approved',
  'no-data',
  'ses-facts-bound',
  'dns-bound',
  'dimension-bound',
  'not-settled',
  'not-lane-scoped',
  'spread',
  'not-closeable',
  'record-too-large',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export const READ_BOUNDS = ['ses-facts-bound', 'dns-bound', 'dimension-bound'] as const;
export type ReadBound = (typeof READ_BOUNDS)[number];

export interface DecisionCloseability {
  state: CloseabilityResult['state'];
  reasons: RefusalReason[];
}

export interface DecideLaneInput {
  spike: LaneSpikeVerdict;
  rows: readonly EvidenceRow[];
  configurationRows: readonly ConfigurationRow[];
  closeability: CloseabilityResult;
  coverageNoData: boolean;
  bound: ReadBound | null;
  otherSpikingLanes: readonly string[];
}

export interface LaneDecision {
  outcome: DecisionOutcome;
  reason: DecisionReason;
  closeability: DecisionCloseability;
}

function closeabilityOf(result: CloseabilityResult): DecisionCloseability {
  return { state: result.state, reasons: result.state === 'refused' ? [...result.reasons] : [] };
}

// A cause is settled when at least one row reads cause and no dimension holds two of them: two bad
// batches on one lane read unknown and name both rather than closing on a guess (START panel
// decision 5). Each configuration record counts as its own dimension.
function causeIsSettled(input: DecideLaneInput): boolean {
  const causesPerDimension = new Map<string, number>();
  const count = (dimension: string): void => {
    causesPerDimension.set(dimension, (causesPerDimension.get(dimension) ?? 0) + 1);
  };
  for (const row of input.rows) if (row.verdict === 'cause') count(row.dimension);
  for (const row of input.configurationRows) if (row.verdict === 'cause') count(`configuration:${row.record}`);
  return causesPerDimension.size > 0 && [...causesPerDimension.values()].every((causes) => causes === 1);
}

/** The first matching rule decides (D-62); NO DATA stays first, as phase 1 locked. */
export function decideLane(input: DecideLaneInput): LaneDecision {
  const closeability = closeabilityOf(input.closeability);
  const decide = (outcome: DecisionOutcome, reason: DecisionReason): LaneDecision => ({ outcome, reason, closeability });
  if (input.closeability.state === 'no-data' || input.coverageNoData) return decide('unknown', 'no-data');
  if (input.bound !== null) return decide('unknown', input.bound);
  if (!causeIsSettled(input)) return decide('unknown', 'not-settled');
  if (input.closeability.state === 'refused') return decide('unknown', 'not-closeable');
  return decide('approved', 'approved');
}

export type IsolationVerdict = (typeof ISOLATION_VERDICTS)[number];

export interface SharedCause {
  kind: (typeof SHARED_CAUSE_KINDS)[number];
  value: string;
  lanes: string[];
}

export interface LaneAnalysis {
  lane: LaneEntry;
  summary: WindowSummary;
  spike: LaneSpikeVerdict;
  rows: readonly EvidenceRow[];
  configurationRows: readonly ConfigurationRow[];
  closeability: CloseabilityResult;
  coverage: CoverageVerdict;
  bound: ReadBound | null;
}

export interface CycleDecision extends LaneDecision {
  isolation: IsolationVerdict;
  noData: boolean;
  bound: ReadBound | null;
  otherSpikingLanes: string[];
  sharedCause: SharedCause | null;
}

export function isolationVerdict(_analysis: LaneAnalysis, _cycle: readonly LaneAnalysis[]): IsolationVerdict {
  return 'confined';
}

export function decideCycle(_analyses: readonly LaneAnalysis[], _laneMap: LaneMap): ReadonlyMap<string, CycleDecision> {
  return new Map();
}
