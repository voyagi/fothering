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

const D62_RULES = ['no-data', 'read-bound', 'not-settled', 'shared-cause', 'spread', 'not-closeable', 'approved'] as const;

const laneLabelSchema = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  reason: z.enum(DECISION_REASONS),
  names: z.array(z.string().min(1)),
  fixKind: z.enum(FIX_KINDS).nullable(),
  rule: z.enum(D62_RULES),
});

const pinnedSchema = z.strictObject({
  modelId: z.string().min(1),
  profileId: z.string().min(1),
  maxTokens: z.int().positive(),
  thinking: z.string().min(1),
});

const usageSchema = z.strictObject({ inputTokens: count, outputTokens: count, totalTokens: count });

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

const variantSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  incident: oneLine.optional(),
  response: responseSchema,
  turns: z.array(turnSchema).min(1),
  scenarios: z.array(laneScenarioSchema).min(1).optional(),
  expected: z.record(configurationSet, storedOutcomeSchema),
  review: reviewSchema.optional(),
});

const caseSchema = z.strictObject({
  id: z.string().regex(/^a(?:0[1-9]|1[01])$/),
  incident: oneLine,
  laneMap: z.unknown().optional(),
  now: z.iso.datetime(),
  scenarios: z.array(laneScenarioSchema).min(1),
  ses: sesFactsSchema,
  dns: z.array(dnsAnswerSchema),
  labels: z.record(configurationSet, laneLabelSchema),
  variants: z.array(variantSchema).min(1),
});

export type EvalCase = z.infer<typeof caseSchema>;
export type EvalVariant = EvalCase['variants'][number];
export type EvalTurn = EvalVariant['turns'][number];
export type StoredOutcome = z.infer<typeof storedOutcomeSchema>;
export type PinnedValues = z.infer<typeof pinnedSchema>;
export type ResponseLabel = EvalVariant['response']['label'];
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const evalCaseSchema = z.custom<EvalCase>(() => true);

export function loadEvalCases(directory: string): EvalCase[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as EvalCase);
}

export function assertDecisionPathCoverage(cases: readonly Pick<EvalCase, 'id' | 'labels'>[]): void {
  void cases;
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

export interface FlagContext {
  record: EvidenceRecord;
  storedDecision: (typeof AGENT_DECISIONS)[number];
}

export function explanationFlags(paragraph: string, context: FlagContext): ExplanationFlag[] {
  void paragraph;
  void context;
  return [];
}

export interface LaneObservation {
  configurationSet: string;
  record: EvidenceRecord | undefined;
  stored: StoredOutcome;
  explanation: string | undefined;
}

export interface VariantObservation {
  incidentLanes: readonly string[];
  lanes: readonly LaneObservation[];
  runtime: { pinned: PinnedValues; promptSha256: string } | undefined;
  failures: number;
}

export interface EvalResult {
  caseId: string;
  variantId: string;
  label: ResponseLabel;
  code: 'PASS' | 'FAIL';
  lanes: { configurationSet: string; decision: string; stored: string }[];
  pinned: PinnedValues | undefined;
  promptSha256: string | undefined;
  flags: ExplanationFlag[];
  captured: { pinned: PinnedValues; promptSha256: string; agreement: 'agrees' | 'downgrade' | 'disagrees' } | undefined;
  reviewerRole: ReviewerRole | undefined;
}

export function evalResultFor(evalCase: EvalCase, variant: EvalVariant, observation: VariantObservation): EvalResult {
  void observation;
  return {
    caseId: evalCase.id,
    variantId: variant.id,
    label: variant.response.label,
    code: 'FAIL',
    lanes: [],
    pinned: undefined,
    promptSha256: undefined,
    flags: [],
    captured: undefined,
    reviewerRole: undefined,
  };
}

export interface CurrentValues {
  pinned: PinnedValues;
  promptSha256: string;
}

export function formatReport(results: readonly EvalResult[], current: CurrentValues): string {
  void results;
  void current;
  return '';
}
