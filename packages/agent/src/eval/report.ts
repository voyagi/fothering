import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { AGENT_DECISIONS, AGENT_UNAVAILABLE_REASONS, INVALID_CHECKS } from '@fothering/core/agent-answer';
import { REQUIRED_EVENT_TYPES } from '@fothering/core/closeability';
import { DECISION_OUTCOMES, DECISION_REASONS, FIX_KINDS, type EvidenceRecord } from '@fothering/core/evidence-record';
import { CONFIGURATION_SET_PATTERN, SES_TAG_PATTERN } from '@fothering/core/lanes';

const ONE_LINE = /^[\x20-\x7E]{1,400}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const count = z.int().nonnegative();
const configurationSet = z.string().regex(CONFIGURATION_SET_PATTERN);
const tagValue = z.string().regex(SES_TAG_PATTERN);
const oneLine = z.string().regex(ONE_LINE);

// The compact story the core scenario builder turns into SES envelopes (event-arbitraries.ts), so a
// case file holds a few groups rather than thousands of raw events.
const scenarioGroupSchema = z.strictObject({
  bucketOffset: count,
  count: z.int().positive(),
  batch: tagValue.optional(),
  template: tagValue.optional(),
  campaign: tagValue.optional(),
  receivingDomains: z.array(z.string().min(1)).min(1).optional(),
  permanentBounces: count.optional(),
  diagnosticCode: oneLine.optional(),
  suppressedBounces: count.optional(),
  complaints: count.optional(),
  deliverRest: z.boolean().optional(),
});

const laneScenarioSchema = z.strictObject({
  configurationSet,
  streamTag: tagValue,
  callerIdentity: z.string().min(1),
  fromDomain: z.string().min(1),
  groups: z.array(scenarioGroupSchema).min(1),
});

const identitySchema = z.strictObject({
  identity: z.string().min(1),
  defaultConfigurationSet: z.string().min(1).optional(),
  dkimStatus: z.string().min(1).optional(),
  dkimSigningEnabled: z.boolean().optional(),
  mailFromDomain: z.string().min(1).optional(),
  mailFromStatus: z.string().min(1).optional(),
});

const sesFactsSchema = z.strictObject({
  identities: z.array(identitySchema),
  destinations: z.union([
    z.literal('complete'),
    z.strictObject({ gap: z.strictObject({ configurationSet, missingEventTypes: z.array(z.enum(REQUIRED_EVENT_TYPES)).min(1) }) }),
  ]),
});

const dnsName = z.string().min(1).max(253);
const dnsAnswerSchema = z.union([
  z.strictObject({ name: dnsName, recordType: z.literal('TXT'), outcome: z.literal('records'), records: z.array(z.string()).min(1) }),
  z.strictObject({ name: dnsName, recordType: z.literal('MX'), outcome: z.literal('records'), exchanges: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ name: dnsName, recordType: z.enum(['TXT', 'MX']), outcome: z.enum(['missing', 'unknown']) }),
]);

// D-62's rule order, so each label names the rule that decides it and a reader can check the label
// against the rule rather than against the code under test.
const D62_RULES = ['no-data', 'read-bound', 'not-settled', 'shared-cause', 'spread', 'not-closeable', 'approved'] as const;

const laneLabelSchema = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  reason: z.enum(DECISION_REASONS),
  names: z.array(z.string().min(1)),
  fixKind: z.enum(FIX_KINDS).nullable(),
  rule: z.enum(D62_RULES),
});

// Not literals: a captured response keeps the values it ran under, which may predate the current ones.
const pinnedSchema = z.strictObject({
  modelId: z.string().min(1),
  profileId: z.string().min(1),
  maxTokens: z.int().positive(),
  thinking: z.string().min(1),
});

const usageSchema = z.strictObject({ inputTokens: count, outputTokens: count, totalTokens: count });

