import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectPermissions, serializePermissions, synthesizePermissionTemplates } from './permissions.js';
import { collectResources, serializeResources } from './resources.js';

// Run from the repo root by scripts/permissions-snapshot.mjs, which is what fixes the working folder.
const folder = resolve(process.cwd(), 'packages', 'infra');
if (!existsSync(folder)) {
  throw new Error(`${folder} does not exist: run npm run permissions:snapshot from the repo root`);
}

// One synthesis feeds both files, so the permissions and the resources always describe the same stacks.
const templates = synthesizePermissionTemplates();
const outputs: Array<[string, string]> = [
  [resolve(folder, 'permissions.json'), serializePermissions(collectPermissions(templates))],
  [resolve(folder, 'resources.json'), serializeResources(collectResources(templates))],
];
for (const [target, text] of outputs) {
  writeFileSync(target, text);
  console.log(`[permissions] wrote ${target}`);
}
