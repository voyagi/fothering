import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeResult } from '@fothering/core/agent-answer';
import { bucketStartMs } from '@fothering/core/buckets';
import { REQUIRED_EVENT_TYPES } from '@fothering/core/closeability';
import { evidenceRecordSchema, incidentIdFor, incidentItemKey, type EvidenceRecord } from '@fothering/core/evidence-record';
import { findLane, parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import { PINNED_MODEL_VALUES } from '@fothering/core/model-values';
import { scenarioEnvelopes, type LaneScenario } from '@fothering/core/test/event-arbitraries';
import { runDetectionCycle } from '@fothering/functions/detect/detect';
import { buildDetectRoot } from '@fothering/functions/detect/root';
import { ingestEvent } from '@fothering/functions/ingest/ingest';
import { buildIngestRoot } from '@fothering/functions/ingest/root';
import { createFixtureModel, plainTextTurn, structuredAnswerTurn, throttledTurn, type FixtureTurn } from '@fothering/providers/fixtures/fixture-model';
import { createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import type { BedrockModelPort, DecisionStoreItem, FixtureTableState, Recording } from '@fothering/providers/port-types';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import { SYSTEM_PROMPT_SHA256, createInvocationHandler } from '../handler.js';
import { buildAgentRoot } from '../root.js';
import {
  assertDecisionPathCoverage,
  evalCaseSchema,
  evalResultFor,
  explanationFlags,
  formatReport,
  loadEvalCases,
  type EvalCase,
  type EvalResult,
  type EvalTurn,
  type EvalVariant,
  type LaneObservation,
  type StoredOutcome,
  type VariantObservation,
} from './report.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CASES = loadEvalCases(FIXTURES);
const COMMITTED_LANES = parseLaneMap(lanesJson);
const CURRENT = { pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256 };
const FIXTURE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fixture-runtime';
const FIXTURE_USAGE = { inputTokens: 1_850, outputTokens: 96, totalTokens: 1_946 };

interface PlannedRun {
  evalCase: EvalCase;
  variant: EvalVariant;
}

const RUNS: readonly PlannedRun[] = CASES.flatMap((evalCase) => evalCase.variants.map((variant) => ({ evalCase, variant })));

function rawCase(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function withFirstResponse(response: unknown): unknown {
  const raw = rawCase('a01') as { variants: Record<string, unknown>[] };
  const [first, ...rest] = raw.variants;
  return { ...raw, variants: [{ ...first, response }, ...rest] };
}

// The model sees the record as the one user message's text, so a turn naming { from: 'approved' }
// resolves against the record this very invocation explains, whichever lane it is.
function recordOf(messages: unknown): EvidenceRecord {
  const [first] = JSON.parse(JSON.stringify(messages)) as { content?: { text?: string }[] }[];
  return evidenceRecordSchema.parse(JSON.parse(first?.content?.[0]?.text ?? 'null'));
}

function optionIdOf(turn: Extract<EvalTurn, { kind: 'answer' }>, record: EvidenceRecord): string | undefined {
  if (turn.optionId === undefined || typeof turn.optionId === 'string') return turn.optionId;
  const [option] = record.approvedOptions;
  if (option === undefined) throw new Error('a turn asks for the approved option id of a record that carries none');
  return option.optionId;
}

function fixtureTurnOf(turn: EvalTurn, record: EvidenceRecord): FixtureTurn {
  switch (turn.kind) {
    case 'answer': {
      const optionId = optionIdOf(turn, record);
      const answer = { decision: turn.decision, ...(optionId === undefined ? {} : { optionId }), explanation: turn.explanation };
      return structuredAnswerTurn(answer, FIXTURE_USAGE);
    }
    case 'plain-text':
      return plainTextTurn(turn.text, FIXTURE_USAGE);
    case 'invalid-tool-input':
      return structuredAnswerTurn(turn.input, FIXTURE_USAGE);
    case 'throttle':
      return throttledTurn();
    case 'throw':
      return { events: [], error: () => new Error('the fixture model failed') };
  }
}

// One turn per model call across every invocation of the cycle, in invocation order.
function replayModel(turns: readonly EvalTurn[]): BedrockModelPort {
  let next = 0;
  return {
    async *stream(messages, options) {
      const turn = turns[next];
      next += 1;
      if (turn === undefined) throw new Error('the variant scripts no turn for this model call');
      yield* createFixtureModel([fixtureTurnOf(turn, recordOf(messages))]).stream(messages, options);
    },
  };
}

function sesRecordings(ses: EvalCase['ses'], laneMap: LaneMap): Recording[] {
  const sets = laneMap.lanes.map((lane) => lane.configurationSet);
  const gap = ses.destinations === 'complete' ? undefined : ses.destinations.gap;
  const publishedBy = (set: string) => REQUIRED_EVENT_TYPES.filter((type) => gap?.configurationSet !== set || !gap.missingEventTypes.includes(type));
  return [
    { operation: 'ses.listEmailIdentities', request: null, response: ses.identities.map((facts) => facts.identity) },
    { operation: 'ses.listConfigurationSets', request: null, response: sets },
    ...ses.identities.map(({ identity, ...facts }) => ({ operation: 'ses.getEmailIdentity', request: identity, response: { ...facts, identityType: 'DOMAIN' } })),
    ...sets.map((set) => ({
      operation: 'ses.getConfigurationSetEventDestinations',
      request: set,
      response: [{ name: 'to-eventbridge', enabled: true, eventBridge: true, matchingEventTypes: publishedBy(set) }],
    })),
  ];
}

function dnsRecordings(answers: EvalCase['dns']): Recording[] {
  return answers.map((answer) => ({
    operation: answer.recordType === 'TXT' ? 'dns.resolveTxt' : 'dns.resolveMx',
    request: answer.name,
    response:
      answer.outcome !== 'records'
        ? { kind: answer.outcome }
        : 'records' in answer
          ? { kind: 'records', records: answer.records }
          : { kind: 'records', exchanges: answer.exchanges },
  }));
}

async function ingestScenarios(run: PlannedRun, laneMap: LaneMap, store: FixtureTableState, nowMs: number): Promise<void> {
  const custom = run.evalCase.laneMap === undefined ? {} : { laneMap };
  const deps = buildIngestRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { store }, now: () => nowMs, ...custom });
  for (const scenario of run.variant.scenarios ?? run.evalCase.scenarios) {
    const lane = findLane(laneMap, scenario.configurationSet);
    if (lane === undefined) throw new Error(`the scenario lane ${scenario.configurationSet} is not in the case's lane map`);
    for (const envelope of scenarioEnvelopes(scenario as LaneScenario, nowMs, lane)) {
      const result = await ingestEvent(envelope, deps, { provenance: 'generated' });
      if (result.outcome !== 'stored') throw new Error(`ingest ${result.outcome} a scenario envelope of ${scenario.configurationSet}`);
    }
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function storedOf(decision: DecisionStoreItem | undefined, state: DecisionStoreItem | undefined): { stored: StoredOutcome; explanation: string | undefined } {
  if (decision !== undefined) {
    if (decision.reason === 'cap-reached') return { stored: { kind: 'unavailable', reason: 'cap-reached' }, explanation: undefined };
    const explanation = typeof decision.explanation === 'string' ? decision.explanation : undefined;
    return { stored: { kind: 'validated', decision: decision.outcome === 'close' ? 'close' : 'unknown' }, explanation };
  }
  const last = state?.lastAgentOutcome;
  if (!isRecordObject(last)) return { stored: { kind: 'not-sent' }, explanation: undefined };
  const stored = { kind: 'unavailable', reason: last.reason, ...(last.check === undefined ? {} : { check: last.check }) } as StoredOutcome;
  return { stored, explanation: undefined };
}

async function observeLane(store: ReturnType<typeof buildDetectRoot>['ports']['decisionStore'], configurationSet: string, nowMs: number): Promise<LaneObservation> {
  const incidentId = incidentIdFor(configurationSet, bucketStartMs(nowMs));
  const evidence = await store.getItem(incidentItemKey(incidentId, 'EVIDENCE'), nowMs);
  const parsed = evidenceRecordSchema.safeParse(evidence?.record);
  const decision = await store.getItem(incidentItemKey(incidentId, 'DECISION'), nowMs);
  const state = await store.getItem(incidentItemKey(incidentId, 'STATE'), nowMs);
  return { configurationSet, record: parsed.success ? parsed.data : undefined, ...storedOf(decision, state) };
}

// Per variant: a fresh table, the scenario through the real ingest path, one detection cycle whose
// agentCore row hands the record to the real runtime handler, then the stored items read back.
async function runVariant(run: PlannedRun): Promise<VariantObservation> {
  const nowMs = Date.parse(run.evalCase.now);
  const laneMap = run.evalCase.laneMap === undefined ? COMMITTED_LANES : parseLaneMap(run.evalCase.laneMap);
  const custom = run.evalCase.laneMap === undefined ? {} : { laneMap };
  const store = createFixtureTableState();
  await ingestScenarios(run, laneMap, store, nowMs);

  const handler = createInvocationHandler(buildAgentRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { model: replayModel(run.variant.turns) } }));
  const runtimeResults: RuntimeResult[] = [];
  const deps = buildDetectRoot({
    runtimeContext: 'test',
    switchValue: undefined,
    fixtures: {
      store,
      recordings: { ses: sesRecordings(run.evalCase.ses, laneMap), dns: dnsRecordings(run.evalCase.dns) },
      agentRuntime: async (payload) => {
        const result = await handler(payload);
        runtimeResults.push(result);
        return result;
      },
    },
    liveConfig: { agentRuntimeArn: FIXTURE_RUNTIME_ARN },
    now: () => nowMs,
    wait: async () => {},
    ...custom,
  });
  const summary = await runDetectionCycle(deps);

  const incidentLanes = summary.incidents.map((incident) => incident.configurationSet);
  const lanes: LaneObservation[] = [];
  for (const configurationSet of [...new Set([...Object.keys(run.evalCase.labels), ...incidentLanes])].sort()) {
    lanes.push(await observeLane(deps.ports.decisionStore, configurationSet, nowMs));
  }
  const [first] = runtimeResults;
  return {
    incidentLanes,
    lanes,
    runtime: first === undefined ? undefined : { pinned: first.pinned, promptSha256: first.promptSha256 },
    failures: summary.failures,
  };
}

async function runAll(runs: readonly PlannedRun[]): Promise<Map<PlannedRun, VariantObservation>> {
  const observed = new Map<PlannedRun, VariantObservation>();
  for (const run of runs) observed.set(run, await runVariant(run));
  return observed;
}

function resultsOf(observed: ReadonlyMap<PlannedRun, VariantObservation>): EvalResult[] {
  return [...observed].map(([run, observation]) => evalResultFor(run.evalCase, run.variant, observation));
}

// Codes and counts only, so a failing case names what went wrong without printing a paragraph.
function failureDetail(result: EvalResult, observation: VariantObservation | undefined): string {
  const decisions = observation?.lanes.map((lane) => `${lane.configurationSet}=${lane.record?.decision.outcome ?? 'no-record'}:${lane.record?.decision.reason ?? '-'}`) ?? [];
  return `${result.caseId} ${result.variantId}: lanes ${JSON.stringify(result.lanes)} records ${decisions.join(',')} failures ${observation?.failures ?? -1}`;
}

// A fixed permutation, so the order backstop runs the same shuffled order on every machine.
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const pick = state % (index + 1);
    const held = out[index] as T;
    out[index] = out[pick] as T;
    out[pick] = held;
  }
  return out;
}

