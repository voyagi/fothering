import { bucketStartMs, isCountedRecord } from '../buckets.js';
import { REQUIRED_EVENT_TYPES, checkCloseability, type SesConfigurationFacts } from '../closeability.js';
import { assembleEvidenceRecord, decideCycle, decideLane, laneTotalsOf, type LaneAnalysis } from '../decision.js';
import { buildEvidenceRecord, incidentIdFor, type EvidenceRecord } from '../evidence-record.js';
import { buildLaneConfigurationRows, buildProviderRows, buildTagRows, type DnsTxtOutcome, type IdentityAuthFacts } from '../evidence-rows.js';
import { findLane, parseLaneMap, type LaneEntry, type LaneMap } from '../lanes.js';
import { RETENTION_SECONDS, type EventRecord } from '../records.js';
import { LANE_SHARE_LABEL, coverageVerdict, laneSpikeVerdict, renderPercent } from '../verdicts.js';
import { createWindowFold, spikeWindowFor, summarizeWindow } from '../window-fold.js';
import { TEST_KEY_SET, scenarioRecords, type ScenarioGroup } from './event-arbitraries.js';
import lanesJson from '../../../../lanes.json' with { type: 'json' };

export const CYCLE_NOW_MS = Date.UTC(2026, 9, 11, 12, 2, 0);

export interface LaneStory {
  configurationSet: string;
  fromDomain: string;
  groups: readonly ScenarioGroup[];
}

export interface CycleStory {
  lanes: readonly LaneStory[];
  identities?: readonly IdentityAuthFacts[];
  txtAnswers?: Readonly<Record<string, DnsTxtOutcome>>;
}

export interface BuiltCycle {
  analyses: LaneAnalysis[];
  records: EventRecord[];
}

// Every set the lane map lists, each publishing every required event type to EventBridge and none a
// default set, so a lane's closeability turns only on what its own lane entry and records show.
function sesFactsFor(laneMap: LaneMap): SesConfigurationFacts {
  const sets = laneMap.lanes.map((lane) => lane.configurationSet);
  return {
    configurationSets: new Set(sets),
    defaultConfigurationSets: new Set(),
    eventDestinations: new Map(sets.map((set) => [set, [{ enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] }]])),
  };
}

function laneEntry(laneMap: LaneMap, configurationSet: string): LaneEntry & { stream: string } {
  const lane = findLane(laneMap, configurationSet);
  const stream = lane?.declaredStreams[0];
  if (lane === undefined || stream === undefined) throw new Error(`the story's lane ${configurationSet} is not in the lane map`);
  return { ...lane, stream };
}

/**
 * One detection cycle's analyses, built the way detection builds them: the scenario's records through
 * the real fold, every tag dimension and the provider rows, configuration rows when the story gives
 * identities, and closeability over every story lane's observed facts. Each lane gets its own caller so
 * no lane is refused for sharing one.
 */
export function cycleOf(laneMap: LaneMap, story: CycleStory, options: { reverseRecords?: boolean } = {}): BuiltCycle {
  const window = spikeWindowFor(CYCLE_NOW_MS);
  const folded = story.lanes.map((laneStory) => {
    const { stream, ...lane } = laneEntry(laneMap, laneStory.configurationSet);
    const records = scenarioRecords(
      { configurationSet: lane.configurationSet, streamTag: stream, callerIdentity: `${lane.configurationSet}-sender`, fromDomain: laneStory.fromDomain, groups: laneStory.groups },
      CYCLE_NOW_MS,
      laneMap,
      TEST_KEY_SET,
    );
    const fold = createWindowFold({ lane: lane.configurationSet, window, nowMs: CYCLE_NOW_MS });
    const summary = summarizeWindow(fold.step(fold.initial, options.reverseRecords === true ? [...records].reverse() : records));
    return { lane, records, summary };
  });
  const observed = new Map(folded.map(({ lane, summary }) => [lane.configurationSet, summary.observed]));
  const ses = sesFactsFor(laneMap);
  const txtAnswers = new Map(Object.entries(story.txtAnswers ?? {}));
  const analyses = folded.map(({ lane, summary }): LaneAnalysis => {
    const spike = laneSpikeVerdict(summary.totals);
    return {
      lane,
      summary,
      spike,
      rows: [
        ...buildTagRows('batch', summary, spike),
        ...buildTagRows('template', summary, spike),
        ...buildTagRows('campaign', summary, spike),
        ...buildProviderRows(summary, spike, new Map()),
      ],
      configurationRows: story.identities === undefined ? [] : buildLaneConfigurationRows({ summary, identities: story.identities, txtAnswers }),
      closeability: checkCloseability(lane.configurationSet, { laneMap, observed, ses }),
      coverage: coverageVerdict({ coverage: summary.coverage, orderBroken: summary.orderBroken }),
      bound: null,
    };
  });
  return { analyses, records: folded.flatMap(({ records }) => records) };
}

