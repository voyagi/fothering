// eslint.complexity.config.mjs - complexity is checked apart from lint (D-30), so gate:complexity
// stops being eslint . a second time under a different name: raising or lowering this budget never
// touches the correctness rules lint owns.
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/*.config.{ts,js,mjs,cjs}', '**/{dist,build,coverage,cdk.out,.astro,.wrangler}/**'] },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    // A test enumerates cases, which is what makes it long, not tangled; the check scripts under
    // scripts/** are proven by their own --selftest controls, not by a complexity budget.
    ignores: ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}', 'scripts/**'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { sonarjs },
    rules: { complexity: ['error', 25], 'sonarjs/cognitive-complexity': ['error', 25] },
  },
];
