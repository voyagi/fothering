import type { App } from 'aws-cdk-lib';
import type { LaneMap } from '@fothering/core/lanes';
import { IngestStack } from './ingest-stack.js';
import { RuntimeStack } from './runtime-stack.js';

export const INGEST_STACK_ID = 'FotheringIngest';
export const RUNTIME_STACK_ID = 'FotheringRuntime';

// Only the region is pinned: an account or a context lookup would make synth reach for AWS
// credentials, and a build must never do that.
const ENV = { region: 'eu-central-1' };

export interface FotheringStackOptions {
  readonly laneMap: LaneMap;
  readonly ingestAssetDir: string;
  readonly forgetAssetDir: string;
  readonly agentAssetDir: string;
}

// One place builds the stacks, so the deployed app, the synth tests and the permissions snapshot
// cannot describe three different sets of resources.
export function addFotheringStacks(app: App, options: FotheringStackOptions): { ingest: IngestStack; runtime: RuntimeStack } {
  return {
    ingest: new IngestStack(app, INGEST_STACK_ID, {
      env: ENV,
      laneMap: options.laneMap,
      ingestAssetDir: options.ingestAssetDir,
      forgetAssetDir: options.forgetAssetDir,
    }),
    runtime: new RuntimeStack(app, RUNTIME_STACK_ID, { env: ENV, agentAssetDir: options.agentAssetDir }),
  };
}
