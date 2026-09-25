export type ProviderMode = 'fixture' | 'live';

export const LIVE_SWITCH = 'FOTHERING_LIVE';

// Only the exact word "live" turns live mode on. "1", "true" or a stray space stay on fixtures,
// because a loose match is how a copied shell profile or CI variable ends up spending money.
// The composition roots pass the switch value itself, not the environment record: each deployable
// reads process.env[LIVE_SWITCH] once, in the one providers module the boundary rule allows to
// read it literally, and hands the resulting string (or undefined) down from there.
export function resolveProviderMode(switchValue: string | undefined): ProviderMode {
  return switchValue === 'live' ? 'live' : 'fixture';
}
