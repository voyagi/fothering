import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import { cdkJsonContext } from '../cdk-context.js';
import { addFotheringStacks } from '../create-app.js';
import { createStubAssets } from '../stub-assets.js';

export interface SynthesizedStacks {
  readonly laneMap: LaneMap;
  readonly ingest: Template;
  readonly runtime: Template;
  dispose(): void;
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown>; [key: string]: unknown }>;

// The deployed context plus whatever a test adds, over stub bundles, so a synth loads aws-cdk-lib
// and hashes two small folders and nothing more.
export function synthStacks(extraContext: Record<string, unknown> = {}): SynthesizedStacks {
  const assets = createStubAssets();
  const laneMap = parseLaneMap(lanesJson);
  const app = new App({ context: { ...cdkJsonContext, ...extraContext } });
  const { ingest, runtime } = addFotheringStacks(app, { laneMap, ...assets });
  return {
    laneMap,
    ingest: Template.fromStack(ingest),
    runtime: Template.fromStack(runtime),
    dispose: assets.remove,
  };
}

// The Template matchers throw a readable diff on a mismatch, and the lint rule that wants every test
// to assert counts only expect, so they run under one.
export function expectTemplate(check: () => void): void {
  expect(check).not.toThrow();
}

export function resourcesOfType(template: Template, type: string): Resources {
  return template.findResources(type) as Resources;
}

export function logicalIdOf(template: Template, type: string): string {
  const ids = Object.keys(template.findResources(type));
  const [only] = ids;
  if (ids.length !== 1 || only === undefined) throw new Error(`expected exactly one ${type}, found ${ids.length}`);
  return only;
}

// Every property that would pin a physical name. A name fixed in the template makes a second
// deploy or a replacement collide with the first, so the stacks may carry none, bar the ones a
// caller names.
const NAME_PROPERTIES = ['TableName', 'QueueName', 'FunctionName', 'RoleName', 'AlarmName', 'Name', 'LogGroupName', 'AgentRuntimeName'];

// A bare Ref or GetAtt is a pointer to another resource (an invoke permission's FunctionName), not
// a name the template chooses.
function isReference(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0] === 'Fn::GetAtt');
}

export function fixedNames(template: Template): Array<{ logicalId: string; type: string; property: string }> {
  const found: Array<{ logicalId: string; type: string; property: string }> = [];
  const resources = template.toJSON().Resources as Resources;
  for (const [logicalId, resource] of Object.entries(resources)) {
    for (const property of NAME_PROPERTIES) {
      const value = resource.Properties?.[property];
      if (value !== undefined && !isReference(value)) found.push({ logicalId, type: resource.Type, property });
    }
  }
  return found;
}

export interface StatementView {
  readonly effect: string;
  readonly actions: string[];
  readonly resources: unknown[];
}

// Every statement each IAM role carries, from its inline policies and from the standalone
// policy resources attached to it, keyed by the role's logical id.
export function statementsByRole(template: Template): Record<string, StatementView[]> {
  const byRole: Record<string, StatementView[]> = {};
  const toView = (statement: Record<string, unknown>): StatementView => ({
    effect: statement.Effect as string,
    actions: [statement.Action].flat() as string[],
    resources: [statement.Resource].flat(),
  });
  for (const policy of Object.values(resourcesOfType(template, 'AWS::IAM::Policy'))) {
    const properties = policy.Properties as { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<Record<string, unknown>> } };
    for (const { Ref: roleId } of properties.Roles) {
      byRole[roleId] = [...(byRole[roleId] ?? []), ...properties.PolicyDocument.Statement.map(toView)];
    }
  }
  return byRole;
}
