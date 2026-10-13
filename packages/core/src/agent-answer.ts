import * as z from 'zod';
import type { EvidenceRecord } from './evidence-record.js';
import type { LaneMap } from './lanes.js';
import { MODEL_VALUES, PINNED_MODEL_VALUES } from './model-values.js';

export const AGENT_DECISIONS = ['close', 'unknown'] as const;

// One strict object, not a discriminated union: the SDK sends z.toJSONSchema(schema) unwrapped as
// the tool's input schema, and a union would arrive as a top-level oneOf (AI-SPEC pitfall 2). The
// superRefine has no JSON Schema form but runs on every parse, in the runtime and in detection
// alike. The .describe() texts travel in the tool spec and count against the 3,072-byte budget.
export const agentAnswerSchema = z
  .strictObject({
    decision: z.enum(AGENT_DECISIONS).describe('close only with exactly one approved option; else unknown'),
    optionId: z.string().optional().describe('With close only: the approved option id, copied exactly'),
    explanation: z.string().describe('One plain paragraph, at most 600 characters'),
  })
  .superRefine((answer, ctx) => {
    if (answer.decision === 'close' && (answer.optionId === undefined || answer.optionId.trim() === '')) {
      ctx.addIssue({ code: 'custom', path: ['optionId'], message: 'close needs the approved option id' });
    }
    if (answer.decision === 'unknown' && answer.optionId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['optionId'], message: 'unknown carries no option id' });
    }
  });

export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

export type DecisionCheck = { ok: true; answer: AgentAnswer } | { ok: false };

// D-74, AC-15: === on the raw strings. A trim, a case fold or a normalization here would let a
// near-match id through, which is the one failure the option id exists to rule out.
export function validateDecision(raw: unknown, approvedOptionIds: readonly string[]): DecisionCheck {
  const parsed = agentAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const answer = parsed.data;
  if (answer.decision === 'unknown') return { ok: true, answer };
  return approvedOptionIds.some((id) => id === answer.optionId) ? { ok: true, answer } : { ok: false };
}

const pinnedSchema = z.strictObject({
  modelId: z.literal(PINNED_MODEL_VALUES.modelId),
  profileId: z.literal(PINNED_MODEL_VALUES.profileId),
  maxTokens: z.literal(PINNED_MODEL_VALUES.maxTokens),
  thinking: z.literal(PINNED_MODEL_VALUES.thinking),
});

const promptSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const tokenCount = z.int().nonnegative();
const usageSchema = z.strictObject({ inputTokens: tokenCount, outputTokens: tokenCount, totalTokens: tokenCount });
const noUsageSchema = z.strictObject({ inputTokens: z.literal(0), outputTokens: z.literal(0), totalTokens: z.literal(0) });

export const RUNTIME_FAILURE_REASONS = [
  'model-call-ceiling',
  'input-ceiling',
  'structured-output',
  'loop-limit',
  'deadline',
  'model-error',
] as const;

export const RUNTIME_REFUSAL_REASONS = ['payload-invalid', 'hash-mismatch', 'record-too-large'] as const;

// What the runtime returns for every invocation (R9, SAFE-06): every variant carries the four pinned
// values and the system prompt's hash, so detection can tell which model and prompt produced it. The
// answer stays unknown here because detection re-validates it before anything is stored (D-74).
export const runtimeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('answered'),
    answer: z.unknown(),
    pinned: pinnedSchema,
    promptSha256,
    usage: usageSchema,
    modelCalls: z.int().positive(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.enum(RUNTIME_FAILURE_REASONS),
    pinned: pinnedSchema,
    promptSha256,
    usage: usageSchema,
    modelCalls: z.int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal('refused'),
    reason: z.enum(RUNTIME_REFUSAL_REASONS),
    pinned: pinnedSchema,
    promptSha256,
    usage: noUsageSchema,
    modelCalls: z.literal(0),
  }),
  z.strictObject({ status: z.literal('dry-run'), pinned: pinnedSchema, promptSha256 }),
]);

export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export type ExplanationCheck = 'empty' | 'length' | 'paragraph' | 'url' | 'command-word' | 'set-name' | 'phrase' | 'number';

export interface ExplanationContext {
  record: EvidenceRecord;
  decision: AgentAnswer['decision'];
  laneMapSets: readonly string[];
}

export interface ExplanationCheckEntry {
  check: ExplanationCheck;
  holds: (text: string, context: ExplanationContext) => boolean;
}

export type ExplanationVerdict = { ok: true } | { ok: false; check: ExplanationCheck };

function charClassOf(codePoints: readonly number[]): string {
  return `[${codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join('')}]`;
}

// U+200B to U+200D, U+2060, U+FEFF and the soft hyphen U+00AD, built from their numbers so this file
// holds only printable text.
const ZERO_WIDTH = new RegExp(charClassOf([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad]), 'g');

function withoutZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}

