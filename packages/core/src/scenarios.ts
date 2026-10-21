import * as z from 'zod';
import { CONFIGURATION_SET_PATTERN } from './lanes.js';

export const SIMULATOR_DOMAIN = 'simulator.amazonses.com';
export const RECIPIENT_KINDS = ['success', 'bounce', 'complaint'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];
export const SCENARIO_TAG_KINDS = ['batch', 'campaign', 'template'] as const;
export type ScenarioTagKind = (typeof SCENARIO_TAG_KINDS)[number];

const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const laneSchema = z.string().regex(CONFIGURATION_SET_PATTERN);
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const groupSchema = z.strictObject({
  name: nameSchema,
  lane: laneSchema,
  tag: z.strictObject({ kind: z.enum(SCENARIO_TAG_KINDS), value: z.string().min(1) }),
  recipient: z.enum(RECIPIENT_KINDS),
  count: z.number().int().min(0),
});

const stepSchema = z.strictObject({
  name: nameSchema,
  groups: z.array(groupSchema),
  cycle: z.array(z.strictObject({ group: nameSchema, take: z.number().int().min(1) })).min(1),
  interleave: z.strictObject({ group: nameSchema, afterEvery: z.number().int().min(1) }).optional(),
});

const expectedDecisionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('close'), dimension: z.literal('tag'), tagKind: z.enum(SCENARIO_TAG_KINDS), value: z.string().min(1) }),
  z.strictObject({ outcome: z.literal('unknown'), reason: nameSchema }),
]);

const scenarioSchema = z.strictObject({
  run: z.number().int().min(1).max(3),
  name: nameSchema,
  lane: laneSchema,
  precondition: z.string().min(1),
  expectedDecision: expectedDecisionSchema,
  steps: z.array(stepSchema).min(1),
});

export const scenarioSourceSchema = z.strictObject({
  recipientDomain: z.string().regex(HOSTNAME_PATTERN),
  minGapMs: z.number().int().min(1),
  scenarios: z.array(scenarioSchema).min(1),
});

export type ScenarioSource = z.infer<typeof scenarioSourceSchema>;
export type Scenario = ScenarioSource['scenarios'][number];
export type ScenarioStep = Scenario['steps'][number];

export interface StepPlanEntry {
  index: number;
  step: string;
  lane: string;
  tagKind: ScenarioTagKind;
  tagValue: string;
  recipientKind: RecipientKind;
  recipient: string;
}

export function parseScenarioSource(json: unknown): ScenarioSource {
  return scenarioSourceSchema.parse(json);
}

export function findStep(_source: ScenarioSource, _scenarioName: string, _stepName: string): { scenario: Scenario; step: ScenarioStep } | undefined {
  return undefined;
}

export function stepPlan(_source: ScenarioSource, _scenarioName: string, _stepName: string, _runId: string): StepPlanEntry[] {
  return [];
}
