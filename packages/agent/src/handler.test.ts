import { createHash } from 'node:crypto';
import { format } from 'node:util';
import { configureLogging, type ModelStreamEvent, type Usage } from '@strands-agents/sdk';
import { describe, expect, it, vi } from 'vitest';
import { runtimeResultSchema, validateDecision, type RuntimeResult } from '@fothering/core/agent-answer';
import { bucketStartMs, isCountedRecord } from '@fothering/core/buckets';
import { REQUIRED_EVENT_TYPES, checkCloseability, type SesConfigurationFacts } from '@fothering/core/closeability';
import { decideLane } from '@fothering/core/decision';
import {
  RECORD_BYTE_CEILING,
  buildEvidenceRecord,
  canonicalJson,
  counterDayKey,
  evidenceRecordSchema,
  incidentIdFor,
  incidentItemKey,
  optionIdFor,
  recordHash,
  serializedRecordBytes,
  type EvidenceRecord,
  type EvidenceRecordInput,
} from '@fothering/core/evidence-record';
import { buildTagRows } from '@fothering/core/evidence-rows';
import { parseLaneMap } from '@fothering/core/lanes';
import { MODEL_VALUES, PINNED_MODEL_VALUES, TOKEN_RESERVATION_PER_INVOCATION } from '@fothering/core/model-values';
import { RETENTION_SECONDS } from '@fothering/core/records';
import { scenarioRecords, type LaneScenario } from '@fothering/core/test/event-arbitraries';
import { LANE_RATIO_LABELS, LANE_SHARE_LABEL, laneSpikeVerdict, renderPercent } from '@fothering/core/verdicts';
import { createWindowFold, spikeWindowFor, summarizeWindow } from '@fothering/core/window-fold';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  createFixtureModel,
  plainTextTurn,
  structuredAnswerTurn,
  throttledTurn,
  type FixtureModel,
  type FixtureTurn,
} from '@fothering/providers/fixtures/fixture-model';
import type { BedrockModelPort, Recording } from '@fothering/providers/port-types';
import { TEST_ADDRESS_KEY_SET, createFixtureTableState } from '@fothering/providers/fixtures/ingest-ports';
import { runDetectionCycle } from '@fothering/functions/detect/detect';
import { buildDetectRoot } from '@fothering/functions/detect/root';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import completeSesConfig from '../../providers/src/fixtures/ses-config/complete.json' with { type: 'json' };
import { SYSTEM_PROMPT, SYSTEM_PROMPT_SHA256, createInvocationHandler } from './handler.js';
import { buildAgentRoot } from './root.js';

const LANES = parseLaneMap(lanesJson);
const BULK = 'fothering-bulk';
const TRACER_NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);
const USAGE = { inputTokens: 1_850, outputTokens: 96, totalTokens: 1_946 };

const ONE_BAD_BATCH: LaneScenario = {
  configurationSet: BULK,
  streamTag: 'newsletter',
  callerIdentity: 'bulk-sender',
  fromDomain: 'news.example.com',
  groups: [
    { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
    { bucketOffset: 1, count: 160, batch: 'import-0901' },
  ],
};

const BULK_SES_FACTS: SesConfigurationFacts = {
  configurationSets: new Set(LANES.lanes.map((lane) => lane.configurationSet)),
  defaultConfigurationSets: new Set(),
  eventDestinations: new Map([[BULK, [{ enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] }]]]),
};

