import { readLiveSwitch } from '@fothering/providers/live-switch';
import { reopenPayloadSchema, ReopenUsageError } from '@fothering/core/reopen';
import { memoPerContainer } from '../shared/container-memo.js';
import { reopenLane, type ReopenReport } from './reopen.js';
import { buildReopenRoot, readReopenLiveConfig, type ReopenDeps } from './root.js';

// A refusal never echoes the payload (T-03-17): the usage message is fixed and the log line names the
// reason only.
export async function reopenFromPayload(payload: unknown, deps: ReopenDeps): Promise<ReopenReport> {
  const parsed = reopenPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    deps.log.info({ event: 'reopen-refused', reason: 'payload-invalid' });
    throw new ReopenUsageError();
  }
  return reopenLane(deps, parsed.data.configurationSet);
}

const reopenDeps = memoPerContainer(() =>
  buildReopenRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveConfig: readReopenLiveConfig(),
  }),
);

export const handler = async (event: unknown): Promise<ReopenReport> => reopenFromPayload(event, reopenDeps());
