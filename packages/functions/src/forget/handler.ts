import { readLiveSwitch } from '@fothering/providers/live-switch';
import { sleep } from '@fothering/providers/ses-facts';
import { forgetPayloadSchema, forgetRecipient, ForgetUsageError, type ForgetReport } from '@fothering/core/forget';
import { memoPerContainer } from '../shared/container-memo.js';
import { errorName } from '../shared/error-name.js';
import { buildForgetRoot, readForgetLiveConfig, type ForgetDeps } from './root.js';

// The report and the one log line it writes carry counts only (T-01-32): never the address, and
// never one of its hashes. A caller who wants to know if the deletion reached a given address
// re-derives the hash themselves and re-invokes the function; this function never echoes it back.
// A run that fails partway (the key set unreadable, a query or delete refused) writes one line
// naming the error by its name only, as ingest does, so the log shows a deletion request that
// did not finish; what it already removed stays removed, and a second run removes the rest.
export async function forgetFromPayload(payload: unknown, deps: ForgetDeps): Promise<ForgetReport> {
  const parsed = forgetPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ForgetUsageError();
  }

  let report: ForgetReport;
  try {
    const keySet = await deps.ports.addressKey.getKeySet();
    report = await forgetRecipient({
      address: parsed.data.address,
      keySet,
      store: deps.ports.eventStore,
      sleep,
    });
  } catch (error) {
    deps.log.error({ event: 'forget-failed', errorName: errorName(error) });
    throw error;
  }

  deps.log.info({ event: 'forget-completed', count: report.deleted });
  return report;
}

const forgetDeps = memoPerContainer(() =>
  buildForgetRoot({
    runtimeContext: 'deployed',
    switchValue: readLiveSwitch(),
    liveConfig: readForgetLiveConfig(),
  }),
);

export const handler = async (event: unknown): Promise<ForgetReport> => forgetFromPayload(event, forgetDeps());
