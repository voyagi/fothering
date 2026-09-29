import type { SesConfigurationFacts } from '@fothering/core/closeability';
import type { LaneMap } from '@fothering/core/lanes';
import type { SesReadPort } from './port-types.js';

export const SES_READ_SPACING_MS = 1_000;

export interface ReadSesFactsOptions {
  wait?: (ms: number) => Promise<void>;
}

export async function readSesFacts(
  _ses: SesReadPort,
  _laneMap: LaneMap,
  _options: ReadSesFactsOptions = {},
): Promise<SesConfigurationFacts> {
  return { defaultConfigurationSets: new Set(), eventDestinations: new Map() };
}
