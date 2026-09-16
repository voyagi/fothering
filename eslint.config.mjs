// Complexity budgets are set at 25, about twice the common default, so they only fire on genuinely
// tangled functions. A hit means refactor, or raise the budget for that one file with a written reason.
import sonarjs from 'eslint-plugin-sonarjs';
import compat from 'eslint-plugin-compat';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';

const tsParser = { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } };

const TEST_FILES = ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'];

export default [
  { ignores: ['**/*.config.{ts,js,mjs,cjs}', '**/{dist,build,coverage,cdk.out,.astro,.wrangler}/**', 'scripts/**'] },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: TEST_FILES,
    languageOptions: { ...tsParser },
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 25],
      'sonarjs/cognitive-complexity': ['error', 25],
    },
  },
  // A test with no assertion passes forever, and two tests with one title hide each other in reports.
  {
    files: TEST_FILES,
    languageOptions: { ...tsParser },
    plugins: { vitest },
    rules: {
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'test.prop', 'it.prop'] }],
      'vitest/no-identical-title': 'error',
    },
  },
  // Browser API support is checked on site code only: on Node code the plugin flags valid syntax.
  {
    files: ['apps/web/src/**/*.{ts,tsx,js,jsx,mjs}', '**/*.{jsx,tsx}'],
    ignores: TEST_FILES,
    languageOptions: { ...tsParser },
    plugins: { compat },
    rules: { 'compat/compat': 'error' },
  },
];