// The tracer's record, built by the same core path detection runs (plan 02-02): one bad import batch
// on fothering-bulk, a 7.50% lane ratio over 200 recipient-sends and one approved option.
function tracerRecord(): EvidenceRecord {
  const records = scenarioRecords(ONE_BAD_BATCH, TRACER_NOW_MS, LANES, TEST_ADDRESS_KEY_SET);
  const window = spikeWindowFor(TRACER_NOW_MS);
  const fold = createWindowFold({ lane: BULK, window, nowMs: TRACER_NOW_MS });
  const summary = summarizeWindow(fold.step(fold.initial, records));
  const spike = laneSpikeVerdict(summary.totals);
  const rows = buildTagRows('batch', summary, spike);
  const closeability = checkCloseability(BULK, { laneMap: LANES, observed: new Map([[BULK, summary.observed]]), ses: BULK_SES_FACTS });
  const decision = decideLane({ spike, rows, configurationRows: [], closeability, coverageNoData: false, bound: null, otherSpikingLanes: [] });
  const countable = records.filter(isCountedRecord).length;
  return buildEvidenceRecord({
    incidentId: incidentIdFor(BULK, bucketStartMs(TRACER_NOW_MS)),
    lane: { configurationSet: BULK, lane: BULK },
    window,
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
    share: { laneCountableEvents: countable, storedCountableEvents: countable, percent: renderPercent(countable, countable), label: LANE_SHARE_LABEL },
    rows,
    configurationRows: [],
    isolation: 'confined',
    decision: { ...decision, noData: false, bound: null, otherSpikingLanes: [], sharedCause: null },
    question: null,
    fix: null,
    expiresAt: Math.floor(TRACER_NOW_MS / 1000) + RETENTION_SECONDS,
  });
}

function approvedIdOf(record: EvidenceRecord): string {
  const [option] = record.approvedOptions;
  if (option === undefined) throw new Error('the tracer record carries no approved option');
  return option.optionId;
}

const TRACER_EXPLANATION =
  "This lane's hard-bounce ratio is 7.50% over 200 recipient-sends, and the import-0915 batch is the cause; pausing this lane stops that batch while the rest of the mail waits.";

function closeAnswer(record: EvidenceRecord, explanation: string = TRACER_EXPLANATION): unknown {
  return { decision: 'close', optionId: approvedIdOf(record), explanation };
}

function testHandler(turns: readonly FixtureTurn[], options?: { deadlineSignal?: AbortSignal }) {
  const fixture = createFixtureModel(turns);
  const deps = buildAgentRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { model: fixture } });
  return { fixture, handler: createInvocationHandler(deps, options) };
}

