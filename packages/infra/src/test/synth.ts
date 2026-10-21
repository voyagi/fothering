import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { isStaticallyCloseable } from '@fothering/core/closeability';
import { parseLaneMap, type LaneMap } from '@fothering/core/lanes';
import lanesJson from '../../../../lanes.json' with { type: 'json' };
import { ACCOUNT_SENDING_ACTIONS } from '../account-deny.js';
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
// stub folder and the reopen function the forget one: a stub bundle only has to exist to be hashed. The assembly goes inside the stub folder: an
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
      reopenAssetDir: assets.forgetAssetDir,
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
// D-104 names both pausing roles by their id in the action stack, so the reopen role needs no rule of
// its own when it joins.
const PAUSING_ROLE_PREFIXES = ['ActionRole', 'ReopenRole'];
const MODEL_SERVICES = ['bedrock', 'bedrock-agentcore'];
// The operator email is the only send any role may make, and only the action role makes it; raw and
// bulk sends stay refused everywhere.
const SEND_EMAIL = 'ses:SendEmail';
const SENDING_ROLE_PREFIX = 'ActionRole';
const SES_WRITES = [...ACCOUNT_SENDING_ACTIONS, 'ses:SendRawEmail', 'ses:SendBulkEmail'];
const CONFIGURATION_SET_ARN_TAIL = /:configuration-set\/([^*?]+)$/;
const FROM_ADDRESS_REF = JSON.stringify({ Ref: 'FromAddress' });
const FROM_DOMAIN = JSON.stringify({ 'Fn::Select': [1, { 'Fn::Split': ['@', { Ref: 'FromAddress' }] }] });

function joinedParts(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const join = (value as Record<string, unknown>)['Fn::Join'];
  const parts: unknown = Array.isArray(join) ? join[1] : undefined;
  return Array.isArray(parts) ? parts : [];
}

function lastJoinedPart(value: unknown): unknown {
  return joinedParts(value).at(-1);
}

// The one configuration set a granted resource names, or undefined when it names anything wider (a *,
// a wildcard in the name, a part only a deploy can resolve).
function pausedSetName(resource: string | null): string | undefined {
  if (resource === null) return undefined;
  const value: unknown = JSON.parse(resource);
  const tail = typeof value === 'string' ? value : lastJoinedPart(value);
  return typeof tail === 'string' ? CONFIGURATION_SET_ARN_TAIL.exec(tail)?.[1] : undefined;
}

// The single operator-alert set's name, or undefined when the lane map holds none or several.
function operatorAlertSet(laneMap: LaneMap): string | undefined {
  const alerts = laneMap.lanes.filter((lane) => lane.operatorAlert);
  return alerts.length === 1 ? alerts[0]?.configurationSet : undefined;
}

// Whether a granted resource is one of the three the operator email may use: the identity ARN whose
// name is exactly the FromAddress parameter, the one whose name is that parameter's domain, or the
// operator-alert set. A wildcard or any other name is something wider.
function isOperatorEmailResource(resource: string | null, laneMap: LaneMap): boolean {
  if (resource === null) return false;
  const parts = joinedParts(JSON.parse(resource));
  const [service] = parts;
  const name = parts.at(-1);
  const before = parts.at(-2);
  const isSesArn = typeof service === 'string' && service.startsWith('arn:') && service.includes(':ses:');
  if (isSesArn && typeof before === 'string' && before.endsWith(':identity/') && name !== undefined) {
    const named = JSON.stringify(name);
    return named === FROM_ADDRESS_REF || named === FROM_DOMAIN;
  }
  const alertSet = operatorAlertSet(laneMap);
  return alertSet !== undefined && pausedSetName(resource) === alertSet;
}

function roleKey(entry: PermissionEntry): string {
  return `${entry.stack}/${entry.role}`;
}

