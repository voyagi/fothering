import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectPermissions, serializePermissions, synthesizePermissionTemplates } from './permissions.js';

// Run from the repo root by scripts/permissions-snapshot.mjs, which is what fixes the working folder.
const target = resolve(process.cwd(), 'packages', 'infra', 'permissions.json');
if (!existsSync(dirname(target))) {
  throw new Error(`${dirname(target)} does not exist: run npm run permissions:snapshot from the repo root`);
}

writeFileSync(target, serializePermissions(collectPermissions(synthesizePermissionTemplates())));
console.log(`[permissions] wrote ${target}`);