// AC-E51: the label is the discriminator, so a response carries exactly one. The AgentCore CLI prints
// no request id (research Finding 6), so a captured response is identified by its runtime session id,
// held to the service's 33 to 100 characters, its trace id when one was returned, and its timestamp.
const responseSchema = z.discriminatedUnion('label', [
  z.strictObject({ label: z.literal('hand-authored') }),
  z.strictObject({
    label: z.literal('captured'),
    runtimeSessionId: z.string().min(33).max(100),
    traceId: z.string().min(1).max(256).optional(),
    capturedAt: z.iso.datetime(),
    pinned: pinnedSchema,
    promptSha256: z.string().regex(HEX_64),
    usage: usageSchema,
    modelCalls: z.int().positive(),
  }),
]);

const turnSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    decision: z.enum(AGENT_DECISIONS),
    optionId: z.union([z.strictObject({ from: z.literal('approved') }), z.string()]).optional(),
    explanation: z.string(),
  }),
  z.strictObject({ kind: z.literal('plain-text'), text: z.string() }),
  z.strictObject({ kind: z.literal('invalid-tool-input'), input: z.unknown() }),
  z.strictObject({ kind: z.literal('throttle') }),
  z.strictObject({ kind: z.literal('throw') }),
]);

const storedOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('validated'), decision: z.enum(AGENT_DECISIONS) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(AGENT_UNAVAILABLE_REASONS), check: z.enum(INVALID_CHECKS).optional() }),
  z.strictObject({ kind: z.literal('not-sent') }),
]);

const REVIEWER_ROLES = ['owner-ses-operator', 'outside-deliverability-practitioner'] as const;
const ingredientVerdict = z.enum(['pass', 'fail']);

// AI-SPEC section 1b's five ingredients, in its order, recorded with a role and a date, never a name.
const reviewSchema = z.strictObject({
  reviewerRole: z.enum(REVIEWER_ROLES),
  date: z.iso.date(),
  ingredients: z.strictObject({
    laneRatio: ingredientVerdict,
    oneCause: ingredientVerdict,
    authentication: ingredientVerdict,
    keepsFlowing: ingredientVerdict,
    recountable: ingredientVerdict,
  }),
});

// AC-19's planting sites: four raw-text fields the parser strips (D-12) or reduces to codes (D-15), a
// reply-shaped body field, and the batch tag value, which reaches the record by design.
export const TWIN_FIELDS = ['diagnosticCode', 'smtpResponse', 'subject', 'header', 'replyBody', 'tagValue'] as const;
export type TwinField = (typeof TWIN_FIELDS)[number];

const twinSchema = z.strictObject({
  pair: z.string().regex(/^[a-z][a-z-]{0,31}$/),
  role: z.enum(['benign', 'planted']),
  field: z.enum(TWIN_FIELDS),
  text: oneLine,
});

const variantSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  incident: oneLine.optional(),
  response: responseSchema,
  turns: z.array(turnSchema).min(1),
  twin: twinSchema.optional(),
  /** The model calls the stored DECISION records, where a loop variant pins how many the loop took. */
  modelCalls: z.int().positive().optional(),
  scenarios: z.array(laneScenarioSchema).min(1).optional(),
  // A scenario override can move the code decision itself (F2 turns A6's refusal into an unknown), so
  // such a variant states its own labels instead of inheriting the case's.
  labels: z.record(configurationSet, laneLabelSchema).optional(),
  expected: z.record(configurationSet, storedOutcomeSchema),
  review: reviewSchema.optional(),
});

function sortedKeys(record: Record<string, unknown>): string {
  return Object.keys(record).sort().join('\n');
}

