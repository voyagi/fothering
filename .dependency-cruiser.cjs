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
      name: 'ses-v1-client-banned',
      severity: 'error',
      // No providers exemption: the adapters use SES API v2 only. The ($|/) keeps
      // @aws-sdk/client-sesv2 out of the match.
      comment: 'The SES v1 client is banned in every package, providers included: Fothering uses SES API v2 only.',
      from: { path: '^packages/' },
      to: { path: '(^|/)@aws-sdk/client-ses($|/)' },
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
