import { describe, expect, it } from 'vitest';
import * as net from 'node:net';

// AC-E7: the companion of guard-parallel-a.test.ts, run from a different documentation address so
// neither file can pass by coincidence sharing state with the other's worker.
describe('the network guard in this parallel worker (file b)', () => {
  it('refuses a connection to a documentation address', () => {
    let caught: unknown;
    try {
      const socket = net.connect({ host: '198.51.100.1', port: 9 });
      socket.on('error', () => {});
      socket.destroy();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('NetworkGuardError');
  });
});