function runOf(caseId: string, variantId: string): PlannedRun {
  const run = RUNS.find((candidate) => candidate.evalCase.id === caseId && candidate.variant.id === variantId);
  if (run === undefined) throw new Error(`no eval variant ${caseId} ${variantId}`);
  return run;
}

const CAPTURED_RESPONSE = {
  label: 'captured',
  runtimeSessionId: 'fothering-0123456789abcdef0123456789abcdef-a1',
  capturedAt: '2026-10-14T09:00:00Z',
  traceId: '1-6712f0aa-0123456789abcdef01234567',
  pinned: { ...PINNED_MODEL_VALUES },
  promptSha256: SYSTEM_PROMPT_SHA256,
  usage: FIXTURE_USAGE,
  modelCalls: 1,
};

function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

describe('the eval case schema (AC-E51)', () => {
  it('accepts every case file in the fixtures folder, sorted by id', () => {
    expect(CASES.map((evalCase) => evalCase.id).join(',')).toBe('a01,a02,a03,a04,a05,a06,a07,a08,a09,a10');
  });

  it('accepts a captured response that carries its runtimeSessionId and capturedAt', () => {
    expect(evalCaseSchema.safeParse(withFirstResponse(CAPTURED_RESPONSE)).success).toBe(true);
  });

  it('refuses a captured response without its runtimeSessionId', () => {
    expect(evalCaseSchema.safeParse(withFirstResponse(without(CAPTURED_RESPONSE, 'runtimeSessionId'))).success).toBe(false);
  });

  it('refuses a captured response without its capturedAt timestamp', () => {
    expect(evalCaseSchema.safeParse(withFirstResponse(without(CAPTURED_RESPONSE, 'capturedAt'))).success).toBe(false);
  });

  it('refuses a runtimeSessionId shorter than the 33 characters a session id holds', () => {
    expect(evalCaseSchema.safeParse(withFirstResponse({ ...CAPTURED_RESPONSE, runtimeSessionId: 'x'.repeat(32) })).success).toBe(false);
  });

  it('refuses a response with no label, and a hand-authored one carrying captured ids', () => {
    expect(evalCaseSchema.safeParse(withFirstResponse(without(CAPTURED_RESPONSE, 'label'))).success).toBe(false);
    expect(evalCaseSchema.safeParse(withFirstResponse({ ...CAPTURED_RESPONSE, label: 'hand-authored' })).success).toBe(false);
  });
});

