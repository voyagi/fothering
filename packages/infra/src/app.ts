import { App } from 'aws-cdk-lib';
import { parseLaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { IngestStack } from './ingest-stack.js';

const laneMap = parseLaneMap(lanesJson);

const app = new App();
new IngestStack(app, 'FotheringIngest', {
  env: { region: 'eu-central-1' },
  laneMap,
  ingestAssetDir: 'dist/ingest',
});