function sendViolations(entry: PermissionEntry, laneMap: LaneMap): string[] {
  if (!grantsAction(entry.action, SEND_EMAIL)) return [];
  const where = `${roleKey(entry)} ${entry.action}`;
  const violations: string[] = [];
  if (!(entry.stack === ACTION_STACK_ID && entry.role.startsWith(SENDING_ROLE_PREFIX))) {
    violations.push(`${where}: only the action role may hold ${SEND_EMAIL}`);
  }
  if (!isOperatorEmailResource(entry.resource, laneMap)) {
    violations.push(`${where}: ${SEND_EMAIL} reaches a resource other than the From identity, its domain or the operator-alert set`);
  }
  return violations;
}

// Every role holding the pause beside any action of a model service: the action must stay code's
// alone, so no role a model drives may also be able to close a lane.
function modelPairings(allows: readonly PermissionEntry[]): string[] {
  const pausing = new Set(allows.filter((entry) => grantsAction(entry.action, PAUSE_ACTION)).map(roleKey));
  const modelRoles = new Set(
    allows.filter((entry) => MODEL_SERVICES.some((service) => reachesService(entry.action, service))).map(roleKey),
  );
  return [...pausing].filter((role) => modelRoles.has(role)).map((role) => `${role}: holds ${PAUSE_ACTION} beside a bedrock or bedrock-agentcore action`);
}

// Every Allow grant that breaks the boundaries the stacks promise: the runtime reaches no SES,
// DynamoDB or S3 action, only the detection role may invoke the runtime, no role may invoke it for a
// user or run commands in it or write AgentCore Memory, no role may change account-level sending or
// send, only the action stack's pausing roles may pause a configuration set and only on a statically
// closeable lane, and no role pairs the pause with a model action.
export function permissionViolations(entries: readonly PermissionEntry[], laneMap: LaneMap): string[] {
  const closeable = new Set(laneMap.lanes.filter(isStaticallyCloseable).map((lane) => lane.configurationSet));
  const allows = entries.filter((entry) => entry.kind === 'permission' && entry.effect === 'Allow');
  const violations: string[] = [];
  for (const entry of allows) {
    const where = `${roleKey(entry)} ${entry.action}`;
    const isDetectRole = entry.stack === DETECTION_STACK_ID && entry.role.startsWith('DetectRole');
    const isPausingRole = entry.stack === ACTION_STACK_ID && PAUSING_ROLE_PREFIXES.some((prefix) => entry.role.startsWith(prefix));
    if (grantsAction(entry.action, PAUSE_ACTION)) {
      if (!isPausingRole) violations.push(`${where}: only a pausing role may hold ${PAUSE_ACTION}`);
      const paused = pausedSetName(entry.resource);
      if (paused === undefined || !closeable.has(paused)) {
        violations.push(`${where}: ${PAUSE_ACTION} reaches a configuration set outside the statically closeable lanes`);
      }
    }
    for (const service of RUNTIME_FORBIDDEN_SERVICES) {
      if (entry.stack === RUNTIME_STACK_ID && reachesService(entry.action, service)) violations.push(`${where}: the runtime role reaches ${service}`);
    }
    violations.push(...sendViolations(entry, laneMap));
    if (!isDetectRole && grantsAction(entry.action, INVOKE_RUNTIME)) violations.push(`${where}: only the detection role may invoke the runtime`);
    for (const probe of [...NO_ROLE_MAY_HOLD, ...SES_WRITES]) {
      if (grantsAction(entry.action, probe)) violations.push(`${where}: no role may hold ${probe}`);
    }
  }
  return [...violations, ...modelPairings(allows)];
}

// Every role, read from its trust entry so a role holding no permission at all is still seen, that
// lacks an unconditional Deny on * for one of the account-level actions.
export function denyViolations(entries: readonly PermissionEntry[]): string[] {
  const roles = [...new Set(entries.filter((entry) => entry.kind === 'trust').map(roleKey))];
  const denies = entries.filter((entry) => entry.kind === 'permission' && entry.effect === 'Deny' && entry.resource === '"*"' && entry.condition === null);
  return roles.flatMap((role) =>
    ACCOUNT_SENDING_ACTIONS.filter((action) => !denies.some((entry) => roleKey(entry) === role && grantsAction(entry.action, action))).map(
      (action) => `${role}: no Deny on * for ${action}`,
    ),
  );
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
