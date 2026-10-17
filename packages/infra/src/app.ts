import { App } from 'aws-cdk-lib';
import { parseLaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { addFotheringStacks } from './create-app.js';

addFotheringStacks(new App(), {
  laneMap: parseLaneMap(lanesJson),
  ingestAssetDir: 'dist/ingest',
  forgetAssetDir: 'dist/forget',
  agentAssetDir: 'dist/agent',
  detectAssetDir: 'dist/detect',
});