describe('decision path coverage (AC-E52)', () => {
  const lane = (outcome: 'approved' | 'unknown' | 'refused') => ({
    'fothering-bulk': { outcome, reason: 'approved' as const, names: [], fixKind: null, rule: 'approved' as const },
  });

  it('throws for a planted case list with no refused decision', () => {
    const planted = [
      { id: 'a01', labels: lane('approved') },
      { id: 'a02', labels: lane('unknown') },
    ];
    expect(() => assertDecisionPathCoverage(planted)).toThrow(/refused/);
  });

  it('passes over the committed eval set, which covers approved, unknown and refused', () => {
    expect(() => assertDecisionPathCoverage(CASES)).not.toThrow();
  });

  it('holds R14 incidents A1 to A10 with F1 to F4 as variants, fourteen in all', () => {
    expect(RUNS.map((run) => `${run.evalCase.id}/${run.variant.id}`).join(',')).toBe(
      'a01/base,a01/f1,a01/f3,a02/base,a03/base,a03/f4,a04/base,a05/base,a06/base,a06/f2,a07/base,a08/base,a09/base,a10/base',
    );
  });

  it('accepts a planted case list holding approved, unknown and refused', () => {
    const planted = [
      { id: 'a01', labels: lane('approved') },
      { id: 'a02', labels: lane('unknown') },
      { id: 'a03', labels: lane('refused') },
    ];
    expect(() => assertDecisionPathCoverage(planted)).not.toThrow();
  });
});

