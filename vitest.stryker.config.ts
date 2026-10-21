import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

// Stryker runs the FULL suite for every static mutant (one that runs at module load, such as a
// zod schema or a constant) with vitest forced to a single thread
// (https://stryker-mutator.io/docs/stryker-js/configuration,
// https://stryker-mutator.io/docs/stryker-js/vitest-runner). The exclusions below spawn a
// process, synthesize a CDK stack or read the repo through git, none of which any mutated module
// needs: `.stryker-tmp/` is git-ignored, so `git ls-files` there lists nothing and every
// git-based check under packages/infra/src/** fails for a reason that has nothing to do with a
// mutant. The site's tests read built pages and committed files and mutate nothing in the decision
// core, so they only lengthen every static mutant's run. mergeConfig concatenates array fields, so
// this only ADDS to vitest.config.ts's own exclude list, never replaces it.
export default mergeConfig(baseConfig, {
  test: {
    exclude: ['packages/infra/src/**', 'packages/web/src/**', '**/abort-on-live.test.ts', '**/runtime.local.test.ts'],
  },
  resolve: {
    // The npm workspace link node_modules/@fothering/core is a junction to the ORIGINAL
    // checkout's packages/core, so a test in another workspace that imports a @fothering/core
    // module path inside Stryker's sandbox loads the unmutated original, and every such mutant
    // reads "no coverage". Measured 2026-09-25 on phase-1-lanes-ingest at c3b4a2d: without this
    // alias address.ts, buckets.ts, lanes.ts, minimize.ts, records.ts and ses-events.ts scored 0
    // with 145 mutants uncovered (10.37 total); with it the uncovered count fell to 42 and the
    // total rose to 50.98.
    alias: [
      {
        find: /^@fothering\/(core|providers)\/(.+)$/,
        replacement: `${fileURLToPath(new URL('./packages/', import.meta.url))}$1/src/$2.ts`,
      },
    ],
  },
});
