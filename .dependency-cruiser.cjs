const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'aws-clients-only-in-providers',
      severity: 'error',
      // The exemption is path-exact (packages/providers/src/, not a prefix match), so a sibling
      // folder that merely starts with the same name, or a package added after this rule was
      // written, stays outside it with no edit here.
      comment:
        'Only provider adapters may import an AWS client package. Everything else goes through a port, which is what keeps the fixture default and the account-level guard enforceable.',
      from: { path: '^packages/[^/]+/src/', pathNot: '^packages/providers/src/' },
      to: { path: '(^|/)@aws-sdk/|(^|/)@smithy/|(^|/)@aws-crypto/|(^|/)bedrock-agentcore($|/)|(^|/)aws4fetch($|/)' },
    },
    {
      name: 'site-is-a-leaf',
      severity: 'error',
      comment: 'Nothing imports the site: it is built and served on its own, so a backend import of it would ship page code into a Lambda or the agent.',
      from: { path: '^packages/', pathNot: '^packages/web/' },
      to: { path: '^packages/web/' },
    },
    {
      name: 'site-imports-core-only',
      severity: 'error',
      // .astro files are invisible here (no .astro in enhancedResolveOptions.extensions), which is
      // why every page import goes through a .ts module this rule can see.
      comment:
        'The site reads only the pure core and the committed infra snapshots, never providers, functions, agent or infra source, so a page build cannot pull in an AWS client or a handler.',
      from: { path: '^packages/web/src/' },
      to: { path: '^packages/', pathNot: ['^packages/(web|core)/', '^packages/infra/[^/]+\\.json$'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Modules imported by nothing are usually dead code.',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)(index|main|entry)\\.[jt]sx?$', '\\.config\\.[jt]s$', '\\.test\\.[jt]s$', '(^|/)src/mode\\.ts$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    ...(fs.existsSync(path.join(__dirname, 'tsconfig.json'))
      ? { tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') } }
      : {}),
    enhancedResolveOptions: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] },
  },
};