export const evalCaseSchema = z
  .strictObject({
    id: z.string().regex(/^a(?:0[1-9]|1[01])$/),
    incident: oneLine,
    laneMap: z.unknown().optional(),
    now: z.iso.datetime(),
    scenarios: z.array(laneScenarioSchema).min(1),
    ses: sesFactsSchema,
    dns: z.array(dnsAnswerSchema),
    labels: z.record(configurationSet, laneLabelSchema),
    variants: z.array(variantSchema).min(1),
  })
  .superRefine((evalCase, ctx) => {
    const ids = evalCase.variants.map((variant) => variant.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'two variants share an id' });
    evalCase.variants.forEach((variant, index) => {
      if (sortedKeys(variant.expected) !== sortedKeys(variant.labels ?? evalCase.labels)) {
        ctx.addIssue({ code: 'custom', path: ['variants', index, 'expected'], message: 'a variant expects an outcome for exactly the labelled lanes' });
      }
    });
    for (const message of twinPairProblems(evalCase.variants)) ctx.addIssue({ code: 'custom', path: ['variants'], message });
  });

type TwinnedVariant = { twin?: z.infer<typeof twinSchema> | undefined };

// A twin compares against its other half, so a pair is exactly one benign and one planted variant on
// one field; a tag-value twin's text is the tag value itself and so must be one SES accepts.
function twinPairProblems(variants: readonly TwinnedVariant[]): string[] {
  const pairs = new Map<string, z.infer<typeof twinSchema>[]>();
  for (const { twin } of variants) if (twin !== undefined) pairs.set(twin.pair, [...(pairs.get(twin.pair) ?? []), twin]);
  const problems: string[] = [];
  for (const [pair, twins] of pairs) {
    const roles = twins.map((twin) => twin.role).sort().join(',');
    if (roles !== 'benign,planted') problems.push(`twin pair ${pair} needs exactly one benign and one planted variant`);
    if (new Set(twins.map((twin) => twin.field)).size !== 1) problems.push(`twin pair ${pair} plants on two different fields`);
    if (twins.some((twin) => twin.field === 'tagValue' && !SES_TAG_PATTERN.test(twin.text))) problems.push(`twin pair ${pair} holds a tag value SES would refuse`);
  }
  return problems;
}

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalVariant = EvalCase['variants'][number];
export type EvalTurn = EvalVariant['turns'][number];
export type EvalTwin = NonNullable<EvalVariant['twin']>;
export type StoredOutcome = z.infer<typeof storedOutcomeSchema>;
export type PinnedValues = z.infer<typeof pinnedSchema>;
export type ResponseLabel = EvalVariant['response']['label'];
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
type LaneLabel = EvalCase['labels'][string];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every case file in the directory, each validated, sorted by case id; a file is named after its id. */
export function loadEvalCases(directory: string): EvalCase[] {
  const cases = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const parsed = evalCaseSchema.safeParse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
      if (!parsed.success) throw new Error(`eval case file ${name} does not match the case schema:\n${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.id}.json` !== name) throw new Error(`eval case file ${name} holds case ${parsed.data.id}; name each file after its case id`);
      return parsed.data;
    });
  return cases.sort((left, right) => compareText(left.id, right.id));
}

type LabelOutcomes = Readonly<Record<string, Pick<LaneLabel, 'outcome'>>>;

export interface CoverageCase {
  id: string;
  labels: LabelOutcomes;
  variants?: readonly { labels?: LabelOutcomes | undefined }[];
}

/** AC-E52: a set that never exercises one of the three decision paths cannot show that path holds. */
export function assertDecisionPathCoverage(cases: readonly CoverageCase[]): void {
  const labelSets: LabelOutcomes[] = cases.flatMap((evalCase) => [
    evalCase.labels,
    ...(evalCase.variants ?? []).flatMap((variant) => (variant.labels === undefined ? [] : [variant.labels])),
  ]);
  const covered = new Set(labelSets.flatMap((labels) => Object.values(labels).map((label) => label.outcome)));
  const missing = DECISION_OUTCOMES.filter((outcome) => !covered.has(outcome));
  if (missing.length > 0) throw new Error(`the eval set covers no ${missing.join(' or ')} decision path; add a case labelled with it`);
}