// NFKC folds fullwidth and other compatibility forms into the ASCII a check compares against, and the
// zero-width removal runs after it so a joiner can never split a token the check looks for (AC-E44).
function folded(text: string): string {
  return withoutZeroWidth(text.normalize('NFKC')).toLowerCase();
}

function isNotEmpty(text: string): boolean {
  return text.normalize('NFC').trim() !== '';
}

// Code points, never UTF-16 units: a character outside the BMP counts once (D-75).
function isWithinLength(text: string): boolean {
  return [...text.normalize('NFC')].length <= MODEL_VALUES.explanationMaxCodePoints;
}

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const BLANK_LINE = new RegExp(`\\n\\s*\\n|\\r\\s*\\r|${PARAGRAPH_SEPARATOR}|${LINE_SEPARATOR}\\s*${LINE_SEPARATOR}`);

function isOneParagraph(text: string): boolean {
  return !BLANK_LINE.test(text.normalize('NFC'));
}

const SCHEME_URL = /[\p{L}\p{N}+.-]+:\/\//u;
const DEFANGED_URL = /hxxp/;
const WWW_TOKEN = /(?<![\p{L}\p{N}_-])www\./u;

function holdsNoUrl(text: string): boolean {
  const normal = folded(text);
  return !SCHEME_URL.test(normal) && !DEFANGED_URL.test(normal) && !WWW_TOKEN.test(normal);
}

// The stem "clos" anywhere, so closed, closing, closure and disclose reject too: "closure" and
// "closing" do not contain "close", and the stricter reading of D-78 is meant to catch them.
function holdsNoCommandWord(text: string): boolean {
  const normal = folded(text);
  return !normal.includes('clos') && !normal.includes('reopen');
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

// An other set is judged by where each of its occurrences sits rather than on a text with the allowed
// name cut out: cutting fothering-bulk out of fothering-bulk-eu would leave -eu and hide the other set.
function namesNoOtherSet(text: string, context: ExplanationContext): boolean {
  const normal = folded(text);
  const allowed = context.decision === 'close' ? context.record.lane.configurationSet.toLowerCase() : null;
  const allowedSpans = allowed === null ? [] : occurrences(normal, allowed).map((start) => [start, start + allowed.length] as const);
  const inAllowedSpan = (start: number, end: number): boolean => allowedSpans.some(([from, to]) => from <= start && end <= to);
  return context.laneMapSets.every((set) => {
    const name = set.toLowerCase();
    return occurrences(normal, name).every((start) => inAllowedSpan(start, start + name.length));
  });
}

const BANNED_PHRASES = ['ses bounce rate', 'ses complaint rate', 'your bounce rate'] as const;

function holdsNoBannedPhrase(text: string): boolean {
  const normal = folded(text).replace(/\s+/g, ' ');
  return BANNED_PHRASES.every((phrase) => !normal.includes(phrase));
}

const PERCENT_STRING = /^\d{1,3}\.\d{2}%$/;
const DIGIT_ONLY = /^\p{Nd}+$/u;

interface RecordFacts {
  integers: Set<string>;
  percents: Set<string>;
  names: string[];
}

function recordFacts(record: EvidenceRecord): RecordFacts {
  const integers = new Set<string>();
  const percents = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) integers.add(String(value));
    else if (typeof value === 'string' && PERCENT_STRING.test(value)) percents.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(record);
  const names = [
    record.lane.configurationSet,
    record.lane.lane,
    ...record.rows.flatMap((row) => (row.value === null ? [] : [row.value])),
    ...record.configurationRows.map((row) => row.fromDomain),
  ];
  const removable = [...new Set(names.map((name) => withoutZeroWidth(name.normalize('NFKC'))))].filter((name) => name !== '' && !DIGIT_ONLY.test(name));
  return { integers, percents, names: removable.sort((left, right) => right.length - left.length) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 4b-Q, an additive implementation detail of D-78 and not a rule change: exact whole-token copies of
// the record's own names are removed before the number check, so a cause batch written with digits
// still passes. A digit-only value is never removed, or a fabricated count equal to it would vanish.
function withoutRecordNames(text: string, names: readonly string[]): string {
  return names.reduce((rest, name) => rest.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, 'gu'), ' '), text);
}

const NUMBER_TOKEN = /\p{Nd}+(?:,\p{Nd}{3})*(?:\.\p{Nd}+)?%?/gu;

function holdsOnlyRecordNumbers(text: string, context: ExplanationContext): boolean {
  const facts = recordFacts(context.record);
  const rest = withoutRecordNames(withoutZeroWidth(text.normalize('NFKC')), facts.names);
  return [...rest.matchAll(NUMBER_TOKEN)].every(([token]) => {
    if (token.endsWith('%')) return facts.percents.has(token);
    if (token.includes('.')) return false;
    return facts.integers.has(token.replaceAll(',', ''));
  });
}

