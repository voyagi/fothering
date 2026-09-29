import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as CreateApp from '../create-app.js';
import type * as StubAssets from '../stub-assets.js';
import { INGEST_STACK_ID } from '../create-app.js';
import { synthStacks } from './synth.js';

// A stack failure the test can plant, and every stub folder a synth makes, so a failed synth can be
// shown to remove the folder it made. With nothing planted the real builders run.
const plant = vi.hoisted(() => ({ failStacks: false, stubRoots: [] as string[] }));

vi.mock('../create-app.js', async (importOriginal) => {
  const real = await importOriginal<typeof CreateApp>();
  return {
    ...real,
    addFotheringStacks: (...args: Parameters<typeof real.addFotheringStacks>) => {
      if (plant.failStacks) throw new Error('planted stack failure');
      return real.addFotheringStacks(...args);
    },
  };
});

vi.mock('../stub-assets.js', async (importOriginal) => {
  const real = await importOriginal<typeof StubAssets>();
  return {
    ...real,
    createStubAssets: () => {
      const assets = real.createStubAssets();
      plant.stubRoots.push(dirname(assets.outdir));
      return assets;
    },
  };
});

// Every synth test calls this helper, and the full suite runs it several times, so an assembly
// written outside what dispose removes piles up in the temp folder run after run.
describe('synthStacks', () => {
  it('writes its assembly where dispose removes it, and leaves nothing behind', { timeout: 60_000 }, () => {
    const stacks = synthStacks();
    expect(existsSync(join(stacks.outdir, `${INGEST_STACK_ID}.template.json`))).toBe(true);
    stacks.dispose();
    expect(existsSync(stacks.outdir)).toBe(false);
  });

  // A synth that throws hands no dispose back to its caller, so the helper removes the folder itself.
  it('removes its stub folder when the stacks fail to build, and passes the failure on', () => {
    const before = plant.stubRoots.length;
    plant.failStacks = true;
    try {
      expect(() => synthStacks()).toThrow('planted stack failure');
    } finally {
      plant.failStacks = false;
    }
    expect(plant.stubRoots).toHaveLength(before + 1);
    expect(existsSync(plant.stubRoots[before] ?? '')).toBe(false);
  });
});