export const CYCLE_EXPIRES_AT = Math.floor(CYCLE_NOW_MS / 1000) + RETENTION_SECONDS;

/** The evidence record detection would assemble for one lane of the cycle, the incident opening now. */
export function recordFor(laneMap: LaneMap, story: CycleStory, configurationSet: string): EvidenceRecord {
  const { analyses } = cycleOf(laneMap, story);
  const decision = decideCycle(analyses, laneMap).get(configurationSet);
  const analysis = analyses.find((candidate) => candidate.lane.configurationSet === configurationSet);
  if (decision === undefined || analysis === undefined) throw new Error(`the cycle decided nothing for ${configurationSet}`);
  return assembleEvidenceRecord({
    incidentId: incidentIdFor(configurationSet, bucketStartMs(CYCLE_NOW_MS)),
    analysis,
    decision,
    analyses,
    expiresAt: CYCLE_EXPIRES_AT,
  });
}

/**
 * A real evidence record, built by the core path detection runs: one bad import batch on
 * fothering-bulk with one approved option. The agent's local runtime test sends it as the request
 * body, and packages/agent/fixtures/trial-record.json is this record as text (D-119).
 */
export function fixtureEvidenceRecord(): EvidenceRecord {
  const lanes = parseLaneMap(lanesJson);
  const bulk = 'fothering-bulk';
  const nowMs = Date.UTC(2026, 9, 11, 12, 2, 0);
  const records = scenarioRecords(
    {
      configurationSet: bulk,
      streamTag: 'newsletter',
      callerIdentity: 'bulk-sender',
      fromDomain: 'news.example.com',
      groups: [
        { bucketOffset: 0, count: 40, batch: 'import-0915', permanentBounces: 15 },
        { bucketOffset: 1, count: 160, batch: 'import-0901' },
      ],
    },
    nowMs,
    lanes,
    TEST_KEY_SET,
  );
  const window = spikeWindowFor(nowMs);
  const fold = createWindowFold({ lane: bulk, window, nowMs });
  const summary = summarizeWindow(fold.step(fold.initial, records));
  const spike = laneSpikeVerdict(summary.totals);
  const rows = buildTagRows('batch', summary, spike);
  const ses = {
    configurationSets: new Set(lanes.lanes.map((lane) => lane.configurationSet)),
    defaultConfigurationSets: new Set<string>(),
    eventDestinations: new Map([[bulk, [{ enabled: true, eventBridge: true, matchingEventTypes: [...REQUIRED_EVENT_TYPES] }]]]),
  };
  const closeability = checkCloseability(bulk, { laneMap: lanes, observed: new Map([[bulk, summary.observed]]), ses });
  const decision = decideLane({ spike, rows, configurationRows: [], closeability, coverageNoData: false, bound: null, otherSpikingLanes: [] });
  const countable = records.filter(isCountedRecord).length;
  return buildEvidenceRecord({
    incidentId: incidentIdFor(bulk, bucketStartMs(nowMs)),
    lane: { configurationSet: bulk, lane: bulk },
    window,
    laneTotals: laneTotalsOf(summary, spike),
    share: { laneCountableEvents: countable, storedCountableEvents: countable, percent: renderPercent(countable, countable), label: LANE_SHARE_LABEL },
    rows,
    configurationRows: [],
    isolation: 'confined',
    decision: { ...decision, noData: false, bound: null, otherSpikingLanes: [], sharedCause: null },
    question: null,
    fix: null,
    expiresAt: Math.floor(nowMs / 1000) + RETENTION_SECONDS,
  });
}
