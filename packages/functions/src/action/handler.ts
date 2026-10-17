import { readLiveSwitch } from '@fothering/providers/live-switch';
import { memoPerContainer } from '../shared/container-memo.js';
import { runActionCycle, type ActionRunSummary } from './action.js';
import { buildActionRoot, readActionLiveConfig } from './root.js';

const actionDeps = memoPerContainer(() =>
  buildActionRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveConfig: readActionLiveConfig(),
  }),
);

// The scheduled rule's event carries nothing the run reads: every input comes from the table, SES and
// the composition root.
export const handler = async (): Promise<ActionRunSummary> => runActionCycle(actionDeps());