let baseRun: Promise<VariantObservation> | undefined;

function baseObservation(): Promise<VariantObservation> {
  baseRun ??= runVariant(runOf('a01', 'base'));
  return baseRun;
}

describe('the code verdict reads FAIL when anything is off its label (controls)', () => {
  let observation: VariantObservation;
  const run = runOf('a01', 'base');
  const judged = (evalCase: EvalCase, variant: EvalVariant, seen: VariantObservation = observation) => evalResultFor(evalCase, variant, seen).code;
  const relabelled = (change: Record<string, unknown>): EvalCase => {
    const label = run.evalCase.labels['fothering-bulk'];
    if (label === undefined) throw new Error('a01 labels no fothering-bulk lane');
    return { ...run.evalCase, labels: { 'fothering-bulk': { ...label, ...change } } };
  };

  beforeAll(async () => {
    observation = await baseObservation();
  }, 60_000);

  it('reads PASS on the a01 base observation as labelled', () => {
    expect(judged(run.evalCase, run.variant)).toBe('PASS');
  });

  it('reads FAIL for a label off by its outcome, reason, fix kind or a name the record does not hold', () => {
    expect(judged(relabelled({ outcome: 'unknown' }), run.variant)).toBe('FAIL');
    expect(judged(relabelled({ reason: 'not-settled' }), run.variant)).toBe('FAIL');
    expect(judged(relabelled({ fixKind: 'shared-tag-value' }), run.variant)).toBe('FAIL');
    expect(judged(relabelled({ names: ['import-0915'] }), run.variant)).toBe('FAIL');
  });

  it('reads FAIL for a stored outcome other than the expected one', () => {
    const variant = { ...run.variant, expected: { 'fothering-bulk': { kind: 'validated' as const, decision: 'unknown' as const } } };
    expect(judged(run.evalCase, variant)).toBe('FAIL');
  });

  it('reads FAIL when the cycle opened an unlabelled lane or failed a step', () => {
    expect(judged(run.evalCase, run.variant, { ...observation, incidentLanes: [...observation.incidentLanes, 'fothering-alerts'] })).toBe('FAIL');
    expect(judged(run.evalCase, run.variant, { ...observation, failures: 1 })).toBe('FAIL');
  });
});

