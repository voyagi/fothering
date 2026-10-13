import { readLiveSwitch } from '@fothering/providers/live-switch';
import { memoPerContainer } from '../shared/container-memo.js';
import { runDetectionCycle, type DetectionCycleSummary } from './detect.js';
import { buildDetectRoot, readDetectLiveConfig } from './root.js';

const detectDeps = memoPerContainer(() =>
  buildDetectRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveConfig: readDetectLiveConfig(),
  }),
);

// The scheduled rule passes an event, but nothing in it is read: every input comes from the table,
// SES and the composition root.
export const handler = async (): Promise<DetectionCycleSummary> => runDetectionCycle(detectDeps());
