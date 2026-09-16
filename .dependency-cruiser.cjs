const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'aws-sdk-only-in-providers',
      severity: 'error',
      comment:
        'Only provider adapters may import an AWS SDK client. Everything else goes through a port, which is what keeps the fixture default and the account-level guard enforceable.',
      from: { path: '^packages/[^/]+/src/', pathNot: '^packages/[^/]+/src/providers/' },
      to: { path: '(^|/)@aws-sdk/' },
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