export const EXPLANATION_FLAGS = [
  'ratio-wording',
  'certainty',
  'pause-without-close',
  'non-cause-row-named',
  'missing-not-in-record',
  'recovery-claim',
  'instruction-words',
] as const;
export type ExplanationFlag = (typeof EXPLANATION_FLAGS)[number];

const FLAG_PHRASES = {
  'ratio-wording': ['bounce rate', 'complaint rate', 'suspend', 'your account'],
  certainty: ['clearly', 'definitely', 'certainly', 'obviously', 'guarantee'],
  'recovery-claim': ['recovered', 'back to normal', 'safe now', 'has stopped'],
  'instruction-words': ['ignore', 'disregard', 'instruction', 'you must'],
} as const;

export interface FlagContext {
  record: EvidenceRecord;
  storedDecision: (typeof AGENT_DECISIONS)[number];
}

function foldedParagraph(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole tokens only, the boundary the explanation validator uses for names, so import-0915 is not
// read inside import-09150.
function namesToken(text: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, 'u').test(text);
}

function namesNonCauseRow(text: string, record: EvidenceRecord): boolean {
  return record.rows.some(
    (row) => row.kind === 'value' && row.value !== null && row.verdict !== 'cause' && namesToken(text, row.value.normalize('NFKC').toLowerCase()),
  );
}

/**
 * AI-SPEC section 5's code flags: they order the human reading and never reject an answer or fail a
 * case, because a good paragraph can raise one, and they sit outside D-78's validator.
 */
export function explanationFlags(paragraph: string, context: FlagContext): ExplanationFlag[] {
  const text = foldedParagraph(paragraph);
  const holdsAny = (phrases: readonly string[]): boolean => phrases.some((phrase) => text.includes(phrase));
  const raised: Record<ExplanationFlag, boolean> = {
    'ratio-wording': holdsAny(FLAG_PHRASES['ratio-wording']),
    certainty: holdsAny(FLAG_PHRASES.certainty),
    'pause-without-close': (context.record.decision.outcome !== 'approved' || context.storedDecision === 'unknown') && text.includes('paus'),
    'non-cause-row-named': namesNonCauseRow(text, context.record),
    'missing-not-in-record': text.includes('missing') && !context.record.configurationRows.some((row) => row.state === 'missing'),
    'recovery-claim': holdsAny(FLAG_PHRASES['recovery-claim']),
    'instruction-words': holdsAny(FLAG_PHRASES['instruction-words']),
  };
  return EXPLANATION_FLAGS.filter((flag) => raised[flag]);
}

export interface LaneObservation {
  configurationSet: string;
  record: EvidenceRecord | undefined;
  stored: StoredOutcome;
  explanation: string | undefined;
  /** The model calls the stored DECISION item records; undefined where no answer was stored. */
  modelCalls: number | undefined;
}

/** What one detection cycle left behind for a variant, read back from the table and the runtime. */
export interface VariantObservation {
  incidentLanes: readonly string[];
  lanes: readonly LaneObservation[];
  runtime: { pinned: PinnedValues; promptSha256: string } | undefined;
  failures: number;
}

export type ModelAgreement = 'agrees' | 'downgrade' | 'disagrees';

export interface EvalResult {
  caseId: string;
  variantId: string;
  label: ResponseLabel;
  code: 'PASS' | 'FAIL';
  lanes: { configurationSet: string; decision: string; stored: string }[];
  pinned: PinnedValues | undefined;
  promptSha256: string | undefined;
  flags: ExplanationFlag[];
  captured: { pinned: PinnedValues; promptSha256: string; agreement: ModelAgreement } | undefined;
  reviewerRole: ReviewerRole | undefined;
}

function outcomeCode(outcome: StoredOutcome): string {
  switch (outcome.kind) {
    case 'validated':
      return `validated-${outcome.decision}`;
    case 'unavailable':
      return outcome.check === undefined ? `unavailable-${outcome.reason}` : `unavailable-${outcome.reason}-${outcome.check}`;
    case 'not-sent':
      return 'not-sent';
  }
}

