// Complexity budgets are set at 25, about twice the common default, so they only fire on genuinely
// tangled functions. A hit means refactor, or raise the budget for that one file with a written reason.
import sonarjs from 'eslint-plugin-sonarjs';
import compat from 'eslint-plugin-compat';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';

const tsParser = { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } };

const TEST_FILES = ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'];

export default [
  { ignores: ['**/*.config.{ts,js,mjs,cjs}', '**/{dist,build,coverage,cdk.out,.astro,.wrangler}/**'] },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: [...TEST_FILES, 'scripts/**'],
    languageOptions: { ...tsParser },
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 25],
      'sonarjs/cognitive-complexity': ['error', 25],
    },
  },
  // The check scripts are copied gate tools whose behaviour is pinned by their --selftest controls, so
  // they get correctness rules without the complexity budget: splitting them to fit it would change
  // proven code for no user-facing gain.
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-self-compare': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
  // A test with no assertion passes forever, and two tests with one title hide each other in reports.
  {
    files: TEST_FILES,
    languageOptions: { ...tsParser },
    plugins: { vitest },
    rules: {
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'fc.assert'] }],
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
