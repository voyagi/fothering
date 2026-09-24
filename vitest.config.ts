import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.fault.test.ts'],
    setupFiles: ['packages/providers/src/test/guards.setup.ts'],
  },
});
