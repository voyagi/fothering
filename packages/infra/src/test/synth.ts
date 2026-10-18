import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import { cdkJsonContext } from '../cdk-context.js';
import { ACTION_STACK_ID, addFotheringStacks, DETECTION_STACK_ID, RUNTIME_STACK_ID } from '../create-app.js';
import type { PermissionEntry } from '../permissions.js';
import { createStubAssets } from '../stub-assets.js';

export interface SynthesizedStacks {
  readonly laneMap: LaneMap;
  readonly ingest: Template;
  readonly runtime: Template;
  readonly detection: Template;
  readonly action: Template;
  /** The folder the synth wrote its assembly to. */
  readonly outdir: string;
  dispose(): void;
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown>; [key: string]: unknown }>;

// The deployed context plus whatever a test adds, over stub bundles, so a synth loads aws-cdk-lib
// and hashes a few small folders and nothing more. The detection and action functions reuse the ingest
// stub folder: a stub bundle only has to exist to be hashed. The assembly goes inside the stub folder: an
// App with no outdir writes to a new temp folder of its own, which nothing ever removes. A synth that
// throws returns no dispose to its caller, so the folder is removed here before the error goes on.
export function synthStacks(extraContext: Record<string, unknown> = {}): SynthesizedStacks {
  const assets = createStubAssets();
  try {
    const laneMap = parseLaneMap(lanesJson);
    const app = new App({ context: { ...cdkJsonContext, ...extraContext }, outdir: assets.outdir });
    const { ingest, runtime, detection, action } = addFotheringStacks(app, {
      laneMap,
      ...assets,
      detectAssetDir: assets.ingestAssetDir,
      actionAssetDir: assets.ingestAssetDir,
    });
    return {
      laneMap,
      ingest: Template.fromStack(ingest),
      runtime: Template.fromStack(runtime),
      detection: Template.fromStack(detection),
      action: Template.fromStack(action),
      outdir: app.outdir,
      dispose: assets.remove,
    };
  } catch (error) {
    assets.remove();
    throw error;
  }
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

// IAM compares action names case-insensitively, a * standing for any run of characters (the colon
// included) and a ? for exactly one.
export function grantsAction(granted: string, probe: string): boolean {
  const pattern = [...granted].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.|+()[\]{}]/g, '\\$&'))).join('');
  return new RegExp(`^${pattern}$`, 'i').test(probe);
}

// Whether a granted action reaches any action of the service, so a literal action, a service
// wildcard and a bare * are all caught without listing the service's every action.
function reachesService(granted: string, service: string): boolean {
  const colon = granted.indexOf(':');
  return colon === -1 ? grantsAction(granted, `${service}:Probe`) : grantsAction(granted.slice(0, colon), service);
}

const RUNTIME_FORBIDDEN_SERVICES = ['ses', 'dynamodb', 's3'];
const INVOKE_RUNTIME = 'bedrock-agentcore:InvokeAgentRuntime';
const NO_ROLE_MAY_HOLD = [
  'bedrock-agentcore:InvokeAgentRuntimeForUser',
  'bedrock-agentcore:InvokeAgentRuntimeCommand',
  'bedrock-agentcore:InvokeAgentRuntimeCommandShell',
  'bedrock-agentcore:CreateEvent',
];
const PAUSE_ACTION = 'ses:PutConfigurationSetSendingOptions';
const PAUSING_ROLE_PREFIXES = ['ActionRole', 'ReopenRole'];
const SES_WRITES = [
  'ses:PutAccountSendingAttributes',
  'ses:UpdateAccountSendingEnabled',
  'ses:UpdateConfigurationSetSendingEnabled',
  'ses:SendEmail',
  'ses:SendRawEmail',
  'ses:SendBulkEmail',
];

// Every Allow grant that breaks the boundaries the stacks promise: the runtime reaches no SES,
// DynamoDB or S3 action, only the detection role may invoke the runtime, no role may invoke it for a
// user or run commands in it or write AgentCore Memory, no role may change account-level sending or
// send, and only the action stack's pausing roles may pause a configuration set.
export function permissionViolations(entries: readonly PermissionEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'permission' || entry.effect !== 'Allow') continue;
    const where = `${entry.stack}/${entry.role} ${entry.action}`;
    const isDetectRole = entry.stack === DETECTION_STACK_ID && entry.role.startsWith('DetectRole');
    const isPausingRole = entry.stack === ACTION_STACK_ID && PAUSING_ROLE_PREFIXES.some((prefix) => entry.role.startsWith(prefix));
    if (!isPausingRole && grantsAction(entry.action, PAUSE_ACTION)) violations.push(`${where}: only a pausing role may hold ${PAUSE_ACTION}`);
    for (const service of RUNTIME_FORBIDDEN_SERVICES) {
      if (entry.stack === RUNTIME_STACK_ID && reachesService(entry.action, service)) violations.push(`${where}: the runtime role reaches ${service}`);
    }
    if (!isDetectRole && grantsAction(entry.action, INVOKE_RUNTIME)) violations.push(`${where}: only the detection role may invoke the runtime`);
    for (const probe of [...NO_ROLE_MAY_HOLD, ...SES_WRITES]) {
      if (grantsAction(entry.action, probe)) violations.push(`${where}: no role may hold ${probe}`);
    }
  }
  return violations;
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
