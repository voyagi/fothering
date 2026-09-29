import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StubAssets {
  readonly ingestAssetDir: string;
  readonly forgetAssetDir: string;
  readonly agentAssetDir: string;
  /** Where a synth of these bundles may write its assembly; created by the synth, removed with the rest. */
  readonly outdir: string;
  remove(): void;
}

// A synthesized asset needs a real directory to hash, and an in-process synth must never run
// esbuild, so each function's code is a one-file stand-in for the bundle a build produces.
export function createStubAssets(): StubAssets {
  const root = mkdtempSync(join(tmpdir(), 'fothering-stub-assets-'));
  const dirs = { ingest: join(root, 'ingest'), forget: join(root, 'forget'), agent: join(root, 'agent') };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  writeFileSync(join(dirs.ingest, 'index.js'), 'exports.handler = async () => ({});\n');
  writeFileSync(join(dirs.forget, 'index.js'), 'exports.handler = async () => ({});\n');
  writeFileSync(join(dirs.agent, 'main.js'), 'process.exit(0);\n');
  return {
    ingestAssetDir: dirs.ingest,
    forgetAssetDir: dirs.forget,
    agentAssetDir: dirs.agent,
    outdir: join(root, 'cdk.out'),
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}
