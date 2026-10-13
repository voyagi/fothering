import * as z from 'zod';
import type { EvidenceRecord } from './evidence-record.js';
import { PINNED_MODEL_VALUES } from './model-values.js';

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

export const EXPLANATION_CHECKS: readonly ExplanationCheckEntry[] = [];

export function validateExplanation(
  _text: string,
  _context: ExplanationContext,
  _checks: readonly ExplanationCheckEntry[] = EXPLANATION_CHECKS,
): ExplanationVerdict {
  return { ok: true };
}
