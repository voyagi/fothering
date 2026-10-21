// bundle-options.mjs - the esbuild settings every CommonJS bundle shares, and the one plugin the
// agent bundle needs. They live outside build.mjs because importing build.mjs runs a whole
// build, and a test must be able to build a planted input with exactly the settings the real
// build uses.
//
// WHY empty-import-meta IS AN ERROR. Bundled to CommonJS, esbuild rewrites every `import.meta` to
// an empty object and only warns, so `import.meta.url` is undefined at run time while the build
// still succeeds. The plugin below removes the one use on the bedrock-agentcore 0.4.5 path the
// agent bundles, in runtime/app.js. Its other use, in _utils/version.js, is reached only from the
// web-search tool, which the agent never imports. Raising the warning to an error stops a new use,
// from an upgrade or any other dependency, from shipping a bundle that dies on the first code path
// that touches it.
//
// WHY THE createRequire PLUGIN. bedrock-agentcore's runtime/app.js builds a private `require`
// through `createRequire(import.meta.url)` to load two Fastify plugins CommonJS-style. Bundled to
// CommonJS, `import.meta.url` is undefined and the file throws on load before esbuild ever
// follows the require() calls it guards. Deleting that one line lets esbuild see and inline both
// plugins for real. The plugin fails loudly, not silently, when the line it expects is gone, so a
// bedrock-agentcore upgrade cannot reintroduce the crash unnoticed.
//
// WHY A COMMONJS SCOPE MARKER. The repo root's package.json says "type": "module", so Node reads
// every .js file below it as an ES module unless a nearer package.json says otherwise, and a
// CommonJS bundle read that way dies on its first require(). markCommonJsScope writes that nearer
// file into a folder, so every bundle under it loads the same way inside the repo as outside it.
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CJS_BUNDLE_BASE = Object.freeze({
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logOverride: { 'empty-import-meta': 'error' },
});

// The settings for a bundle of the CDK app or of a tool that builds its stacks. aws-cdk-lib and
// constructs stay external so the tool and the deployed app load the same installed copy.
export const CDK_TOOL_BUNDLE_BASE = Object.freeze({
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['aws-cdk-lib', 'aws-cdk-lib/*', 'constructs'],
});

// The settings for the site tool (scripts/site-tool.mjs). Nothing stays external: the harness
// imports workspace TypeScript, which Node cannot load from node_modules without a build step.
export const SITE_TOOL_BUNDLE_BASE = Object.freeze({
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
});

export function markCommonJsScope(dir) {
  writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
}

const AGENTCORE_APP_FILTER =/bedrock-agentcore[\\/]dist[\\/]src[\\/]runtime[\\/]app\.js$/;
const AGENTCORE_CREATE_REQUIRE_LINE = 'const require = createRequire(import.meta.url);';

export function agentcoreInlineRequirePlugin() {
  return {
    name: 'agentcore-inline-require',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: AGENTCORE_APP_FILTER }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        if (!source.includes(AGENTCORE_CREATE_REQUIRE_LINE)) {
          throw new Error(
            `bedrock-agentcore's runtime/app.js no longer holds "${AGENTCORE_CREATE_REQUIRE_LINE}": re-check this plugin against the installed version`,
          );
        }
        return { contents: source.replace(AGENTCORE_CREATE_REQUIRE_LINE, ''), loader: 'js' };
      });
    },
  };
}
