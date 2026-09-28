// Complexity budgets are set at 25, about twice the common default, so they only fire on genuinely
// tangled functions. A hit means refactor, or raise the budget for that one file with a written reason.
// The budget and the ignored folders live in eslint.complexity.config.mjs alone and are spread in
// first here, so lint and gate:complexity can never disagree about either.
import compat from 'eslint-plugin-compat';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';
import complexityConfig from './eslint.complexity.config.mjs';

const tsParser = { parser: tseslint.parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } };

const TEST_FILES = ['**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'];

// An agent built with no model would fall back to whatever the SDK defaults to, which is exactly
// the kind of implicit choice the live providers wrapper exists to make explicit. So the rule
// reports `new Agent()` and an options literal that names no model of its own (`new Agent({})`,
// `new Agent({ tools })`, a model only nested deeper or spread in), by name and by namespace
// access (`new sdk.Agent(...)`). Not caught: options passed in a variable, and a renamed default
// import, since matching either would need type information this rule does not have.
const AGENT_WITHOUT_MODEL = [
  "NewExpression[callee.name='Agent'][arguments.length=0]",
  "NewExpression[callee.property.name='Agent'][arguments.length=0]",
  "NewExpression[callee.name='Agent'] > ObjectExpression:not(:has(> Property[key.name='model']))",
  "NewExpression[callee.property.name='Agent'] > ObjectExpression:not(:has(> Property[key.name='model']))",
].map((selector) => ({ selector, message: 'Build an Agent with an explicit model from the live providers.' }));

export default [
  ...complexityConfig,
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
  // The depcruise boundary bans these imports at the module level; this rule bans the same
  // families at review time, so a violation shows up as a lint error before a commit lands, not
  // only when gate:deps runs. BedrockModel is banned everywhere outside the live adapters, since
  // the wrapper (not the model class) is what stays swappable.
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/providers/src/**'],
    languageOptions: { ...tsParser },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@aws-sdk/*'], message: 'AWS clients build only inside packages/providers/src.' },
          { group: ['@smithy/*'], message: 'AWS clients build only inside packages/providers/src.' },
          { group: ['@aws-crypto/*'], message: 'AWS clients build only inside packages/providers/src.' },
          { group: ['bedrock-agentcore', 'bedrock-agentcore/*'], message: 'AWS clients build only inside packages/providers/src.' },
          { group: ['aws4fetch'], message: 'AWS clients build only inside packages/providers/src.' },
          {
            group: ['@strands-agents/sdk', '@strands-agents/sdk/*'],
            importNames: ['BedrockModel'],
            message: 'BedrockModel is wired only inside packages/providers/src/live.',
          },
        ],
      }],
    },
  },
  // Inside providers, the AWS clients are exactly what this workspace exists to hold; only the
  // model class stays confined to the live adapters that actually call Bedrock.
  {
    files: ['packages/providers/src/**/*.ts'],
    ignores: ['packages/providers/src/live/**'],
    languageOptions: { ...tsParser },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@strands-agents/sdk', '@strands-agents/sdk/*'],
            importNames: ['BedrockModel'],
            message: 'BedrockModel is wired only inside packages/providers/src/live.',
          },
        ],
      }],
    },
  },
  // The live selectors report any environment access, and any readLiveSwitch() call, found
  // anywhere inside a comparison to 'live': a plain or computed member of process.env or of an
  // `env` binding, behind optional chaining or a type cast, or under a call such as trim() or
  // toLowerCase(), the loose matches mode.ts refuses on purpose. Not caught: 'live' written as a
  // template literal, a switch case, or a call such as includes() or Object.is(); the switch-name
  // gate and mode.ts's exact-match tests guard the switch itself. mode.ts is the one place allowed
  // to decide what "live" means, so it carries only the agent selectors, in its own object below.
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/core/src/mode.ts'],
    languageOptions: { ...tsParser },
    rules: {
      'no-restricted-syntax': ['error',
        ...AGENT_WITHOUT_MODEL,
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][right.value='live'] MemberExpression[property.name='env']",
          message: 'Only mode.ts decides live mode.',
        },
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][left.value='live'] MemberExpression[property.name='env']",
          message: 'Only mode.ts decides live mode.',
        },
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][right.value='live'] MemberExpression[object.name='env']",
          message: 'Only mode.ts decides live mode.',
        },
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][left.value='live'] MemberExpression[object.name='env']",
          message: 'Only mode.ts decides live mode.',
        },
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][right.value='live'] CallExpression[callee.name='readLiveSwitch']",
          message: 'Only mode.ts decides live mode.',
        },
        {
          selector: "BinaryExpression[operator=/^(==|===|!=|!==)$/][left.value='live'] CallExpression[callee.name='readLiveSwitch']",
          message: 'Only mode.ts decides live mode.',
        },
      ],
    },
  },
  {
    files: ['packages/core/src/mode.ts'],
    languageOptions: { ...tsParser },
    rules: {
      'no-restricted-syntax': ['error', ...AGENT_WITHOUT_MODEL],
    },
  },
];
