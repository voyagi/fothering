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
    // Read only by `npm run test:coverage` (vitest run --coverage); a plain `npm test` collects
    // nothing. Product source only: the tests and the test-only helpers under src/test/ would
    // count their own lines as covered.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/*/src/test/**', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Floors about two points under the 2026-10-10 measurement at ac13b87 (1.91 to 2.71 points:
      // statements 96.91, branches 93.71, functions 95.68, lines 97.05; Windows, Node 24), so a real
      // drop fails the gate. CI runs Node 22, measured the same day at 19ffc0b on Windows: 96.79,
      // 93.69, 95.70, 96.90. The suite's one platform skip runs a test only on Linux, and that test
      // exercises scripts/, which coverage does not count.
      thresholds: {
        statements: 95,
        branches: 91,
        functions: 93,
        lines: 95,
      },
    },
  },
});
