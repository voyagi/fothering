import { readLiveSwitch } from '@fothering/providers/live-switch';
import { forgetPayloadSchema, forgetRecipient, ForgetUsageError, type ForgetReport } from '@fothering/core/forget';
import { memoPerContainer } from '../shared/container-memo.js';
import { buildForgetRoot, readForgetLiveConfig, type ForgetDeps } from './root.js';

const requeryDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The report and the one log line it writes carry counts only (T-01-32): never the address, and
// never one of its hashes. A caller who wants to know if the deletion reached a given address
// re-derives the hash themselves and re-invokes the function; this function never echoes it back.
export async function forgetFromPayload(payload: unknown, deps: ForgetDeps): Promise<ForgetReport> {
  const parsed = forgetPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ForgetUsageError();
  }

  const keySet = await deps.ports.addressKey.getKeySet();
  const report = await forgetRecipient({
    address: parsed.data.address,
    keySet,
    store: deps.ports.eventStore,
    sleep: requeryDelay,
  });

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
