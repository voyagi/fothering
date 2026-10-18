import type { App } from 'aws-cdk-lib';
import type { LaneMap } from '@fothering/core/lanes';
import { applyAccountSendingDeny } from './account-deny.js';
import { ActionStack } from './action-stack.js';
import { DetectionStack } from './detection-stack.js';
import { IngestStack } from './ingest-stack.js';
import { RuntimeStack } from './runtime-stack.js';

export const INGEST_STACK_ID = 'FotheringIngest';
export const RUNTIME_STACK_ID = 'FotheringRuntime';
export const DETECTION_STACK_ID = 'FotheringDetection';
export const ACTION_STACK_ID = 'FotheringAction';

// Only the region is pinned: an account or a context lookup would make synth reach for AWS
// credentials, and a build must never do that.
const ENV = { region: 'eu-central-1' };

export interface FotheringStackOptions {
  readonly laneMap: LaneMap;
  readonly ingestAssetDir: string;
  readonly forgetAssetDir: string;
  readonly agentAssetDir: string;
  readonly detectAssetDir: string;
  readonly actionAssetDir: string;
  readonly reopenAssetDir: string;
}

interface FotheringStacks {
  readonly ingest: IngestStack;
  readonly runtime: RuntimeStack;
  readonly detection: DetectionStack;
  readonly action: ActionStack;
}

// One place builds the stacks, so the deployed app, the synth tests and the permissions snapshot
// cannot describe different sets of resources. The account-level Deny is applied to the app here for
// the same reason, and so reaches every role any stack adds later.
export function addFotheringStacks(app: App, options: FotheringStackOptions): FotheringStacks {
  applyAccountSendingDeny(app);
  const ingest = new IngestStack(app, INGEST_STACK_ID, {
    env: ENV,
    laneMap: options.laneMap,
    ingestAssetDir: options.ingestAssetDir,
    forgetAssetDir: options.forgetAssetDir,
  });
  const runtime = new RuntimeStack(app, RUNTIME_STACK_ID, { env: ENV, agentAssetDir: options.agentAssetDir });
  const detection = new DetectionStack(app, DETECTION_STACK_ID, {
    env: ENV,
    laneMap: options.laneMap,
    detectAssetDir: options.detectAssetDir,
    table: ingest.table,
    runtime: runtime.runtime,
  });
  const action = new ActionStack(app, ACTION_STACK_ID, {
    env: ENV,
    laneMap: options.laneMap,
    actionAssetDir: options.actionAssetDir,
    reopenAssetDir: options.reopenAssetDir,
    ingest,
  });
  return { ingest, runtime, detection, action };
}
