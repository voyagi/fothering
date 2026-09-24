import { readFileSync } from 'node:fs';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';

export const SES_EVENT_FIXTURE_NAMES = ['bounce'] as const;
export type SesEventFixtureName = (typeof SES_EVENT_FIXTURE_NAMES)[number];

export interface SesEventFixture {
  provenance: string;
  source: string;
  envelopeSource: string;
  event: unknown;
}

// D-25: one JSON file per SES event example, loaded beside this module so a new fixture name
// needs no per-file import here. Plan 01-04 extends SesEventFixtureName as it adds fixtures.
export function loadSesEventFixture(name: SesEventFixtureName): SesEventFixture {
  const url = new URL(`./${name}.json`, import.meta.url);
  const raw = readFileSync(url, 'utf8');
  return JSON.parse(raw) as SesEventFixture;
}

// The lane the doc-derived fixtures share: the AWS examples' "ConfigSet" configuration set,
// declared bulk so the tracer test can exercise findLane against a real lane entry.
export const DOC_EXAMPLE_LANE_MAP: LaneMap = parseLaneMap({
  runIdTagKey: 'fotheringRunId',
  lanes: [
    {
      configurationSet: 'ConfigSet',
      lane: 'doc-examples',
      criticality: 'bulk',
      declaredStreams: ['myCustomTagValue1'],
      streamTagKey: 'myCustomTag1',
      batchTagKey: 'myCustomBatchTag1',
      templateTagKey: 'myCustomTemplateTag1',
      campaignTagKey: 'myCustomCampaignTag1',
      operatorAlert: false,
    },
  ],
});
