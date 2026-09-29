import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INGEST_STACK_ID } from '../create-app.js';
import { synthStacks } from './synth.js';

// Every synth test calls this helper, and the full suite runs it several times, so an assembly
// written outside what dispose removes piles up in the temp folder run after run.
describe('synthStacks', () => {
  it('writes its assembly where dispose removes it, and leaves nothing behind', { timeout: 60_000 }, () => {
    const stacks = synthStacks();
    expect(existsSync(join(stacks.outdir, `${INGEST_STACK_ID}.template.json`))).toBe(true);
    stacks.dispose();
    expect(existsSync(stacks.outdir)).toBe(false);
  });
});
