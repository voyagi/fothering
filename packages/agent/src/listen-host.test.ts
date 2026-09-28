import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { propertySeed } from '@fothering/core/test/property-seed';
import { AGENTCORE_RUNTIME, inAgentCoreRuntime } from './listen-host.js';

describe('inAgentCoreRuntime', () => {
  it('is true only for the exact value the deploying stack sets', () => {
    expect(inAgentCoreRuntime(AGENTCORE_RUNTIME)).toBe(true);
    expect(AGENTCORE_RUNTIME).toBe('agentcore');
  });

  it.each([undefined, '', 'AgentCore', 'AGENTCORE', ' agentcore', 'agentcore ', 'agentcore\n', 'true', '1', 'live'])(
    'is false, so the runtime stays on loopback, for %j',
    (value) => {
      expect(inAgentCoreRuntime(value)).toBe(false);
    },
  );

  it('is false for every other string', () =>
    fc.assert(
      fc.property(
        fc.string().filter((value) => value !== AGENTCORE_RUNTIME),
        (value) => {
          expect(inAgentCoreRuntime(value)).toBe(false);
        },
      ),
      { seed: propertySeed() },
    ));
});
