import { App } from 'aws-cdk-lib';
import { parseLaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { cdkJsonContext } from './cdk-context.js';
import { ACTION_STACK_ID, addFotheringStacks, DETECTION_STACK_ID, INGEST_STACK_ID, RUNTIME_STACK_ID } from './create-app.js';
import { createStubAssets } from './stub-assets.js';

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
}

export type StackTemplates = Record<string, CfnTemplate>;

export interface PermissionEntry {
  stack: string;
  /** The role's logical id in its template. */
  role: string;
  kind: 'permission' | 'trust';
  effect: string;
  /** The action, or the canonical JSON of an intrinsic that resolves to one. */
  action: string;
  /** Canonical JSON of the resource intrinsic; null on a trust entry. */
  resource: string | null;
  /** Canonical JSON of the principal; null on a permission entry. */
  principal: string | null;
  /** Canonical JSON of the statement's Condition; null when it has none. */
  condition: string | null;
}

export interface PermissionDiff {
  /** In the first list and not the second. */
  missing: PermissionEntry[];
  /** In the second list and not the first. */
  extra: PermissionEntry[];
}

const STACK_IDS = [INGEST_STACK_ID, RUNTIME_STACK_ID, DETECTION_STACK_ID, ACTION_STACK_ID] as const;

// The detection and action functions reuse the ingest stub folder and the reopen function the forget
// one: a stub bundle only has to exist to be hashed.
export function synthesizePermissionTemplates(): StackTemplates {
  const assets = createStubAssets();
  try {
    const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
    addFotheringStacks(app, {
      laneMap: parseLaneMap(lanesJson),
      ...assets,
      detectAssetDir: assets.ingestAssetDir,
      actionAssetDir: assets.ingestAssetDir,
      reopenAssetDir: assets.forgetAssetDir,
    });
    const assembly = app.synth();
    return Object.fromEntries(STACK_IDS.map((id) => [id, assembly.getStackByName(id).template as CfnTemplate]));
  } finally {
    assets.remove();
  }
}

// Keys sorted at every depth, so the same intrinsic always renders to the same text.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asList(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

const UNSUPPORTED_STATEMENT_KEYS = ['NotAction', 'NotResource', 'NotPrincipal'];

interface StatementContext {
  stack: string;
  role: string;
  kind: PermissionEntry['kind'];
}

function entriesOfDocument(document: unknown, context: StatementContext): PermissionEntry[] {
  const statements = asList((document as { Statement?: unknown } | undefined)?.Statement) as Array<Record<string, unknown>>;
  return statements.flatMap((statement): PermissionEntry[] => {
    for (const key of UNSUPPORTED_STATEMENT_KEYS) {
      if (statement[key] !== undefined) {
        throw new Error(`${context.stack}/${context.role} has a statement using ${key}: the snapshot cannot say what that grants, so it refuses it`);
      }
    }
    const condition = statement.Condition === undefined ? null : canonical(statement.Condition);
    const effect = String(statement.Effect);
    const actions = asList(statement.Action).map((action) => (typeof action === 'string' ? action : canonical(action)));
    if (context.kind === 'trust') {
      const principal = canonical(statement.Principal);
      return actions.map((action) => ({ ...context, effect, action, resource: null, principal, condition }));
    }
    const resources = asList(statement.Resource);
    if (resources.length === 0) throw new Error(`${context.stack}/${context.role} has a statement with no Resource`);
    return actions.flatMap((action) =>
      resources.map((resource) => ({ ...context, effect, action, resource: canonical(resource), principal: null, condition })),
    );
  });
}

function roleIdsOfPolicy(stack: string, policyId: string, properties: Record<string, unknown>): string[] {
  if (properties.Users !== undefined || properties.Groups !== undefined) {
    throw new Error(`${stack}/${policyId} attaches to a user or a group: the snapshot only covers roles`);
  }
  return asList(properties.Roles).map((role) => {
    const ref = (role as { Ref?: unknown }).Ref;
    if (typeof ref !== 'string') throw new Error(`${stack}/${policyId} names a role by something other than a reference to a role in the template`);
    return ref;
  });
}

function entriesOfResource(stack: string, logicalId: string, resource: CfnResource): PermissionEntry[] {
  const properties = resource.Properties ?? {};
  if (resource.Type === 'AWS::IAM::Role') {
    // A managed policy's content is not in the template, so a role holding one cannot be snapshotted.
    if (properties.ManagedPolicyArns !== undefined) {
      throw new Error(`${stack}/${logicalId} carries ManagedPolicyArns: its permissions are not in the template, so the snapshot refuses it`);
    }
    const inline = asList(properties.Policies).flatMap((policy) =>
      entriesOfDocument((policy as { PolicyDocument?: unknown }).PolicyDocument, { stack, role: logicalId, kind: 'permission' }),
    );
    return [...entriesOfDocument(properties.AssumeRolePolicyDocument, { stack, role: logicalId, kind: 'trust' }), ...inline];
  }
  if (resource.Type === 'AWS::IAM::Policy') {
    return roleIdsOfPolicy(stack, logicalId, properties).flatMap((role) =>
      entriesOfDocument(properties.PolicyDocument, { stack, role, kind: 'permission' }),
    );
  }
  if (resource.Type.startsWith('AWS::IAM::')) {
    throw new Error(`${stack}/${logicalId} is a ${resource.Type}: the snapshot covers roles and their policies only, so it refuses any other IAM resource`);
  }
  return [];
}

export function compareText(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(a: PermissionEntry, b: PermissionEntry): number {
  return (
    compareText(a.stack, b.stack) ||
    compareText(a.role, b.role) ||
    compareText(a.kind, b.kind) ||
    compareText(a.action, b.action) ||
    compareText(a.resource, b.resource) ||
    compareText(a.principal, b.principal) ||
    compareText(a.condition, b.condition) ||
    compareText(a.effect, b.effect)
  );
}

// Built from the fields, never from the entry object, so a snapshot file whose keys were written in
// another order still compares equal to the same permission.
function entryKey(entry: PermissionEntry): string {
  return JSON.stringify([entry.stack, entry.role, entry.kind, entry.effect, entry.action, entry.resource, entry.principal, entry.condition]);
}

// One entry per action and resource of every role statement, and one per action of every trust
// statement, over every stack, sorted so the same code always yields the same list.
export function collectPermissions(templates: StackTemplates): PermissionEntry[] {
  const unique = new Map<string, PermissionEntry>();
  for (const [stack, template] of Object.entries(templates)) {
    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      for (const entry of entriesOfResource(stack, logicalId, resource)) unique.set(entryKey(entry), entry);
    }
  }
  return [...unique.values()].sort(compareEntries);
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
