// eslint.complexity.config.mjs - the complexity budget and the ignored folders, written once.
// gate:complexity runs this file alone, so it is a distinct check from lint rather than eslint . a
// second time under a different name (D-30). eslint.config.mjs spreads this same array ahead of its
// own rules, so lint (and with it the pre-commit gate) enforces the identical budget: a budget or an
// ignored folder changed here changes both runs, and there is no second copy to forget.
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/*.config.{ts,js,mjs,cjs}', '**/{dist,build,coverage,cdk.out,.astro,.wrangler,.stryker-tmp}/**'] },
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