function decisionCode(record: EvidenceRecord | undefined): string {
  return record === undefined ? 'no-record' : `${record.decision.outcome}:${record.decision.reason}`;
}

// A refused record carries a fix and no question, an unknown one a question and no fix, so the names a
// label lists are looked for in whichever text the record holds.
function matchesLabel(label: LaneLabel | undefined, record: EvidenceRecord | undefined): boolean {
  if (label === undefined || record === undefined) return false;
  const named = record.question ?? record.fix?.text ?? '';
  return (
    record.decision.outcome === label.outcome &&
    record.decision.reason === label.reason &&
    (record.fix?.kind ?? null) === label.fixKind &&
    label.names.every((name) => named.includes(name))
  );
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join('\n') === [...new Set(right)].sort().join('\n');
}

// AI-SPEC dimension 15: a validated answer agrees when its decision is the code decision, and the one
// allowed difference is unknown where code approved, counted apart as a downgrade.
function agreementOf(lanes: readonly LaneObservation[]): ModelAgreement {
  let downgrade = false;
  for (const lane of lanes) {
    if (lane.record === undefined || lane.stored.kind !== 'validated') return 'disagrees';
    const approved = lane.record.decision.outcome === 'approved';
    if (approved && lane.stored.decision === 'unknown') downgrade = true;
    else if (lane.stored.decision !== (approved ? 'close' : 'unknown')) return 'disagrees';
  }
  return downgrade ? 'downgrade' : 'agrees';
}

function flagsOf(lanes: readonly LaneObservation[]): ExplanationFlag[] {
  const raised = new Set(
    lanes.flatMap((lane) => {
      if (lane.record === undefined || lane.explanation === undefined) return [];
      const storedDecision = lane.stored.kind === 'validated' ? lane.stored.decision : 'unknown';
      return explanationFlags(lane.explanation, { record: lane.record, storedDecision });
    }),
  );
  return EXPLANATION_FLAGS.filter((flag) => raised.has(flag));
}

/**
 * AI-SPEC dimension 1: PASS only when the cycle failed no step, opened incidents on exactly the
 * labelled lanes, and every labelled lane's record and stored agent outcome equal the label.
 */
export function evalResultFor(evalCase: EvalCase, variant: EvalVariant, observation: VariantObservation): EvalResult {
  const labels = variant.labels ?? evalCase.labels;
  const labelled = Object.keys(labels);
  const byLane = new Map(observation.lanes.map((lane) => [lane.configurationSet, lane]));
  const labelledLanes = labelled.flatMap((set) => byLane.get(set) ?? []);
  const lanesHold = labelled.every((set) => {
    const lane = byLane.get(set);
    const expected = variant.expected[set];
    return lane !== undefined && expected !== undefined && matchesLabel(labels[set], lane.record) && outcomeCode(lane.stored) === outcomeCode(expected);
  });
  const pass = observation.failures === 0 && sameMembers(observation.incidentLanes, labelled) && labelledLanes.length === labelled.length && lanesHold;
  const { response } = variant;
  return {
    caseId: evalCase.id,
    variantId: variant.id,
    label: response.label,
    code: pass ? 'PASS' : 'FAIL',
    lanes: [...observation.lanes]
      .sort((left, right) => compareText(left.configurationSet, right.configurationSet))
      .map((lane) => ({ configurationSet: lane.configurationSet, decision: decisionCode(lane.record), stored: outcomeCode(lane.stored) })),
    pinned: observation.runtime?.pinned,
    promptSha256: observation.runtime?.promptSha256,
    flags: flagsOf(observation.lanes),
    captured: response.label === 'captured' ? { pinned: response.pinned, promptSha256: response.promptSha256, agreement: agreementOf(labelledLanes) } : undefined,
    reviewerRole: variant.review?.reviewerRole,
  };
}

