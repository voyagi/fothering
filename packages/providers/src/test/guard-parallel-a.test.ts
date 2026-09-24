import { describe, expect, it } from 'vitest';
import * as net from 'node:net';

// AC-E7: this file and guard-parallel-b.test.ts each attempt a connection from their own vitest
// worker. Vitest runs test files in parallel workers by default, so both files passing proves the
// guard is present in every worker, not only the one that happened to run first.
describe('the network guard in this parallel worker (file a)', () => {
  it('refuses a connection to a documentation address', () => {
    let caught: unknown;
    try {
      const socket = net.connect({ host: '192.0.2.1', port: 9 });
      socket.on('error', () => {});
      socket.destroy();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('NetworkGuardError');
  });
});