describe('tracer, agent half: the runtime explains the evidence record and returns a validated close', () => {
  it('answers the tracer record with a close on its one approved option, the pinned values and one model call', async () => {
    const record = tracerRecord();
    const { fixture, handler } = testHandler([structuredAnswerTurn(closeAnswer(record), USAGE)]);

    const result = await handler(JSON.parse(JSON.stringify(record)));

    expect(result.status).toBe('answered');
    expect(runtimeResultSchema.parse(result)).toEqual(result);
    if (result.status !== 'answered') return;
    const check = validateDecision(result.answer, record.approvedOptions.map((option) => option.optionId));
    expect(check.ok).toBe(true);
    expect((result.answer as { optionId?: string }).optionId).toBe(approvedIdOf(record));
    expect(result.pinned).toEqual(PINNED_MODEL_VALUES);
    expect(result.pinned).toEqual({ modelId: 'anthropic.claude-sonnet-5', profileId: 'eu.anthropic.claude-sonnet-5', maxTokens: 1024, thinking: 'disabled' });
    expect(result.promptSha256).toBe(SYSTEM_PROMPT_SHA256);
    expect(result.promptSha256).toBe(createHash('sha256').update(SYSTEM_PROMPT, 'utf8').digest('hex'));
    expect(result.usage).toEqual(USAGE);
    for (const count of Object.values(result.usage)) expect(Number.isInteger(count)).toBe(true);
    expect(result.modelCalls).toBe(1);

    // D-72: one user message holding the canonical record alone, the system prompt, one tool spec.
    expect(fixture.calls).toHaveLength(1);
    const [call] = fixture.calls;
    expect(call?.messages).toHaveLength(1);
    const [message] = call?.messages ?? [];
    expect(message?.role).toBe('user');
    expect(message?.content).toHaveLength(1);
    expect((message?.content[0] as { text?: string } | undefined)?.text).toBe(canonicalJson(record));
    expect(call?.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(call?.toolSpecs?.map((spec) => spec.name).join(',')).toBe('strands_structured_output');
  });
});

const FIXTURE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:000000000000:runtime/fixture-runtime';
const COMPLETE_SES_RECORDINGS = completeSesConfig.recordings as readonly Recording[];
// The four lookups the bad batch's opening cycle plans: news.example.com's DMARC record, the
// organizational one, the SPF record on the custom MAIL FROM domain and the MX of example.com.
const TRACER_DNS_RECORDINGS: readonly Recording[] = [
  { operation: 'dns.resolveTxt', request: '_dmarc.news.example.com', response: { kind: 'missing' } },
  { operation: 'dns.resolveTxt', request: '_dmarc.example.com', response: { kind: 'records', records: ['v=DMARC1; p=none'] } },
  { operation: 'dns.resolveTxt', request: 'bounce.example.com', response: { kind: 'records', records: ['v=spf1 include:amazonses.com ~all'] } },
  { operation: 'dns.resolveMx', request: 'example.com', response: { kind: 'missing' } },
];
const AGENT_CORE_LINE = '(dry-run) WOULD agentCore.invokeAgentRuntime ';

// The detection half: the real detection root and the real runtime handler share nothing but the
// fixture agentCore row's in-process route, so the record crosses as JSON exactly as it would to AgentCore.
describe('tracer, end to end: one detection cycle stores a validated close from the real runtime handler', () => {
  it('folds the lanes, writes the evidence, reserves once, invokes the runtime handler and stores the validated close', async () => {
    const incidentId = incidentIdFor(BULK, bucketStartMs(TRACER_NOW_MS));
    const optionId = optionIdFor(incidentId, 0);
    const model = createFixtureModel([structuredAnswerTurn({ decision: 'close', optionId, explanation: TRACER_EXPLANATION }, USAGE)]);
    const agentDeps = buildAgentRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { model } });
    const dryRunLines: string[] = [];
    const deps = buildDetectRoot({
      runtimeContext: 'test',
      switchValue: undefined,
      fixtures: {
        store: createFixtureTableState(),
        recordings: { ses: COMPLETE_SES_RECORDINGS, dns: TRACER_DNS_RECORDINGS },
        agentRuntime: createInvocationHandler(agentDeps),
      },
      liveConfig: { agentRuntimeArn: FIXTURE_RUNTIME_ARN },
      dryRunSink: (line) => dryRunLines.push(line),
      now: () => TRACER_NOW_MS,
      wait: async () => {},
    });
    for (const record of scenarioRecords(ONE_BAD_BATCH, TRACER_NOW_MS, LANES, TEST_ADDRESS_KEY_SET)) await deps.ports.eventStore.putIfAbsent(record);
    const queryLane = vi.spyOn(deps.ports.eventStore, 'queryLane');

    const summary = await runDetectionCycle(deps);

    const decision = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'DECISION'), TRACER_NOW_MS);
    expect(decision?.outcome ?? 'no DECISION item').toBe('close');
    expect(decision?.optionId).toBe(optionId);
    expect(decision).toMatchObject({
      explanation: TRACER_EXPLANATION,
      pinned: PINNED_MODEL_VALUES,
      promptSha256: SYSTEM_PROMPT_SHA256,
      usage: USAGE,
      modelCalls: 1,
      attempt: 1,
      decidedAtMs: TRACER_NOW_MS,
    });
    for (const count of Object.values(decision?.usage as Record<string, unknown>)) expect(Number.isInteger(count)).toBe(true);

    const evidence = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'EVIDENCE'), TRACER_NOW_MS);
    const record = evidenceRecordSchema.parse(evidence?.record);
    expect(recordHash(record)).toBe(record.hash);
    expect(record.approvedOptions).toEqual([{ optionId }]);

    expect(TOKEN_RESERVATION_PER_INVOCATION).toBe(64_512);
    const incidentCounter = await deps.ports.decisionStore.getItem(incidentItemKey(incidentId, 'COUNTER'), TRACER_NOW_MS);
    const dayCounter = await deps.ports.decisionStore.getItem(counterDayKey('2026-10-11'), TRACER_NOW_MS);
    expect(incidentCounter?.invocations).toBe(1);
    expect(dayCounter).toMatchObject({ invocations: 1, tokenReservations: 64_512 });

    expect(dryRunLines.filter((line) => line.startsWith(AGENT_CORE_LINE))).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    expect(queryLane).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ incidentsOpened: 1, invocations: 1, sesReads: 7, dnsLookups: 4, outcomes: [{ incidentId, result: 'close' }] });
    expect(summary.lanes.map((lane) => `${lane.configurationSet}:${lane.verdict}`).join(' ')).toBe(
      'fothering-transactional:not-enough-volume fothering-bulk:spike fothering-alerts:not-enough-volume',
    );
  });
});

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const REBUILT_KEYS =new Set(['schemaVersion', 'approvedOptions', 'hash']);

