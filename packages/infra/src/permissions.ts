import { App } from 'aws-cdk-lib';
import { parseLaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { cdkJsonContext } from './cdk-context.js';
import { addFotheringStacks, INGEST_STACK_ID, RUNTIME_STACK_ID } from './create-app.js';
import { createStubAssets } from './stub-assets.js';

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
}

export type StackTemplates = Record<string, CfnTemplate>;

export interface PermissionEntry {
  stack: string;
  role: string;
  kind: 'permission' | 'trust';
  effect: string;
  action: string;
  resource: string | null;
  principal: string | null;
  condition: string | null;
}

export interface PermissionDiff {
  missing: PermissionEntry[];
  extra: PermissionEntry[];
}

export function synthesizePermissionTemplates(): StackTemplates {
  const assets = createStubAssets();
  try {
    const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
    addFotheringStacks(app, { laneMap: parseLaneMap(lanesJson), ...assets });
    const assembly = app.synth();
    return Object.fromEntries(
      [INGEST_STACK_ID, RUNTIME_STACK_ID].map((id) => [id, assembly.getStackByName(id).template as CfnTemplate]),
    );
  } finally {
    assets.remove();
  }
}

function entryKey(entry: PermissionEntry): string {
  return JSON.stringify([entry.stack, entry.role, entry.kind, entry.effect, entry.action, entry.resource, entry.principal, entry.condition]);
}

export function collectPermissions(templates: StackTemplates): PermissionEntry[] {
  return Object.keys(templates).length > 0 ? [] : [];
}

export function diffPermissions(first: readonly PermissionEntry[], second: readonly PermissionEntry[]): PermissionDiff {
  const inFirst = new Set(first.map(entryKey));
  const inSecond = new Set(second.map(entryKey));
  return {
    missing: first.filter((entry) => !inSecond.has(entryKey(entry))),
    extra: second.filter((entry) => !inFirst.has(entryKey(entry))),
  };
}

export function serializePermissions(entries: readonly PermissionEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