export const EXPLANATION_CHECKS: readonly ExplanationCheckEntry[] = [
  { check: 'empty', holds: isNotEmpty },
  { check: 'length', holds: isWithinLength },
  { check: 'paragraph', holds: isOneParagraph },
  { check: 'url', holds: holdsNoUrl },
  { check: 'command-word', holds: holdsNoCommandWord },
  { check: 'set-name', holds: namesNoOtherSet },
  { check: 'phrase', holds: holdsNoBannedPhrase },
  { check: 'number', holds: holdsOnlyRecordNumbers },
];

/** D-78 and R12: any failed check rejects the whole answer; the caller keeps the code, never the text. */
export function validateExplanation(
  text: string,
  context: ExplanationContext,
  checks: readonly ExplanationCheckEntry[] = EXPLANATION_CHECKS,
): ExplanationVerdict {
  const failed = checks.find((entry) => !entry.holds(text, context));
  return failed === undefined ? { ok: true } : { ok: false, check: failed.check };
}

export const AGENT_UNAVAILABLE_REASONS = ['agent-error', 'agent-timeout', 'cap-reached', 'response-invalid', 'agent-dry-run'] as const;
export type AgentUnavailableReason = (typeof AGENT_UNAVAILABLE_REASONS)[number];

export const RETRYABLE_UNAVAILABLE_REASONS = ['agent-error', 'agent-timeout', 'response-invalid'] as const satisfies readonly AgentUnavailableReason[];

export const INVALID_CHECKS = [
  'schema',
  'option-id',
  'number',
  'url',
  'command-word',
  'set-name',
  'phrase',
  'paragraph',
  'length',
  'empty',
  'model-call-ceiling',
  'input-ceiling',
  'structured-output',
  'loop-limit',
  'runtime-result',
] as const;
export type InvalidCheck = (typeof INVALID_CHECKS)[number];

export type RuntimeOutcome = { kind: 'returned'; response: unknown } | { kind: 'threw'; callerAborted: boolean };

export interface OutcomeContext {
  record: EvidenceRecord;
  laneMapSets: readonly string[];
}

export type ClassifiedOutcome =
  | { kind: 'validated'; answer: AgentAnswer }
  | { kind: 'unavailable'; reason: AgentUnavailableReason; check?: InvalidCheck };

function unavailable(reason: AgentUnavailableReason, check?: InvalidCheck): ClassifiedOutcome {
  return check === undefined ? { kind: 'unavailable', reason } : { kind: 'unavailable', reason, check };
}

function classifyAnswer(raw: unknown, context: OutcomeContext): ClassifiedOutcome {
  const approvedOptionIds = context.record.approvedOptions.map((option) => option.optionId);
  const decided = validateDecision(raw, approvedOptionIds);
  if (!decided.ok) return unavailable('response-invalid', agentAnswerSchema.safeParse(raw).success ? 'option-id' : 'schema');
  const { answer } = decided;
  const explained = validateExplanation(answer.explanation, { record: context.record, decision: answer.decision, laneMapSets: context.laneMapSets });
  return explained.ok ? { kind: 'validated', answer } : unavailable('response-invalid', explained.check);
}

/**
 * D-77, as plan 02-06 confirmed it: every way an invocation can end becomes either a validated answer
 * or one named reason with a closed check code. Nothing returned holds model text or an error message
 * (D-74), so a caller can store and log the whole result.
 */
export function classifyRuntimeOutcome(outcome: RuntimeOutcome, context: OutcomeContext): ClassifiedOutcome {
  if (outcome.kind === 'threw') return unavailable(outcome.callerAborted ? 'agent-timeout' : 'agent-error');
  const parsed = runtimeResultSchema.safeParse(outcome.response);
  if (!parsed.success) return unavailable('response-invalid', 'runtime-result');
  const result = parsed.data;
  switch (result.status) {
    case 'answered':
      return classifyAnswer(result.answer, context);
    case 'failed':
      if (result.reason === 'deadline') return unavailable('agent-timeout');
      if (result.reason === 'model-error') return unavailable('agent-error');
      return unavailable('response-invalid', result.reason);
    case 'refused':
      return unavailable('agent-error');
    case 'dry-run':
      return unavailable('agent-dry-run');
  }
}

export const GATE_REFUSALS = [
  'no-close',
  'record-missing',
  'record-invalid',
  'incident-mismatch',
  'hash-mismatch',
  'option-set-tampered',
  'option-not-approved',
  'decision-differs',
  'lane-not-in-map',
] as const;
export type GateRefusal = (typeof GATE_REFUSALS)[number];

export interface GateDecision {
  decision: AgentAnswer['decision'];
  optionId?: string | undefined;
}

export interface ClosureIntent {
  configurationSet: string;
  incidentId: string;
  optionId: string;
}

export interface ActionGateInput {
  decision: GateDecision;
  incidentId: string;
  loadRecord: (incidentId: string) => Promise<EvidenceRecord | undefined>;
  laneMap: LaneMap;
}

export type GateResult = { ok: true; intent: ClosureIntent } | { ok: false; refusal: GateRefusal };

export async function actionGate(_input: ActionGateInput): Promise<GateResult> {
  return Promise.resolve({ ok: false, refusal: 'no-close' });
}
