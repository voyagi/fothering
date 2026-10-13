import type { CloseabilityResult, RefusalReason } from './closeability.js';
import {
  RECORD_BYTE_CEILING,
  buildEvidenceRecord,
  serializedRecordBytes,
  type DECISION_OUTCOMES,
  type DECISION_REASONS,
  type EvidenceRecord,
  type EvidenceRecordInput,
  type FIX_KINDS,
  type ISOLATION_VERDICTS,
  type READ_BOUNDS,
  type SHARED_CAUSE_KINDS,
} from './evidence-record.js';
import {
  buildShareRow,
  rowVerdict,
  type ConfigurationRow,
  type EvidenceRow,
  type RowDimension,
  type TagDimension,
} from './evidence-rows.js';
import { findLane, type LaneEntry, type LaneMap } from './lanes.js';
import { LANE_RATIO_LABELS, type CoverageVerdict, type LaneSpikeVerdict } from './verdicts.js';
import type { ConfigurationRecord, DimensionTally, WindowSummary } from './window-fold.js';

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type DecisionReason = (typeof DECISION_REASONS)[number];
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
  configurationSet: string;
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
        configurationSet: setOf(analysis),
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

export type FixKind = (typeof FIX_KINDS)[number];

export interface FixValues {
  'shared-tag-value': { dimension: TagDimension; value: string; lanes: readonly string[] };
  'shared-provider': { provider: string; lanes: readonly string[] };
  'missing-dkim': { fromDomain: string; identity: string };
  'failed-mail-from': { fromDomain: string; identity: string; mailFromDomain: string };
  'missing-dmarc': { fromDomain: string };
  'missing-spf': { fromDomain: string; mailFromDomain: string };
}

// The schema holds question and fix text to 1,000 printable ASCII characters (D-64).
const TEXT_LIMIT = 1_000;
const LANE_LIST_BUDGET = 400;

// Every value a template fills is already printable ASCII (set names, tag values, mapping names,
// reason names, hostnames), so cutting at the limit keeps the text valid; only extreme lengths reach it.
function capped(text: string): string {
  return text.length <= TEXT_LIMIT ? text : text.slice(0, TEXT_LIMIT);
}

// No count is written for what is left out: a number in code-written text that the evidence table
// does not hold would teach the model to repeat one.
function listWithin(items: readonly string[], budget: number, noun: string): string {
  const all = items.join(', ');
  if (all.length <= budget) return all;
  const more = `, and other ${noun}`;
  let kept = '';
  for (const item of items) {
    const next = kept === '' ? item : `${kept}, ${item}`;
    if (next.length + more.length > budget) break;
    kept = next;
  }
  return kept === '' ? `several ${noun}` : `${kept}${more}`;
}

const NOT_A_LANE_FIX = 'pausing one lane would not fix it, because';

const FIX_TEMPLATES: { [K in FixKind]: (values: FixValues[K]) => string } = {
  'shared-tag-value': ({ dimension, value, lanes }) =>
    `The ${dimension} ${value} is at or above a Fothering lane threshold on ${listWithin(lanes, LANE_LIST_BUDGET, 'lanes')}. ` +
    `Pausing one lane would not stop it. Hold that ${dimension} on every lane and check its addresses and content before it is sent again.`,
  'shared-provider': ({ provider, lanes }) =>
    `Mail to ${provider} is at or above a Fothering lane threshold on ${listWithin(lanes, LANE_LIST_BUDGET, 'lanes')}. ` +
    `Pausing one lane would not stop it. Check what ${provider} reports about the sending domains before sending it more mail from any lane.`,
  'missing-dkim': ({ fromDomain, identity }) =>
    `DKIM for ${fromDomain} reads missing on the SES identity ${identity} (GetEmailIdentity). Publish the DKIM records SES lists for ` +
    `${identity} and make sure signing is enabled; ${NOT_A_LANE_FIX} ${fromDomain} sends on other lanes as well.`,
  'failed-mail-from': ({ fromDomain, identity, mailFromDomain }) =>
    `The custom MAIL FROM domain ${mailFromDomain} of the SES identity ${identity} reads failed (GetEmailIdentity), and ${fromDomain} ` +
    `sends through it. Publish the MX record SES lists for ${mailFromDomain}; ${NOT_A_LANE_FIX} ${fromDomain} sends on other lanes as well.`,
  'missing-dmarc': ({ fromDomain }) =>
    `No DMARC record was found at _dmarc.${fromDomain}, and at least half of this lane's permanent bounces carry ` +
    `authentication-failure enhanced status codes. Publish a DMARC record at _dmarc.${fromDomain}; ${NOT_A_LANE_FIX} ${fromDomain} ` +
    'sends on other lanes as well.',
  'missing-spf': ({ fromDomain, mailFromDomain }) =>
    `No SPF TXT record was found at ${mailFromDomain}, the custom MAIL FROM domain ${fromDomain} sends through. Publish one that ` +
    `authorizes SES; ${NOT_A_LANE_FIX} ${fromDomain} sends on other lanes as well.`,
};