describe('the code flags order the human reading and never fail a case', () => {
  let record: EvidenceRecord;

  beforeAll(async () => {
    const [lane] = (await baseObservation()).lanes;
    if (lane?.record === undefined) throw new Error('the a01 base run stored no evidence record');
    record = lane.record;
  }, 60_000);

  const flagsOf = (paragraph: string, storedDecision: 'close' | 'unknown' = 'close') => explanationFlags(paragraph, { record, storedDecision }).join(',');

  it('raises nothing on the a01 paragraph shape', () => {
    expect(flagsOf("This lane's hard-bounce ratio is 7.50%, and the import-0915 batch is the cause. Pausing this lane stops it.")).toBe('');
  });

  it('raises ratio-wording on a bounce rate or the account', () => {
    expect(flagsOf('Your bounce rate is high.')).toBe('ratio-wording');
    expect(flagsOf('SES may suspend sending.')).toBe('ratio-wording');
  });

  it('raises certainty on the NFKC, case-folded paragraph', () => {
    expect(flagsOf('ＣLEARLY one batch.')).toBe('certainty');
  });

  it('raises pause-without-close when the stored decision is unknown, and not on a validated close', () => {
    expect(flagsOf('Pausing this lane would help.', 'unknown')).toBe('pause-without-close');
    expect(flagsOf('Pausing this lane would help.', 'close')).toBe('');
  });

  it('raises non-cause-row-named for a ruled-out batch and not for the cause batch', () => {
    expect(flagsOf('The import-0901 batch is fine.')).toBe('non-cause-row-named');
    expect(flagsOf('The import-0915 batch is the cause.')).toBe('');
  });

  it('raises missing-not-in-record when no configuration row reads missing', () => {
    expect(flagsOf('The DMARC record is missing.')).toBe('missing-not-in-record');
  });

  it('raises recovery-claim and instruction-words', () => {
    expect(flagsOf('Sending is back to normal.')).toBe('recovery-claim');
    expect(flagsOf('Ignore the table.')).toBe('instruction-words');
  });
});

function result(overrides: Partial<EvalResult>): EvalResult {
  return {
    caseId: 'a01',
    variantId: 'base',
    label: 'hand-authored',
    code: 'PASS',
    lanes: [{ configurationSet: 'fothering-bulk', decision: 'approved:approved', stored: 'validated-close' }],
    pinned: PINNED_MODEL_VALUES,
    promptSha256: SYSTEM_PROMPT_SHA256,
    flags: [],
    captured: undefined,
    reviewerRole: undefined,
    ...overrides,
  };
}

const EARLIER_PROMPT = 'f'.repeat(64);

