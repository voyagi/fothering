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

// The recipient domain is any hostname here on purpose: the command's recipient guard, not the
// schema, is what refuses a domain outside the simulator, so that guard is what the tests reach.
const sourceShape = z.strictObject({
  recipientDomain: z.string().regex(HOSTNAME_PATTERN),
  minGapMs: z.number().int().min(1),
  scenarios: z.array(scenarioSchema).min(1),
});

export type ScenarioSource = z.infer<typeof sourceShape>;
export type Scenario = ScenarioSource['scenarios'][number];
export type ScenarioStep = Scenario['steps'][number];

interface SourceIssue {
  message: string;
  path: (string | number)[];
}

function duplicates(values: readonly (string | number)[]): (string | number)[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function stepIssues(step: ScenarioStep, path: (string | number)[]): SourceIssue[] {
  const names = new Set(step.groups.map((group) => group.name));
  const issues: SourceIssue[] = duplicates(step.groups.map((group) => group.name)).map((name) => ({
    message: `group name "${String(name)}" is used twice in step "${step.name}"`,
    path: [...path, 'groups'],
  }));
  for (const slot of step.cycle) {
    if (!names.has(slot.group)) issues.push({ message: `cycle group "${slot.group}" is not a group of step "${step.name}"`, path: [...path, 'cycle'] });
  }
  if (step.interleave !== undefined && !names.has(step.interleave.group)) {
    issues.push({ message: `interleave group "${step.interleave.group}" is not a group of step "${step.name}"`, path: [...path, 'interleave'] });
  }
  const total = step.groups.reduce((sum, group) => sum + group.count, 0);
  const placed = orderOf(step).length;
  if (total === 0) issues.push({ message: `step "${step.name}" has no messages`, path });
  else if (placed !== total) issues.push({ message: `step "${step.name}" places ${placed} of its ${total} messages`, path });
  return issues;
}

function sourceIssues(source: ScenarioSource): SourceIssue[] {
  const issues: SourceIssue[] = [
    ...duplicates(source.scenarios.map((scenario) => scenario.name)).map((name) => ({ message: `scenario name "${String(name)}" is used twice`, path: ['scenarios'] })),
    ...duplicates(source.scenarios.map((scenario) => scenario.run)).map((run) => ({ message: `run ${String(run)} is used twice`, path: ['scenarios'] })),
  ];
  source.scenarios.forEach((scenario, scenarioIndex) => {
    const path = ['scenarios', scenarioIndex, 'steps'];
    for (const name of duplicates(scenario.steps.map((step) => step.name))) {
      issues.push({ message: `step name "${String(name)}" is used twice in scenario "${scenario.name}"`, path });
    }
    scenario.steps.forEach((step, stepIndex) => issues.push(...stepIssues(step, [...path, stepIndex])));
  });
  return issues;
}

export const scenarioSourceSchema = sourceShape.superRefine((source, ctx) => {
  for (const issue of sourceIssues(source)) ctx.addIssue({ code: 'custom', ...issue });
});

export interface StepPlanEntry {
  index: number;
  /** The three-digit send number within the step, as it appears in the recipient's plus label. */
  counter: string;
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

export function findStep(source: ScenarioSource, scenarioName: string, stepName: string): { scenario: Scenario; step: ScenarioStep } | undefined {
  const scenario = source.scenarios.find((candidate) => candidate.name === scenarioName);
  const step = scenario?.steps.find((candidate) => candidate.name === stepName);
  return scenario === undefined || step === undefined ? undefined : { scenario, step };
}

type ScenarioGroup = ScenarioStep['groups'][number];

interface GroupCount {
  group: ScenarioGroup;
  left: number;
}

/** Takes up to count messages of a group; a group the step does not define never yields one. */
function take(remaining: ReadonlyMap<string, GroupCount>, name: string, count: number): ScenarioGroup[] {
  const entry = remaining.get(name);
  if (entry === undefined) return [];
  const taken = Math.min(count, entry.left);
  entry.left -= taken;
  return Array.from({ length: taken }, () => entry.group);
}

// The cycle repeats until none of its groups has a message left; a group already exhausted is
// skipped, so a cycle naming one group twice keeps drawing from the same count.
function cycleOrder(step: ScenarioStep, remaining: ReadonlyMap<string, GroupCount>): ScenarioGroup[] {
  const order: ScenarioGroup[] = [];
  let placed = true;
  while (placed) {
    placed = false;
    for (const slot of step.cycle) {
      const taken = take(remaining, slot.group, slot.take);
      order.push(...taken);
      if (taken.length > 0) placed = true;
    }
  }
  return order;
}

function withInterleave(step: ScenarioStep, remaining: ReadonlyMap<string, GroupCount>, cycle: readonly ScenarioGroup[]): ScenarioGroup[] {
  const interleave = step.interleave;
  if (interleave === undefined) return [...cycle];
  return cycle.flatMap((group, position) =>
    (position + 1) % interleave.afterEvery === 0 ? [group, ...take(remaining, interleave.group, 1)] : [group],
  );
}

function orderOf(step: ScenarioStep): ScenarioGroup[] {
  const remaining = new Map(step.groups.map((group) => [group.name, { group, left: group.count }]));
  return withInterleave(step, remaining, cycleOrder(step, remaining));
}

/** The step's sends in the order the command makes them; empty when the scenario or step is absent. */
export function stepPlan(source: ScenarioSource, scenarioName: string, stepName: string, runId: string): StepPlanEntry[] {
  const found = findStep(source, scenarioName, stepName);
  if (found === undefined) return [];
  const { step } = found;
  return orderOf(step).map((group, index) => {
    const counter = String(index + 1).padStart(3, '0');
    return {
      index,
      counter,
      step: step.name,
      lane: group.lane,
      tagKind: group.tag.kind,
      tagValue: group.tag.value,
      recipientKind: group.recipient,
      recipient: `${group.recipient}+${runId}-${step.name}-${counter}@${source.recipientDomain}`,
    };
  });
}
