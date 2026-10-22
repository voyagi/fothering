import { describe, expect, it } from 'vitest';
import { MIN_SEND_GAP_MS } from './live-run.js';
import {
  RECIPIENT_KINDS,
  SIMULATOR_DOMAIN,
  closeScenarioMeetsRules,
  findStep,
  parseScenarioSource,
  scenarioSourceSchema,
  scenarioTotals,
  stepPlan,
  type ScenarioSource,
} from './scenarios.js';
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

type Group = ScenarioSource['scenarios'][number]['steps'][number]['groups'][number];

function bulkGroup(name: string, batch: string, recipient: Group['recipient'], count: number): Group {
  return { name, lane: 'fothering-bulk', tag: { kind: 'batch', value: batch }, recipient, count };
}

/** Run 1 with its spike's bulk groups replaced, the receipts group kept. */
function run1With(groups: Group[]): ScenarioSource {
  const source = committedCopy();
  const step = firstStep(source);
  step.groups = [...groups, ...step.groups.filter((group) => group.lane !== 'fothering-bulk')];
  return source;
}

describe('the committed close scenarios meet the committed thresholds by arithmetic', () => {
  const source = parseScenarioSource(scenariosJson);

  it('totals run 1 spike per lane and per tag value', () => {
    const totals = scenarioTotals(source, 'bulk-stale-import');
    expect(totals.lanes['fothering-bulk']).toEqual({
      sends: 120,
      bounces: 24,
      complaints: 0,
      tags: {
        'batch:clean-import': { sends: 96, bounces: 0, complaints: 0 },
        'batch:stale-import': { sends: 24, bounces: 24, complaints: 0 },
      },
    });
    expect(totals.lanes['fothering-transactional']?.sends).toBe(12);
  });

  it('passes runs 1 and 3 and does not judge run 2, which is built to end unknown', () => {
    expect(closeScenarioMeetsRules(source, 'bulk-stale-import')).toEqual({ ok: true, failures: [] });
    expect(closeScenarioMeetsRules(source, 'bulk-complaint-campaign')).toEqual({ ok: true, failures: [] });
    expect(closeScenarioMeetsRules(source, 'transactional-spike')).toEqual({ ok: false, failures: ['not-a-close-scenario'] });
    expect(closeScenarioMeetsRules(source, 'no-such-scenario')).toEqual({ ok: false, failures: ['not-a-close-scenario'] });
  });

  it('fails 99 lane sends by name and passes 100', () => {
    expect(closeScenarioMeetsRules(run1With([bulkGroup('clean-import', 'clean-import', 'success', 75), bulkGroup('stale-import', 'stale-import', 'bounce', 24)]), 'bulk-stale-import')).toEqual({
      ok: false,
      failures: ['lane-sends'],
    });
    expect(closeScenarioMeetsRules(run1With([bulkGroup('clean-import', 'clean-import', 'success', 76), bulkGroup('stale-import', 'stale-import', 'bounce', 24)]), 'bulk-stale-import')).toEqual({
      ok: true,
      failures: [],
    });
  });

  it('fails a batch of 19 by name and passes 20', () => {
    expect(closeScenarioMeetsRules(run1With([bulkGroup('clean-import', 'clean-import', 'success', 96), bulkGroup('stale-import', 'stale-import', 'bounce', 19)]), 'bulk-stale-import')).toEqual({
      ok: false,
      failures: ['row-sends'],
    });
    expect(closeScenarioMeetsRules(run1With([bulkGroup('clean-import', 'clean-import', 'success', 96), bulkGroup('stale-import', 'stale-import', 'bounce', 20)]), 'bulk-stale-import')).toEqual({
      ok: true,
      failures: [],
    });
  });

  it('fails 2 permanent bounces by name, and 3 at or above 5 percent clear the ratio rule', () => {
    const two = run1With([bulkGroup('clean-import', 'clean-import', 'success', 96), bulkGroup('stale-bounce', 'stale-import', 'bounce', 2), bulkGroup('stale-ok', 'stale-import', 'success', 22)]);
    expect(closeScenarioMeetsRules(two, 'bulk-stale-import')).toEqual({ ok: false, failures: ['ratio'] });
    // 3 of 60 is exactly 5 percent: the ratio rule passes, and only the lane minimum is short.
    const three = run1With([bulkGroup('clean-import', 'clean-import', 'success', 40), bulkGroup('stale-bounce', 'stale-import', 'bounce', 3), bulkGroup('stale-ok', 'stale-import', 'success', 17)]);
    expect(closeScenarioMeetsRules(three, 'bulk-stale-import')).toEqual({ ok: false, failures: ['lane-sends'] });
  });

  it('runs scenario 1 first, and every close scenario needs no open incident on its lane', () => {
    expect(source.scenarios[0]?.run).toBe(1);
    expect(source.scenarios[0]?.expectedDecision.outcome).toBe('close');
    for (const scenario of source.scenarios.filter((candidate) => candidate.expectedDecision.outcome === 'close')) {
      expect(scenario.precondition.toLowerCase()).toContain(`no open incident on ${scenario.lane}`);
    }
  });
});
