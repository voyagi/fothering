import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.fault.test.ts'],
    setupFiles: ['packages/providers/src/test/guards.setup.ts'],
    globalSetup: ['packages/providers/src/test/global-setup.ts'],
    // Vitest's 5 s default fails a test that spawns git, node or a linter while the rest of the
    // suite runs beside it: the env-gate test takes about 2.5 s alone and 5.1 s in the full suite
    // on Windows (measured 2026-09-28). A test that needs longer still sets its own timeout.
    testTimeout: 30_000,
  },
});
