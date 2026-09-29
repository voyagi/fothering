import type { SesConfigurationFacts } from '@fothering/core/closeability';
import type { LaneMap } from '@fothering/core/lanes';
import type { EventDestinationFact, SesReadPort } from './port-types.js';

// SES throttles every API action except sending at one request per second per account
// (https://docs.aws.amazon.com/ses/latest/dg/quotas.html), and these facts take one read per
// identity plus one per lane-map set, so the reads are spaced instead of fired together. The
// identity list itself is one request per 1,000 identities, its pages back to back inside the
// adapter, so only an account past 1,000 identities sends two requests inside one second.
export const SES_READ_SPACING_MS = 1_000;

export interface ReadSesFactsOptions {
  wait?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Typed over the read half of the SES port so this code can never reach a pause, a reopen or a
// send. Reads run one at a time: two in flight would break the one-per-second spacing.
export async function readSesFacts(
  ses: SesReadPort,
  laneMap: LaneMap,
  options: ReadSesFactsOptions = {},
): Promise<SesConfigurationFacts> {
  const wait = options.wait ?? sleep;
  let readsStarted = 0;
  async function spaced<T>(read: () => Promise<T>): Promise<T> {
    if (readsStarted > 0) await wait(SES_READ_SPACING_MS);
    readsStarted += 1;
    return read();
  }

  const identities = new Set(await spaced(() => ses.listEmailIdentities()));

  const defaultConfigurationSets = new Set<string>();
  for (const identity of identities) {
    const defaultSet = await spaced(() => ses.getEmailIdentity(identity));
    if (defaultSet !== undefined && defaultSet !== '') defaultConfigurationSets.add(defaultSet);
  }

  const eventDestinations = new Map<string, EventDestinationFact[]>();
  for (const lane of laneMap.lanes) {
    eventDestinations.set(
      lane.configurationSet,
      await spaced(() => ses.getConfigurationSetEventDestinations(lane.configurationSet)),
    );
  }

  return { defaultConfigurationSets, eventDestinations };
}
