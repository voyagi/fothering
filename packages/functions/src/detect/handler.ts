import { readLiveSwitch } from '@fothering/providers/live-switch';
import { runDetectionCycle, type DetectionCycleSummary } from './detect.js';
import { buildDetectRoot, readDetectLiveConfig } from './root.js';

export const handler = async (): Promise<DetectionCycleSummary> =>
  runDetectionCycle(buildDetectRoot({ runtimeContext: 'deployed', switchValue: readLiveSwitch(), liveConfig: readDetectLiveConfig() }));