/** One code template per cause kind, filled only with closed values (D-64). The DMARC sentence names
 * no status code or RFC number, so a model that copies it still passes the explanation's number check. */
export function fixFor<K extends FixKind>(kind: K, values: FixValues[K]): { kind: K; text: string } {
  return { kind, text: capped(FIX_TEMPLATES[kind](values)) };
}

const RECORD_LABEL: Readonly<Record<ConfigurationRecord, string>> = { dkim: 'DKIM', 'mail-from': 'MAIL FROM', dmarc: 'DMARC', spf: 'SPF' };

function rowPhrase(row: EvidenceRow): string {
  if (row.kind === 'value') return `${row.dimension} ${row.value ?? ''}`;
  if (row.kind === 'no-value') return `${row.dimension} with no value`;
  return row.dimension === 'provider' ? 'other providers' : `other ${row.dimension} values`;
}

function findingsOf(analysis: LaneAnalysis): string[] {
  const found = (verdict: string): boolean => verdict === 'cause' || verdict === 'elevated';
  return [
    ...analysis.rows.filter((row) => found(row.verdict)).map((row) => `${row.verdict} ${rowPhrase(row)}`),
    ...analysis.configurationRows.filter((row) => found(row.verdict)).map((row) => `${row.verdict} ${RECORD_LABEL[row.record]} of ${row.fromDomain}`),
  ];
}

function refusalsOf(closeability: CloseabilityResult): string {
  if (closeability.state === 'refused') return closeability.reasons.join(', ');
  return closeability.state === 'no-data' ? 'no data' : 'none';
}

const QUESTION_CLOSE = 'Which lane, if any, should be paused?';

/**
 * Names the decided lane and every other spiking lane by its lane-map set name as committed (AC-E28),
 * with the rows code found cause or elevated and the lane's closeability refusals. The lane names and
 * refusals always fit; the rows share what is left of the limit.
 */
export function questionFor(decision: CycleDecision, analyses: readonly LaneAnalysis[]): string {
  const opening = `Fothering decided unknown for ${decision.configurationSet} (${decision.reason}).`;
  const named = [decision.configurationSet, ...decision.otherSpikingLanes].flatMap((set) => analyses.filter((analysis) => setOf(analysis) === set));
  const parts = named.map((analysis) => ({
    head: `${setOf(analysis)}:`,
    findings: findingsOf(analysis),
    tail: `; closeability refusals: ${refusalsOf(analysis.closeability)}.`,
  }));
  const fixedLength = parts.reduce((sum, part) => sum + part.head.length + part.tail.length + 2, opening.length + QUESTION_CLOSE.length + 1);
  const perLane = Math.floor((TEXT_LIMIT - fixedLength) / Math.max(parts.length, 1));
  const segments = parts.map(({ head, findings, tail }) => {
    const listed = findings.length === 0 ? 'no cause or elevated row' : listWithin(findings, perLane, 'rows');
    return `${head} ${listed}${tail}`;
  });
  return capped([opening, ...segments, QUESTION_CLOSE].join(' '));
}

function required(value: string | undefined, what: string, fromDomain: string): string {
  if (value === undefined) {
    throw new RangeError(`the configuration rows of ${fromDomain} carry no ${what}, so no fix can name it`);
  }
  return value;
}

