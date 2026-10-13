import type { CloseabilityResult, RefusalReason } from './closeability.js';
import type { ISOLATION_VERDICTS, SHARED_CAUSE_KINDS } from './evidence-record.js';
import { rowVerdict, type ConfigurationRow, type EvidenceRow, type RowDimension, type TagDimension } from './evidence-rows.js';
import { findLane, type LaneEntry, type LaneMap } from './lanes.js';
import type { CoverageVerdict, LaneSpikeVerdict } from './verdicts.js';
import type { DimensionTally, WindowSummary } from './window-fold.js';

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

export type IsolationVerdict = (typeof ISOLATION_VERDICTS)[number];

export interface SharedCause {
  kind: (typeof SHARED_CAUSE_KINDS)[number];
  value: string;
  lanes: string[];
}

export interface DecideLaneInput {
  spike: LaneSpikeVerdict;
  rows: readonly EvidenceRow[];
  configurationRows: readonly ConfigurationRow[];
  closeability: CloseabilityResult;
  coverageNoData: boolean;
  bound: ReadBound | null;
  otherSpikingLanes: readonly string[];
  sharedCause?: SharedCause | null;
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
// decision 5). The configuration rows count as one dimension, so two authentication causes read
// unsettled while a batch cause beside one of them stays settled and lane-scoping then decides.
function causeIsSettled(rows: readonly EvidenceRow[], configurationRows: readonly ConfigurationRow[]): boolean {
  const causesPerDimension = new Map<string, number>();
  const count = (dimension: string): void => {
    causesPerDimension.set(dimension, (causesPerDimension.get(dimension) ?? 0) + 1);
  };
  for (const row of rows) if (row.verdict === 'cause') count(row.dimension);
  for (const row of configurationRows) if (row.verdict === 'cause') count('configuration');
  return causesPerDimension.size > 0 && [...causesPerDimension.values()].every((causes) => causes === 1);
}

interface PrecedenceFacts {
  noData: boolean;
  closeabilityState: CloseabilityResult['state'];
  bound: ReadBound | null;
  settled: boolean;
  sharedCause: SharedCause | null;
  otherSpikingLanes: readonly string[];
}

/** D-62: the first matching rule decides, NO DATA first as phase 1 locked. A shared cause outranks
 * spread because it carries a concrete fix, and approval needs a closeable result after all of it. */
function precedence(facts: PrecedenceFacts): { outcome: DecisionOutcome; reason: DecisionReason } {
  if (facts.noData || facts.closeabilityState === 'no-data') return { outcome: 'unknown', reason: 'no-data' };
  if (facts.bound !== null) return { outcome: 'unknown', reason: facts.bound };
  if (!facts.settled) return { outcome: 'unknown', reason: 'not-settled' };
  if (facts.sharedCause !== null) return { outcome: 'refused', reason: 'not-lane-scoped' };
  if (facts.otherSpikingLanes.length > 0) return { outcome: 'unknown', reason: 'spread' };
  if (facts.closeabilityState !== 'closeable') return { outcome: 'unknown', reason: 'not-closeable' };
  return { outcome: 'approved', reason: 'approved' };
}

export function decideLane(input: DecideLaneInput): LaneDecision {
  const decided = precedence({
    noData: input.coverageNoData,
    closeabilityState: input.closeability.state,
    bound: input.bound,
    settled: causeIsSettled(input.rows, input.configurationRows),
    sharedCause: input.sharedCause ?? null,
    otherSpikingLanes: input.otherSpikingLanes,
  });
  return { ...decided, closeability: closeabilityOf(input.closeability) };
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

const TAG_DIMENSIONS: readonly TagDimension[] = ['batch', 'template', 'campaign'];

function setOf(analysis: LaneAnalysis): string {
  return analysis.lane.configurationSet;
}

function otherLanes(analysis: LaneAnalysis, cycle: readonly LaneAnalysis[]): LaneAnalysis[] {
  return cycle.filter((other) => setOf(other) !== setOf(analysis));
}

function causeValues(analysis: LaneAnalysis, dimension: RowDimension): string[] {
  return analysis.rows
    .filter((row) => row.dimension === dimension && row.kind === 'value' && row.verdict === 'cause')
    .flatMap((row) => (row.value === null ? [] : [row.value]));
}

interface CauseCandidate {
  kind: SharedCause['kind'];
  value: string;
  sharedOn: (other: LaneAnalysis) => boolean;
}

// Judged with the spiking lane's own triggers over the other lane's totals: cause or elevated there
// means at or above a threshold with the row minimum, which is D-63's test for a shared value.
function overThresholdOn(other: LaneAnalysis, tally: DimensionTally | undefined, analysis: LaneAnalysis): boolean {
  if (tally === undefined) return false;
  const verdict = rowVerdict(tally, other.summary.totals, analysis.spike.triggers);
  return verdict === 'cause' || verdict === 'elevated';
}

// Provider tallies come from the other lane's own provider rows, built with the cycle's MX answers;
// tag tallies come from its fold, which keeps every value where the rows keep only ROW_LIMIT of them.
function providerTally(other: LaneAnalysis, provider: string): DimensionTally | undefined {
  return other.rows.find((row) => row.dimension === 'provider' && row.kind === 'value' && row.value === provider);
}

function sendsFrom(other: LaneAnalysis, fromDomain: string): boolean {
  for (const domain of other.summary.dimensions.fromDomain.keys()) if (domain.toLowerCase() === fromDomain) return true;
  return false;
}

// Domain, then provider, then tag values: the order both the isolation verdict and the shared cause
// report in, so the fix a refused lane carries names the cause its isolation verdict names.
function causeCandidates(analysis: LaneAnalysis): CauseCandidate[] {
  const authentication = analysis.configurationRows
    .filter((row) => row.verdict === 'cause')
    .map((row): CauseCandidate => ({ kind: 'from-domain', value: row.fromDomain, sharedOn: (other) => sendsFrom(other, row.fromDomain) }));
  const providers = causeValues(analysis, 'provider').map(
    (value): CauseCandidate => ({ kind: 'provider', value, sharedOn: (other) => overThresholdOn(other, providerTally(other, value), analysis) }),
  );
  const tags = TAG_DIMENSIONS.flatMap((dimension) =>
    causeValues(analysis, dimension).map(
      (value): CauseCandidate => ({
        kind: dimension,
        value,
        sharedOn: (other) => overThresholdOn(other, other.summary.dimensions[dimension].get(value), analysis),
      }),
    ),
  );
  return [...authentication, ...providers, ...tags];
}

function sharedCauseOf(analysis: LaneAnalysis, cycle: readonly LaneAnalysis[]): SharedCause | null {
  const others = otherLanes(analysis, cycle);
  for (const candidate of causeCandidates(analysis)) {
    const sharing = others.filter(candidate.sharedOn).map(setOf);
    if (sharing.length > 0) return { kind: candidate.kind, value: candidate.value, lanes: [setOf(analysis), ...sharing].sort() };
  }
  return null;
}

function isSpiking(analysis: LaneAnalysis): boolean {
  return analysis.spike.verdict === 'spike';
}

/** D-63, computed apart from the cause: when several spread conditions hold, domain, then provider,
 * then account is reported. `cycle` is every lane analysed in the cycle; the lane itself is skipped. */
export function isolationVerdict(analysis: LaneAnalysis, cycle: readonly LaneAnalysis[]): IsolationVerdict {
  const others = otherLanes(analysis, cycle);
  const sharedKinds = new Set(causeCandidates(analysis).filter((candidate) => others.some(candidate.sharedOn)).map((candidate) => candidate.kind));
  if (sharedKinds.has('from-domain')) return 'spread-domain';
  if (sharedKinds.has('provider')) return 'spread-provider';
  if (others.some(isSpiking) || TAG_DIMENSIONS.some((dimension) => sharedKinds.has(dimension))) return 'spread-account';
  return 'confined';
}

/** One decision per spiking lane, keyed and ordered by configuration set, so neither the lane map's
 * order nor the order of the analyses can change what is decided (SPEC R7). */
export function decideCycle(analyses: readonly LaneAnalysis[], laneMap: LaneMap): ReadonlyMap<string, CycleDecision> {
  for (const analysis of analyses) {
    if (findLane(laneMap, setOf(analysis)) === undefined) {
      throw new RangeError(`configuration set ${setOf(analysis)} is not in the lane map, so no decision can be made for it`);
    }
  }
  const spiking = analyses.filter(isSpiking);
  const decided = spiking.map((analysis): [string, CycleDecision] => {
    const otherSpikingLanes = otherLanes(analysis, spiking).map(setOf).sort();
    const sharedCause = sharedCauseOf(analysis, analyses);
    const decision = decideLane({
      spike: analysis.spike,
      rows: analysis.rows,
      configurationRows: analysis.configurationRows,
      closeability: analysis.closeability,
      coverageNoData: analysis.coverage === 'no-data',
      bound: analysis.bound,
      otherSpikingLanes,
      sharedCause,
    });
    return [
      setOf(analysis),
      {
        ...decision,
        isolation: isolationVerdict(analysis, analyses),
        noData: analysis.closeability.state === 'no-data' || analysis.coverage === 'no-data',
        bound: analysis.bound,
        otherSpikingLanes,
        sharedCause,
      },
    ];
  });
  return new Map(decided.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}
