export type ProviderMode = 'fixture' | 'live';

export const LIVE_SWITCH = 'FOTHERING_LIVE';

// Only the exact word "live" turns live mode on. "1", "true" or a stray space stay on fixtures,
// because a loose match is how a copied shell profile or CI variable ends up spending money.
export function resolveProviderMode(env: Readonly<Record<string, string | undefined>>): ProviderMode {
  return env[LIVE_SWITCH] === 'live' ? 'live' : 'fixture';
}