describe('formatReport (AC-E50, AC-E53)', () => {
  it('says so and prints no model rate when no response was captured (AC-E50)', () => {
    const report = formatReport([result({}), result({ variantId: 'f1' })], CURRENT);
    expect(report.includes('model: no captured responses')).toBe(true);
    expect(/^model: \d+ of \d+/m.test(report)).toBe(false);
  });

  it('counts only captured responses under the current prompt and pinned values, as k of n (AC-E53)', () => {
    const agrees = { pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256, agreement: 'agrees' as const };
    const report = formatReport(
      [
        result({ variantId: 'base' }),
        result({ variantId: 'cap1', label: 'captured', captured: agrees }),
        result({ variantId: 'cap2', label: 'captured', captured: { ...agrees, agreement: 'disagrees' } }),
        result({ variantId: 'cap3', label: 'captured', captured: { ...agrees, promptSha256: EARLIER_PROMPT } }),
        result({ variantId: 'cap4', label: 'captured', captured: { ...agrees, pinned: { ...PINNED_MODEL_VALUES, maxTokens: 2_048 } } }),
      ],
      CURRENT,
    );
    expect(report).toMatch(/^model: 1 of 2$/m);
    expect(report).toMatch(/^model: captured under an earlier prompt, not counted: a01 cap3, a01 cap4$/m);
  });

  it('counts a downgrade to unknown as agreeing and names how many there were', () => {
    const downgrade = { pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256, agreement: 'downgrade' as const };
    const report = formatReport([result({ variantId: 'cap1', label: 'captured', captured: downgrade })], CURRENT);
    expect(report).toMatch(/^model: 1 of 1$/m);
    expect(report).toMatch(/^model: downgrades to unknown: 1$/m);
  });

  it('prints code: k of n over every variant', () => {
    const report = formatReport([result({}), result({ variantId: 'f1', code: 'FAIL' }), result({ caseId: 'a02' })], CURRENT);
    expect(report).toMatch(/^code: 2 of 3$/m);
  });

  it('sorts lines by case id then variant id', () => {
    const report = formatReport([result({ caseId: 'a03' }), result({ variantId: 'f3' }), result({}), result({ variantId: 'f1' })], CURRENT);
    const order = report
      .split('\n')
      .filter((line) => /^a\d\d /.test(line))
      .map((line) => line.split(' ').slice(0, 2).join(' '));
    expect(order.join(',')).toBe('a01 base,a01 f1,a01 f3,a03 base');
  });

  it('carries the four pinned values and the prompt hash prefix on every result line (AC-23)', () => {
    const lines = formatReport([result({}), result({ variantId: 'f1' })], CURRENT)
      .split('\n')
      .filter((line) => /^a\d\d /.test(line));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain(`model ${PINNED_MODEL_VALUES.modelId} profile ${PINNED_MODEL_VALUES.profileId}`);
      expect(line).toContain(`maxTokens ${PINNED_MODEL_VALUES.maxTokens} thinking ${PINNED_MODEL_VALUES.thinking}`);
      expect(line).toContain(`prompt ${SYSTEM_PROMPT_SHA256.slice(0, 8)}`);
    }
  });

  it('holds no percent sign, mean or average, and says when no outside practitioner reviewed the paragraphs', () => {
    const report = formatReport([result({ flags: ['certainty'] }), result({ variantId: 'f1', reviewerRole: 'owner-ses-operator' })], CURRENT);
    expect(/%|mean|average/i.test(report)).toBe(false);
    expect(report.split('\n')[0]).toContain('no outside deliverability practitioner reviewed them');
  });
});

describe('the eval set through ingest, detection and the runtime (AC-23, R14)', () => {
  let observed = new Map<PlannedRun, VariantObservation>();

  beforeAll(async () => {
    observed = await runAll(RUNS);
  }, 600_000);

  for (const run of RUNS) {
    it(`${run.evalCase.id} ${run.variant.id} decides as labelled and stores the expected agent outcome`, () => {
      const observation = observed.get(run);
      if (observation === undefined) throw new Error('the variant did not run');
      const evalResult = evalResultFor(run.evalCase, run.variant, observation);
      expect(evalResult.code, failureDetail(evalResult, observation)).toBe('PASS');
      expect(evalResult.pinned).toEqual(PINNED_MODEL_VALUES);
      expect(evalResult.promptSha256).toBe(SYSTEM_PROMPT_SHA256);
    });
  }

  it('prints the report once, with code: n of n over every variant and no model rate', () => {
    const report = formatReport(resultsOf(observed), CURRENT);
    console.log(report);
    expect(report).toMatch(new RegExp(`^code: ${RUNS.length} of ${RUNS.length}$`, 'm'));
    expect(report.includes('model: no captured responses')).toBe(true);
  });

  it('gives the same sorted results over a shuffled case list (R14 backstop)', async () => {
    const reordered = await runAll(shuffled(RUNS, 2_026));
    expect(formatReport(resultsOf(reordered), CURRENT)).toBe(formatReport(resultsOf(observed), CURRENT));
  }, 600_000);
});