function rebuilt(record: EvidenceRecord, changes: Partial<EvidenceRecordInput>): EvidenceRecord {
  const input = Object.fromEntries(Object.entries(record).filter(([key]) => !REBUILT_KEYS.has(key))) as EvidenceRecordInput;
  return buildEvidenceRecord({ ...input, ...changes });
}

// A schema-valid record of exactly `target` canonical bytes: padding rows hold long, pattern-valid
// tag values, and the last row's value and the lane name take up the remainder byte for byte.
function recordOfBytes(target: number): EvidenceRecord {
  const base = tracerRecord();
  const [template] = base.rows;
  if (template === undefined) throw new Error('the tracer record holds no row to copy');
  const padRow = (index: number, length: number) => ({
    ...template,
    verdict: 'not-enough-volume' as const,
    thresholds: [],
    value: `pad-${index}-`.padEnd(length, 'x'),
  });
  const sized = (rows: EvidenceRecord['rows'], laneName: string = BULK) =>
    rebuilt(base, { rows: [...base.rows, ...rows], lane: { configurationSet: BULK, lane: laneName } });

  const rows: EvidenceRecord['rows'] = [];
  while (serializedRecordBytes(sized([...rows, padRow(rows.length, 64)])) <= target) rows.push(padRow(rows.length, 64));
  let remaining = target - serializedRecordBytes(sized(rows));
  const widen = Math.min(remaining, 192);
  rows[rows.length - 1] = padRow(rows.length - 1, 64 + widen);
  remaining -= widen;
  const record = sized(rows, `${BULK}${'x'.repeat(remaining)}`);
  expect(serializedRecordBytes(record)).toBe(target);
  return record;
}

function toolTurn(input: string, usage: Usage): FixtureTurn {
  const events: ModelStreamEvent[] = [
    { type: 'modelMessageStartEvent', role: 'assistant' },
    { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'fixture-use-raw' } },
    { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input } },
    { type: 'modelContentBlockStopEvent' },
    { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
    { type: 'modelMetadataEvent', usage },
  ];
  return { events };
}

function throwingTurn(message: string): FixtureTurn {
  return { events: [], error: () => new Error(message) };
}

function failureOf(result: RuntimeResult): string {
  return result.status === 'failed' || result.status === 'refused' ? `${result.status}:${result.reason}` : result.status;
}

function promptBytesOf(fixture: FixtureModel): { prompt: number; promptAndSpec: number; input: number } {
  const [call] = fixture.calls;
  const prompt = Buffer.byteLength(String(call?.systemPrompt), 'utf8');
  const spec = Buffer.byteLength(JSON.stringify(call?.toolSpecs), 'utf8');
  const text = (call?.messages[0]?.content[0] as { text?: string } | undefined)?.text ?? '';
  return { prompt, promptAndSpec: prompt + spec, input: prompt + spec + Buffer.byteLength(text, 'utf8') };
}

