import { describe, expect, it } from 'vitest';
import { MIN_SEND_GAP_MS } from './live-run.js';
import { RECIPIENT_KINDS, SIMULATOR_DOMAIN, findStep, parseScenarioSource, scenarioSourceSchema, stepPlan, type ScenarioSource } from './scenarios.js';
import scenariosJson from '../../../docs/measurement-scenarios.json' with { type: 'json' };

const RUN_ID = 'live-20261022-s1-1';

function committedCopy(): ScenarioSource {
  return structuredClone(scenariosJson) as ScenarioSource;
}

function issuesOf(source: unknown): string[] {
  const result = scenarioSourceSchema.safeParse(source);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function firstStep(source: ScenarioSource): ScenarioSource['scenarios'][number]['steps'][number] {
  const step = source.scenarios[0]?.steps[0];
  if (step === undefined) throw new Error('the committed source has no first step');
  return step;
}

describe('the committed scenario source', () => {
  const source = parseScenarioSource(scenariosJson);

  it('parses, names the simulator domain and keeps the command gap', () => {
    expect(source.recipientDomain).toBe(SIMULATOR_DOMAIN);
    expect(source.minGapMs).toBe(MIN_SEND_GAP_MS);
    expect(RECIPIENT_KINDS).toEqual(['success', 'bounce', 'complaint']);
  });

  it('holds the three scenarios in run order', () => {
    expect(source.scenarios.map((scenario) => [scenario.run, scenario.name, scenario.lane])).toEqual([
      [1, 'bulk-stale-import', 'fothering-bulk'],
      [2, 'transactional-spike', 'fothering-transactional'],
      [3, 'bulk-complaint-campaign', 'fothering-bulk'],
    ]);
    expect(source.scenarios.map((scenario) => scenario.expectedDecision)).toEqual([
      { outcome: 'close', dimension: 'tag', tagKind: 'batch', value: 'stale-import' },
      { outcome: 'unknown', reason: 'not-closeable' },
      { outcome: 'close', dimension: 'tag', tagKind: 'campaign', value: 'winback' },
    ]);
  });

  it('plans run 1 spike as 132 sends: four clean, one stale, and a receipt after every ten bulk messages', () => {
    const plan = stepPlan(source, 'bulk-stale-import', 'spike', RUN_ID);
    expect(plan).toHaveLength(132);
    const receipts = plan.flatMap((entry, index) => (entry.lane === 'fothering-transactional' ? [index] : []));
    expect(receipts).toEqual(Array.from({ length: 12 }, (_, slot) => 10 + slot * 11));
    const bulk = plan.filter((entry) => entry.lane === 'fothering-bulk').map((entry) => entry.tagValue);
    expect(bulk.slice(0, 10)).toEqual(['clean-import', 'clean-import', 'clean-import', 'clean-import', 'stale-import', 'clean-import', 'clean-import', 'clean-import', 'clean-import', 'stale-import']);
    expect(plan[0]?.recipient).toBe(`success+${RUN_ID}-spike-001@${SIMULATOR_DOMAIN}`);
    expect(plan[131]?.recipient).toBe(`success+${RUN_ID}-spike-132@${SIMULATOR_DOMAIN}`);
    expect(new Set(plan.map((entry) => entry.recipient)).size).toBe(132);
  });

  it('plans run 1 after-pause as three bulk and three transactional sends, alternating from bulk', () => {
    expect(stepPlan(source, 'bulk-stale-import', 'after-pause', RUN_ID).map((entry) => entry.lane)).toEqual([
      'fothering-bulk', 'fothering-transactional', 'fothering-bulk', 'fothering-transactional', 'fothering-bulk', 'fothering-transactional',
    ]);
  });

  it('plans run 2 spike as 120 transactional sends and run 3 spike with its four complaints spread evenly', () => {
    expect(stepPlan(source, 'transactional-spike', 'spike', 'live-20261022-s2-1')).toHaveLength(120);
    const run3 = stepPlan(source, 'bulk-complaint-campaign', 'spike', 'live-20261023-s3-1');
    expect(run3).toHaveLength(120);
    expect(run3.flatMap((entry, index) => (entry.recipientKind === 'complaint' ? [index] : []))).toEqual([29, 59, 89, 119]);
    expect(run3.filter((entry) => entry.tagValue === 'winback')).toHaveLength(24);
  });

  it('finds a step and answers undefined for an absent scenario or step', () => {
    expect(findStep(source, 'bulk-stale-import', 'spike')?.step.name).toBe('spike');
    expect(findStep(source, 'no-such-scenario', 'spike')).toBeUndefined();
    expect(findStep(source, 'transactional-spike', 'after-pause')).toBeUndefined();
    expect(stepPlan(source, 'transactional-spike', 'after-pause', RUN_ID)).toEqual([]);
  });
});

describe('scenarioSourceSchema checks what the shape alone cannot', () => {
  it('refuses a cycle naming a group the step does not define', () => {
    const source = committedCopy();
    firstStep(source).cycle.push({ group: 'no-such-group', take: 1 });
    expect(issuesOf(source)).toContain('cycle group "no-such-group" is not a group of step "spike"');
  });

  it('refuses an interleave naming a group the step does not define', () => {
    const source = committedCopy();
    firstStep(source).interleave = { group: 'no-such-group', afterEvery: 10 };
    expect(issuesOf(source)).toContain('interleave group "no-such-group" is not a group of step "spike"');
  });

  it('refuses a step with no messages', () => {
    const source = committedCopy();
    for (const group of firstStep(source).groups) group.count = 0;
    expect(issuesOf(source)).toContain('step "spike" has no messages');
  });

  it('refuses a group the order rules never place in full', () => {
    const source = committedCopy();
    const receipts = firstStep(source).groups[2];
    if (receipts === undefined) throw new Error('the committed spike has no third group');
    receipts.count = 13;
    expect(issuesOf(source)).toContain('step "spike" places 132 of its 133 messages');
  });

  it('refuses two scenarios with one name or one run number, two steps with one name, and two groups with one name', () => {
    const source = committedCopy();
    const [first, second] = source.scenarios;
    if (first === undefined || second === undefined) throw new Error('the committed source has fewer than two scenarios');
    second.name = first.name;
    second.run = first.run;
    const step = firstStep(source);
    first.steps.push(structuredClone(step));
    const group = step.groups[0];
    if (group !== undefined) step.groups.push(structuredClone(group));
    expect(issuesOf(source)).toEqual(
      expect.arrayContaining([
        'scenario name "bulk-stale-import" is used twice',
        'run 1 is used twice',
        'step name "spike" is used twice in scenario "bulk-stale-import"',
        'group name "clean-import" is used twice in step "spike"',
      ]),
    );
  });

  it('accepts the committed source with no issue', () => {
    expect(issuesOf(scenariosJson)).toEqual([]);
  });
});
