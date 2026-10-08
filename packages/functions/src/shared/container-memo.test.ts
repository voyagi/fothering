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
});