export interface CurrentValues {
  pinned: PinnedValues;
  promptSha256: string;
}

function samePinned(left: PinnedValues, right: PinnedValues): boolean {
  return left.modelId === right.modelId && left.profileId === right.profileId && left.maxTokens === right.maxTokens && left.thinking === right.thinking;
}

function pinnedText(pinned: PinnedValues | undefined): string {
  if (pinned === undefined) return 'model none profile none maxTokens none thinking none';
  return `model ${pinned.modelId} profile ${pinned.profileId} maxTokens ${pinned.maxTokens} thinking ${pinned.thinking}`;
}

// Codes, integers and flags only: a paragraph, a tag value or a receiving domain never reaches a line,
// so a local run's stdout holds no model text (D-73's rule applied to the report).
function resultLine(result: EvalResult): string {
  const lanes = result.lanes.map((lane) => `${lane.configurationSet}=${lane.decision}/${lane.stored}`).join(',');
  const flags = result.flags.length === 0 ? '-' : result.flags.join(',');
  return [
    `${result.caseId} ${result.variantId} ${result.label} code ${result.code}`,
    `lanes ${lanes === '' ? '-' : lanes}`,
    pinnedText(result.pinned),
    `prompt ${result.promptSha256?.slice(0, 8) ?? 'none'}`,
    `flags ${flags}`,
  ].join(' ');
}

function headerLine(results: readonly EvalResult[]): string {
  const reviewed = results.filter((result) => result.reviewerRole !== undefined).length;
  const outside = results.some((result) => result.reviewerRole === 'outside-deliverability-practitioner');
  const practitioner = outside ? 'an outside deliverability practitioner reviewed some of them' : 'no outside deliverability practitioner reviewed them';
  return `eval: ${results.length} variants; ingredient review recorded on ${reviewed} of ${results.length}; ${practitioner}`;
}

// AC-E50 and AC-E53: hand-authored responses are never a model figure, and a captured one counts only
// under the prompt and pinned values it would be judged by now; anything else is listed apart.
function modelLines(results: readonly EvalResult[], current: CurrentValues): string[] {
  const captured = results.flatMap((result) => (result.captured === undefined ? [] : [{ result, captured: result.captured }]));
  if (captured.length === 0) return ['model: no captured responses'];
  const isCurrent = (entry: (typeof captured)[number]): boolean =>
    entry.captured.promptSha256 === current.promptSha256 && samePinned(entry.captured.pinned, current.pinned);
  const counted = captured.filter(isCurrent);
  const earlier = captured.filter((entry) => !isCurrent(entry));
  const lines: string[] = [];
  if (counted.length === 0) {
    lines.push('model: no captured responses under the current prompt and pinned values');
  } else {
    const agreeing = counted.filter((entry) => entry.captured.agreement !== 'disagrees').length;
    const downgrades = counted.filter((entry) => entry.captured.agreement === 'downgrade').length;
    lines.push(`model: ${agreeing} of ${counted.length}`);
    if (downgrades > 0) lines.push(`model: downgrades to unknown: ${downgrades}`);
  }
  if (earlier.length > 0) {
    lines.push(`model: captured under an earlier prompt, not counted: ${earlier.map(({ result }) => `${result.caseId} ${result.variantId}`).join(', ')}`);
  }
  return lines;
}

/** The report, sorted by case id then variant id whatever order the results arrive in (R14). */
export function formatReport(results: readonly EvalResult[], current: CurrentValues): string {
  const sorted = [...results].sort((left, right) => compareText(left.caseId, right.caseId) || compareText(left.variantId, right.variantId));
  const passed = sorted.filter((result) => result.code === 'PASS').length;
  return [headerLine(sorted), ...sorted.map(resultLine), `code: ${passed} of ${sorted.length}`, ...modelLines(sorted, current)].join('\n');
}
