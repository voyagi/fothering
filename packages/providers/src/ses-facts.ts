import type { SesConfigurationFacts } from '@fothering/core/closeability';
import type { IdentityAuthFacts } from '@fothering/core/evidence-rows';
import type { LaneMap } from '@fothering/core/lanes';
import type { EventDestinationFact, SesReadPort } from './port-types.js';

// SES throttles every API action except sending at one request per second per account
// (https://docs.aws.amazon.com/ses/latest/dg/quotas.html), and these facts take two list reads,
// one read per identity and one per lane-map set, so the reads are spaced instead of fired
// together. The identity list is one request per 1,000 identities, and the live adapter spaces the
// pages of both lists by the same second, so no two requests ever fall inside one second.
export const SES_READ_SPACING_MS = 1_000;
export const MAX_IDENTITY_READS = 50;

export interface ReadSesFactsOptions {
  wait?: (ms: number) => Promise<void>;
  maxIdentityReads?: number;
}

export type SesFactsResult =
  | { ok: true; facts: SesConfigurationFacts; identities: IdentityAuthFacts[] }
  | { ok: false; reason: 'ses-facts-bound'; identityCount: number };

/** The real pause behind every SES read spacing and the forget re-query delay; tests pass a recorder in its place. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Typed over the read half of the SES port so this code can never reach a pause, a reopen or a
// send. Reads run one at a time: two in flight would break the one-per-second spacing.
// One identity read a second means N identities take about N seconds, so a deployed caller must
// bound N to fit its own time limit.
export async function readSesFacts(
  ses: SesReadPort,
  laneMap: LaneMap,
  options: ReadSesFactsOptions = {},
): Promise<SesFactsResult> {
  const wait = options.wait ?? sleep;
  let readsStarted = 0;
  async function spaced<T>(read: () => Promise<T>): Promise<T> {
    if (readsStarted > 0) await wait(SES_READ_SPACING_MS);
    readsStarted += 1;
    return read();
  }

  const identities = new Set(await spaced(() => ses.listEmailIdentities()));
  const configurationSets = new Set(await spaced(() => ses.listConfigurationSets()));

  const defaultConfigurationSets = new Set<string>();
  for (const identity of identities) {
    const facts = await spaced(() => ses.getEmailIdentity(identity));
    const defaultSet = facts?.defaultConfigurationSet;
    if (defaultSet !== undefined && defaultSet !== '') defaultConfigurationSets.add(defaultSet);
  }

  const eventDestinations = new Map<string, EventDestinationFact[]>();
  for (const lane of laneMap.lanes) {
    eventDestinations.set(
      lane.configurationSet,
      await spaced(() => ses.getConfigurationSetEventDestinations(lane.configurationSet)),
    );
  }

  return { ok: true, facts: { configurationSets, defaultConfigurationSets, eventDestinations }, identities: [] };
}