function authenticationFix(fromDomain: string, analysis: LaneAnalysis): NonNullable<EvidenceRecord['fix']> {
  const rows = analysis.configurationRows.filter((row) => row.fromDomain === fromDomain);
  const cause = rows.find((row) => row.verdict === 'cause');
  const lookups = rows.flatMap((row) => row.lookups);
  const identity = lookups.flatMap((lookup) => (lookup.kind === 'ses' && lookup.identity !== null ? [lookup.identity] : []))[0];
  // The SPF row reads the TXT record on the custom MAIL FROM domain, so its lookup names that domain.
  const spfLookups = rows.filter((row) => row.record === 'spf').flatMap((row) => row.lookups);
  const mailFromDomain = spfLookups.flatMap((lookup) => (lookup.kind === 'dns' ? [lookup.name] : []))[0];
  if (cause === undefined) throw new RangeError(`no configuration row of ${fromDomain} reads cause, so no authentication fix applies`);
  switch (cause.record) {
    case 'dkim':
      return fixFor('missing-dkim', { fromDomain, identity: required(identity, 'SES identity', fromDomain) });
    case 'mail-from':
      return fixFor('failed-mail-from', {
        fromDomain,
        identity: required(identity, 'SES identity', fromDomain),
        mailFromDomain: required(mailFromDomain, 'MAIL FROM domain', fromDomain),
      });
    case 'dmarc':
      return fixFor('missing-dmarc', { fromDomain });
    case 'spf':
      return fixFor('missing-spf', { fromDomain, mailFromDomain: required(mailFromDomain, 'MAIL FROM domain', fromDomain) });
  }
}

function fixOf(decision: CycleDecision, analysis: LaneAnalysis): NonNullable<EvidenceRecord['fix']> {
  const shared = decision.sharedCause;
  if (shared === null) throw new RangeError(`the refused decision for ${decision.configurationSet} names no shared cause to write a fix for`);
  switch (shared.kind) {
    case 'provider':
      return fixFor('shared-provider', { provider: shared.value, lanes: shared.lanes });
    case 'from-domain':
      return authenticationFix(shared.value, analysis);
    default:
      return fixFor('shared-tag-value', { dimension: shared.kind, value: shared.value, lanes: shared.lanes });
  }
}

export interface AssembleInput {
  incidentId: string;
  analysis: LaneAnalysis;
  decision: CycleDecision;
  /** Every lane analysed in the cycle: the share is taken over their summaries and the question names their rows. */
  analyses: readonly LaneAnalysis[];
  expiresAt: number;
}

function recordInput(input: AssembleInput, decision: CycleDecision): EvidenceRecordInput {
  const { analysis } = input;
  const { summary, spike } = analysis;
  return {
    incidentId: input.incidentId,
    lane: { configurationSet: analysis.lane.configurationSet, lane: analysis.lane.lane },
    window: { fromBucketMs: summary.window.fromBucketMs, toBucketMs: summary.window.toBucketMs },
    laneTotals: {
      recipientSends: summary.totals.recipientSends,
      permanentBounces: summary.totals.permanentBounces,
      complaints: summary.totals.complaints,
      hardBounceRatio: spike.hardBounceRatio,
      complaintRatio: spike.complaintRatio,
      verdict: spike.verdict,
      triggers: [...spike.triggers],
      label: { hardBounceRatio: LANE_RATIO_LABELS.hardBounce, complaintRatio: LANE_RATIO_LABELS.complaint },
    },
    share: buildShareRow(summary, input.analyses.map((other) => other.summary)),
    rows: [...analysis.rows],
    configurationRows: [...analysis.configurationRows],
    isolation: decision.isolation,
    decision: {
      outcome: decision.outcome,
      reason: decision.reason,
      closeability: { state: decision.closeability.state, reasons: [...decision.closeability.reasons] },
      noData: decision.noData,
      bound: decision.bound,
      otherSpikingLanes: [...decision.otherSpikingLanes],
      sharedCause: decision.sharedCause === null ? null : { ...decision.sharedCause, lanes: [...decision.sharedCause.lanes] },
    },
    question: decision.outcome === 'unknown' ? questionFor(decision, input.analyses) : null,
    fix: decision.outcome === 'refused' ? fixOf(decision, analysis) : null,
    expiresAt: input.expiresAt,
  };
}

/** D-70: assembled once; a record past RECORD_BYTE_CEILING is assembled again as unknown
 * record-too-large with no option, so nothing oversized can ever be offered or sent. */
export function assembleEvidenceRecord(input: AssembleInput): EvidenceRecord {
  if (input.decision.configurationSet !== setOf(input.analysis)) {
    throw new RangeError(`the decision for ${input.decision.configurationSet} cannot be assembled with the analysis of ${setOf(input.analysis)}`);
  }
  const record = buildEvidenceRecord(recordInput(input, input.decision));
  if (serializedRecordBytes(record) <= RECORD_BYTE_CEILING) return record;
  return buildEvidenceRecord(recordInput(input, { ...input.decision, outcome: 'unknown', reason: 'record-too-large' }));
}
