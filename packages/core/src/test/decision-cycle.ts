import { REQUIRED_EVENT_TYPES, checkCloseability, type SesConfigurationFacts } from '../closeability.js';
import type { LaneAnalysis } from '../decision.js';
import { buildLaneConfigurationRows, buildProviderRows, buildTagRows, type DnsTxtOutcome, type IdentityAuthFacts } from '../evidence-rows.js';
import { findLane, type LaneEntry, type LaneMap } from '../lanes.js';
import type { EventRecord } from '../records.js';
import { coverageVerdict, laneSpikeVerdict } from '../verdicts.js';
import { createWindowFold, spikeWindowFor, summarizeWindow } from '../window-fold.js';
import { TEST_KEY_SET, scenarioRecords, type ScenarioGroup } from './event-arbitraries.js';

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
