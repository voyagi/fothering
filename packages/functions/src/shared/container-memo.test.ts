import { describe, expect, it } from 'vitest';
import { memoPerContainer } from './container-memo.js';

// Every handler builds its composition root through this memo, so a memo that rebuilt on each call
// would build a fresh root, and its clients, on every invocation.
describe('memoPerContainer', () => {
  it('builds nothing until the first call, then hands every call the root that call built', () => {
    let builds = 0;
    const root = memoPerContainer(() => {
      builds += 1;
      return { build: builds };
    });
    expect(builds).toBe(0);

    const first = root();
    expect(root()).toBe(first);
    expect(root()).toBe(first);
    expect(builds).toBe(1);
  });

  // A root whose build throws (a bad live switch value) keeps nothing, so every later invocation
  // builds again and fails with the same error rather than reading a half-built root.
  it('keeps nothing from a build that throws, and builds again on the next call', () => {
    let builds = 0;
    const root = memoPerContainer(() => {
      builds += 1;
      if (builds === 1) throw new Error('first build failed');
      return { build: builds };
    });

    expect(() => root()).toThrow('first build failed');
    const second = root();
    expect(second).toEqual({ build: 2 });
    expect(root()).toBe(second);
    expect(builds).toBe(2);
  });
});
