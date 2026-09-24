import { LIVE_SWITCH, resolveProviderMode } from '@fothering/core/mode';

// Runs once, before any worker starts and before setupFiles run in them, so a live switch never
// reaches a single test module's own code (D-27). Vitest reports this failure after its own file
// summary line, which is misleading read alone (Pitfall 7) - the abort itself is what matters.
export default function setup(): void {
  if (resolveProviderMode(process.env) !== 'live') return;
  throw new Error(`refusing to start: ${LIVE_SWITCH} is set to live. This test suite runs on fixtures only.`);
}