describe('the handler refuses a payload before any model is built', () => {
  it('refuses {} as payload-invalid with the pinned values, zero usage and no model call', async () => {
    const { fixture, handler } = testHandler([]);
    const result = await handler({});
    expect(failureOf(result)).toBe('refused:payload-invalid');
    expect(runtimeResultSchema.parse(result)).toEqual({
      status: 'refused',
      reason: 'payload-invalid',
      pinned: PINNED_MODEL_VALUES,
      promptSha256: SYSTEM_PROMPT_SHA256,
      usage: ZERO_USAGE,
      modelCalls: 0,
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it('refuses a record with one field changed under its old hash as hash-mismatch', async () => {
    const record = tracerRecord();
    const tampered = { ...record, laneTotals: { ...record.laneTotals, recipientSends: record.laneTotals.recipientSends + 1 } };
    const { fixture, handler } = testHandler([]);
    const result = await handler(tampered);
    expect(failureOf(result)).toBe('refused:hash-mismatch');
    expect(runtimeResultSchema.parse(result)).toMatchObject({ pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256, usage: ZERO_USAGE, modelCalls: 0 });
    expect(fixture.calls).toHaveLength(0);
  });

  it('refuses a schema-valid record past RECORD_BYTE_CEILING as record-too-large', async () => {
    const record = recordOfBytes(RECORD_BYTE_CEILING + 600);
    const { fixture, handler } = testHandler([]);
    const result = await handler(record);
    expect(failureOf(result)).toBe('refused:record-too-large');
    expect(runtimeResultSchema.parse(result)).toMatchObject({ pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256, usage: ZERO_USAGE, modelCalls: 0 });
    expect(fixture.calls).toHaveLength(0);
  });

  // Steelman S3: every record the size check admits must fit the wrapper's input guard on its first
  // call, with the real prompt and tool spec, or a valid record would fail as input-ceiling.
  it('answers a record of exactly RECORD_BYTE_CEILING bytes in one call, inside the input guard', async () => {
    const record = recordOfBytes(RECORD_BYTE_CEILING);
    const { fixture, handler } = testHandler([structuredAnswerTurn(closeAnswer(record), USAGE)]);
    const result = await handler(record);
    const measured = promptBytesOf(fixture);
    const sizes = `record ${serializedRecordBytes(record)} bytes, guard input ${measured.input} of ${MODEL_VALUES.inputTokenCeiling} bytes`;
    expect(failureOf(result), sizes).toBe('answered');
    expect(result.status === 'answered' ? result.modelCalls : -1, sizes).toBe(1);
    expect(measured.input, sizes).toBeLessThanOrEqual(MODEL_VALUES.inputTokenCeiling);
  });
});

describe('the deployed runtime with the switch unset answers dry-run', () => {
  it('writes one bedrockModel.stream dry-run line and builds no model', async () => {
    const lines: string[] = [];
    const deps = buildAgentRoot({ runtimeContext: 'deployed', switchValue: undefined, dryRunSink: (line) => lines.push(line), logSink: () => {} });
    expect(deps.kinds.bedrockModel?.stream).toBe('dry-run');
    const result = await createInvocationHandler(deps)(tracerRecord());

    expect(runtimeResultSchema.parse(result)).toEqual({ status: 'dry-run', pinned: PINNED_MODEL_VALUES, promptSha256: SYSTEM_PROMPT_SHA256 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('(dry-run) WOULD bedrockModel.stream eu.anthropic.claude-sonnet-5 ')).toBe(true);
    expect(lines[0]).toContain('"messageCount":1');
  });
});

describe('the handler maps every loop outcome to a result', () => {
  it('answers after plain text and the forced tool turn, in two calls', async () => {
    const record = tracerRecord();
    const { fixture, handler } = testHandler([plainTextTurn('a free answer', USAGE), structuredAnswerTurn(closeAnswer(record), USAGE)]);
    const result = runtimeResultSchema.parse(await handler(record));
    expect(failureOf(result)).toBe('answered');
    expect(result.status === 'answered' ? result.modelCalls : -1).toBe(2);
    expect(JSON.stringify(fixture.calls[1]?.toolChoice)).toBe(JSON.stringify({ tool: { name: STRUCTURED_OUTPUT_TOOL_NAME } }));
  });

  it('answers after an invalid tool input and a corrected answer, in two calls', async () => {
    const record = tracerRecord();
    const invalid = structuredAnswerTurn({ decision: 'maybe', explanation: 'not a decision' }, USAGE);
    const { handler } = testHandler([invalid, structuredAnswerTurn(closeAnswer(record), USAGE)]);
    const result = runtimeResultSchema.parse(await handler(record));
    expect(failureOf(result)).toBe('answered');
    expect(result.status === 'answered' ? result.modelCalls : -1).toBe(2);
  });

  it('answers after one throttled call and its retry, in two calls', async () => {
    const record = tracerRecord();
    const { handler } = testHandler([throttledTurn(), structuredAnswerTurn(closeAnswer(record), USAGE)]);
    const result = runtimeResultSchema.parse(await handler(record));
    expect(failureOf(result)).toBe('answered');
    expect(result.status === 'answered' ? result.modelCalls : -1).toBe(2);
  });

  it('fails structured-output when the model answers in plain text twice', async () => {
    const { handler } = testHandler([plainTextTurn('first', USAGE), plainTextTurn('second', USAGE)]);
    const result = runtimeResultSchema.parse(await handler(tracerRecord()));
    expect(failureOf(result)).toBe('failed:structured-output');
    expect(result.status === 'failed' ? result.modelCalls : -1).toBe(2);
  });

  it('fails model-error when a model call throws', async () => {
    const { handler } = testHandler([throwingTurn('the provider fell over')]);
    const result = runtimeResultSchema.parse(await handler(tracerRecord()));
    expect(failureOf(result)).toBe('failed:model-error');
    expect(JSON.stringify(result)).not.toContain('fell over');
  });

  // AC-E34, runtime half. Throttling retries happen inside one cycle, so a throttle in each of the two
  // cycles the turn limit allows asks for a fourth call, which the wrapper refuses before the port.
  it('stops at the call ceiling: a script reaching for a fourth call fails model-call-ceiling after three', async () => {
    const record = tracerRecord();
    const { fixture, handler } = testHandler([throttledTurn(), plainTextTurn('free text', USAGE), throttledTurn(), structuredAnswerTurn(closeAnswer(record), USAGE)]);
    const result = runtimeResultSchema.parse(await handler(record));
    expect(failureOf(result)).toBe('failed:model-call-ceiling');
    const modelCalls = result.status === 'failed' ? result.modelCalls : -1;
    expect(modelCalls).toBe(MODEL_VALUES.modelCallCeiling);
    expect(fixture.calls).toHaveLength(modelCalls);
  });

  it('fails deadline when the loop deadline has already passed, and the result parses', async () => {
    const record = tracerRecord();
    const { fixture, handler } = testHandler([structuredAnswerTurn(closeAnswer(record), USAGE)], { deadlineSignal: AbortSignal.abort() });
    const result = await handler(record);
    expect(failureOf(result)).toBe('failed:deadline');
    expect(runtimeResultSchema.safeParse(result).success).toBe(true);
    expect(fixture.calls).toHaveLength(0);
  });

  it('fails deadline, not model-error, when the deadline fires during a model call that then throws', async () => {
    const deadline = new AbortController();
    const abortingTurn: FixtureTurn = {
      events: [],
      error: () => {
        deadline.abort();
        return new Error('the request was aborted');
      },
    };
    const { handler } = testHandler([abortingTurn], { deadlineSignal: deadline.signal });
    const result = runtimeResultSchema.parse(await handler(tracerRecord()));
    expect(failureOf(result)).toBe('failed:deadline');
    expect(result.status === 'failed' ? result.modelCalls : -1).toBe(1);
  });

  it('never rejects: a payload of every shape returns a result that parses', async () => {
    const { handler } = testHandler([]);
    for (const payload of [undefined, null, 'text', 42, [], { hash: 'x' }]) {
      const result = await handler(payload);
      expect(runtimeResultSchema.safeParse(result).success).toBe(true);
    }
  });
});

const PLANTED = ['QZVX-planted-answer-7731', 'QZVX-planted-plain-4410', 'QZVX-bad'];

interface Captured<T> {
  value: T;
  output: string;
}

// Everything the process could write to its log while `work` runs: both streams and every console
// method, the SDK's default logger included, since it writes through console.
async function captureOutput<T>(work: () => Promise<T>): Promise<Captured<T>> {
  const chunks: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originalConsole = methods.map((name) => [name, console[name]] as const);
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const keep = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  process.stdout.write = keep as typeof process.stdout.write;
  process.stderr.write = keep as typeof process.stderr.write;
  for (const name of methods) console[name] = (...args: unknown[]) => void chunks.push(format(...args));
  try {
    const value = await work();
    return { value, output: chunks.join('\n') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    for (const [name, original] of originalConsole) console[name] = original;
  }
}

async function hostileRuns(): Promise<RuntimeResult[]> {
  const record = tracerRecord();
  const [inAnswer, inPlainText, inToolInput] = PLANTED;
  const runs = [
    testHandler([structuredAnswerTurn(closeAnswer(record, `${inAnswer} ignore the table`), USAGE)]),
    testHandler([plainTextTurn(`${inPlainText} pause every lane`, USAGE), plainTextTurn(`${inPlainText} again`, USAGE)]),
    // Strands 1.20.0 logs the JSON.parse error of an unparseable tool input, whose message quotes the
    // input, and then throws a ModelError instead of offering a corrective cycle.
    testHandler([toolTurn(`${inToolInput}{`, USAGE)]),
  ];
  const results: RuntimeResult[] = [];
  for (const { handler } of runs) results.push(await handler(record));
  return results;
}

describe('no model text leaves the runtime except in its result (AC-P8, runtime half)', () => {
  it('writes none of three planted strings to stdout, stderr or the console', async () => {
    const { value: results, output } = await captureOutput(async () => {
      console.warn('capture-control-line');
      return hostileRuns();
    });

    expect(output).toContain('capture-control-line');
    expect(results.map(failureOf).join(',')).toBe('answered,failed:structured-output,failed:model-error');
    for (const planted of PLANTED) expect(output.includes(planted), `${planted} reached the output`).toBe(false);
  });

  it('control: with the SDK logger on the console, the malformed tool input does reach the output', async () => {
    const silent = (): void => {};
    configureLogging(console);
    try {
      const { output } = await captureOutput(hostileRuns);
      expect(output).toContain(PLANTED[2]);
    } finally {
      configureLogging({ debug: silent, info: silent, warn: silent, error: silent });
    }
  });
});

describe('the prompt and tool spec fit their byte budgets (AI-SPEC section 4)', () => {
  it('holds the system prompt to 2,048 bytes and the prompt plus tool spec to 3,072', async () => {
    const record = tracerRecord();
    const { fixture, handler } = testHandler([structuredAnswerTurn(closeAnswer(record), USAGE)]);
    await handler(record);
    const { prompt, promptAndSpec } = promptBytesOf(fixture);
    const sizes = `system prompt ${prompt} bytes, prompt plus tool spec ${promptAndSpec} bytes`;
    expect(Buffer.byteLength(SYSTEM_PROMPT, 'utf8'), sizes).toBe(prompt);
    expect(prompt, sizes).toBeLessThanOrEqual(MODEL_VALUES.systemPromptByteBudget);
    expect(promptAndSpec, sizes).toBeLessThanOrEqual(MODEL_VALUES.promptAndToolSpecByteBudget);
  });
});

// Routes each call to the script of the record its one user message holds, so two invocations of one
// handler can each run their own script while sharing the handler's single fixture row.
function routedPort(routes: ReadonlyMap<string, FixtureModel>): BedrockModelPort {
  return {
    async *stream(messages, options) {
      const text = JSON.stringify(messages[0]);
      const target = [...routes].find(([incidentId]) => text.includes(incidentId))?.[1];
      if (target === undefined) throw new Error('no script for this record');
      yield* target.stream(messages, options);
    },
  };
}

describe('two invocations in flight on one handler (R9 concurrency backstop)', () => {
  it('keep separate model-call counts and neither prompt holds the other record', async () => {
    const first = tracerRecord();
    const second = rebuilt(first, { incidentId: incidentIdFor(BULK, bucketStartMs(TRACER_NOW_MS) - 300_000) });
    const firstScript = createFixtureModel([plainTextTurn('free text', USAGE), structuredAnswerTurn(closeAnswer(first), USAGE)]);
    const secondScript = createFixtureModel([structuredAnswerTurn(closeAnswer(second), USAGE)]);
    const model = routedPort(new Map([[first.incidentId, firstScript], [second.incidentId, secondScript]]));
    const handler = createInvocationHandler(buildAgentRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { model } }));

    const [firstResult, secondResult] = await Promise.all([handler(first), handler(second)]);

    expect([failureOf(firstResult), failureOf(secondResult)].join(',')).toBe('answered,answered');
    expect(firstResult.status === 'answered' ? firstResult.modelCalls : -1).toBe(2);
    expect(secondResult.status === 'answered' ? secondResult.modelCalls : -1).toBe(1);
    expect(firstScript.calls).toHaveLength(2);
    expect(secondScript.calls).toHaveLength(1);
    for (const call of firstScript.calls) expect(JSON.stringify(call.messages).includes(second.incidentId)).toBe(false);
    for (const call of secondScript.calls) expect(JSON.stringify(call.messages).includes(first.incidentId)).toBe(false);
  });
});
