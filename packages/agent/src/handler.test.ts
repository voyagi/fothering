import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runtimeResultSchema, validateDecision } from '@fothering/core/agent-answer';
import { bucketStartMs, isCountedRecord } from '@fothering/core/buckets';
import { REQUIRED_EVENT_TYPES, checkCloseability, type SesConfigurationFacts } from '@fothering/core/closeability';
import { decideLane } from '@fothering/core/decision';
import { buildEvidenceRecord, canonicalJson, incidentIdFor, type EvidenceRecord } from '@fothering/core/evidence-record';
import { buildTagRows } from '@fothering/core/evidence-rows';
import { parseLaneMap } from '@fothering/core/lanes';
import { PINNED_MODEL_VALUES } from '@fothering/core/model-values';
import { RETENTION_SECONDS } from '@fothering/core/records';
import { scenarioRecords, type LaneScenario } from '@fothering/core/test/event-arbitraries';
import { LANE_RATIO_LABELS, LANE_SHARE_LABEL, laneSpikeVerdict, renderPercent } from '@fothering/core/verdicts';
import { createWindowFold, spikeWindowFor, summarizeWindow } from '@fothering/core/window-fold';
import { createFixtureModel, structuredAnswerTurn, type FixtureTurn } from '@fothering/providers/fixtures/fixture-model';
import { TEST_ADDRESS_KEY_SET } from '@fothering/providers/fixtures/ingest-ports';
import lanesJson from '../../../lanes.json' with { type: 'json' };
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

function testHandler(turns: readonly FixtureTurn[]) {
  const fixture = createFixtureModel(turns);
  const deps = buildAgentRoot({ runtimeContext: 'test', switchValue: undefined, fixtures: { model: fixture } });
  return { fixture, handler: createInvocationHandler(deps) };
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
