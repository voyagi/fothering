import { describe, expect, it } from 'vitest';

// A normal member of the suite and the target file abort-on-live.test.ts spawns as a child run.
// Its own assertion proves the child's setupFiles stripped credentials too, not just the parent's.
describe('switch probe', () => {
  it('runs with AWS credentials stripped', () => {
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });
});
