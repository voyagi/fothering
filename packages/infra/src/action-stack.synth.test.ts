import { App, CfnResource, Lazy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnRole, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_FUNCTION_TIMEOUT_MS, REOPEN_FUNCTION_TIMEOUT_MS } from '@fothering/core/close-values';
import { isStaticallyCloseable } from '@fothering/core/closeability';
import { parseLaneMap } from '@fothering/core/lanes';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { FIND_REOPEN_FUNCTION_COMMAND } from '@fothering/core/reopen';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { ACCOUNT_SENDING_ACTIONS, ACCOUNT_SENDING_DENY_POLICY_NAME, applyAccountSendingDeny } from './account-deny.js';
import { ActionStack } from './action-stack.js';
import { cdkJsonContext } from './cdk-context.js';
import { ACTION_STACK_ID } from './create-app.js';
import { IngestStack } from './ingest-stack.js';
import { createStubAssets } from './stub-assets.js';
import { grantsAction, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

interface FunctionProperties {
  Runtime: string;
  Architectures: string[];
  Handler: string;
  Timeout: number;
  MemorySize: number;
  ReservedConcurrentExecutions?: number;
  Role: { 'Fn::GetAtt': [string, string] };
  Environment: { Variables: Record<string, unknown> };
}

const PAUSE_ACTIONS = ['ses:GetConfigurationSet', 'ses:PutConfigurationSetSendingOptions'];
const ACTION_FUNCTION = 'ActionFunction';
const REOPEN_FUNCTION = 'ReopenFunction';
const PAUSING_ROLES = ['ActionRole', 'ReopenRole'] as const;

function configurationSetArn(name: string): string {
  return JSON.stringify({ 'Fn::Join': ['', ['arn:aws:ses:eu-central-1:', { Ref: 'AWS::AccountId' }, `:configuration-set/${name}`]] });
}

// The action stack holds two functions and two roles, so each is found by the id it was built under.
function logicalIdWithPrefix(template: Template, type: string, prefix: string): string {
  const ids = Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
  const [only] = ids;
  if (ids.length !== 1 || only === undefined) throw new Error(`expected exactly one ${type} named ${prefix}, found ${ids.length}`);
  return only;
}

function functionOf(template: Template, prefix: string): { logicalId: string; properties: FunctionProperties } {
  const logicalId = logicalIdWithPrefix(template, 'AWS::Lambda::Function', prefix);
  const resource = resourcesOfType(template, 'AWS::Lambda::Function')[logicalId];
  return { logicalId, properties: resource?.Properties as unknown as FunctionProperties };
}

function functionVariables(context: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const stacks = synthStacks(context);
  try {
    return functionOf(stacks.action, prefix).properties.Environment.Variables;
  } finally {
    stacks.dispose();
  }
}

// Every resource each action is granted on, as canonical JSON, so merged and split statements read
// the same.
function grantsOfRole(template: Template, prefix: string): Record<string, string[]> {
  const roleId = logicalIdWithPrefix(template, 'AWS::IAM::Role', prefix);
  const grants: Record<string, string[]> = {};
  for (const statement of statementsByRole(template)[roleId] ?? []) {
    expect(statement.effect).toBe('Allow');
    for (const action of statement.actions) {
      grants[action] = [...(grants[action] ?? []), ...statement.resources.map((resource) => JSON.stringify(resource))].sort();
    }
  }
  return grants;
}

function pausedSetsOf(grants: Record<string, string[]>): string[] {
  return (grants['ses:PutConfigurationSetSendingOptions'] ?? []).map((resource) => {
    const match = /:configuration-set\/([^"]+)"\]\]\}$/.exec(resource);
    if (match?.[1] === undefined) throw new Error(`the pause grant names something other than one configuration set: ${resource}`);
    return match[1];
  });
}

const TABLE_IMPORT = /^\{"Fn::ImportValue":"FotheringIngest:[^"]*EventStore[^"]*Arn[^"]*"\}$/;

// A synth loads aws-cdk-lib whole and hashes the stub assets, which under a full parallel suite runs
// past vitest's default hook limit, so every limit here is explicit.
describe('ActionStack synth', () => {
  let stacks: SynthesizedStacks;
  beforeAll(() => {
    stacks = synthStacks();
  }, 60_000);
  afterAll(() => stacks.dispose());

  it('runs the action function on a five-minute schedule under its own role', () => {
    expect(stacks.action, 'the app holds no FotheringAction stack').toBeInstanceOf(Template);
    const { logicalId, properties } = functionOf(stacks.action, ACTION_FUNCTION);
    expect(properties.Timeout).toBe(ACTION_FUNCTION_TIMEOUT_MS / 1000);
    expect(properties.Timeout).toBe(300);
    expect(properties.MemorySize).toBe(512);
    expect(properties.Runtime).toBe('nodejs22.x');
    expect(properties.Architectures).toEqual(['arm64']);
    expect(properties.Handler).toBe('index.handler');
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(properties.Role).toEqual({ 'Fn::GetAtt': [logicalIdWithPrefix(stacks.action, 'AWS::IAM::Role', 'ActionRole'), 'Arn'] });
    stacks.action.resourceCountIs('AWS::Events::Rule', 1);
    const [rule] = Object.values(resourcesOfType(stacks.action, 'AWS::Events::Rule'));
    expect(rule?.Properties?.ScheduleExpression).toBe('rate(5 minutes)');
    const targets = rule?.Properties?.Targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.Arn).toEqual({ 'Fn::GetAtt': [logicalId, 'Arn'] });
  });

  it('runs the reopen function by hand only, under its own role, with the reopen timeout (AC-23)', () => {
    expect(Object.keys(resourcesOfType(stacks.action, 'AWS::Lambda::Function'))).toHaveLength(2);
    const { logicalId, properties } = functionOf(stacks.action, REOPEN_FUNCTION);
    expect(properties.Timeout).toBe(REOPEN_FUNCTION_TIMEOUT_MS / 1000);
    expect(properties.Timeout).toBe(30);
    expect(properties.MemorySize).toBe(256);
    expect(properties.Runtime).toBe('nodejs22.x');
    expect(properties.Architectures).toEqual(['arm64']);
    expect(properties.Handler).toBe('index.handler');
    expect(properties.Role).toEqual({ 'Fn::GetAtt': [logicalIdWithPrefix(stacks.action, 'AWS::IAM::Role', 'ReopenRole'), 'Arn'] });
    const ruleTargets = Object.values(resourcesOfType(stacks.action, 'AWS::Events::Rule')).flatMap(
      (rule) => (rule.Properties?.Targets ?? []) as Array<Record<string, unknown>>,
    );
    expect(JSON.stringify(ruleTargets)).not.toContain(logicalId);
  });

  it('names the reopen function in the ReopenFunctionName output, the one the documented lookup reads', () => {
    const outputs = stacks.action.toJSON().Outputs as Record<string, { Value: unknown }> | undefined;
    expect(outputs?.ReopenFunctionName?.Value).toEqual({ Ref: functionOf(stacks.action, REOPEN_FUNCTION).logicalId });
    expect(FIND_REOPEN_FUNCTION_COMMAND).toContain(`OutputKey=='ReopenFunctionName'`);
    expect(FIND_REOPEN_FUNCTION_COMMAND).toContain(`--stack-name ${ACTION_STACK_ID}`);
    expect(ACTION_STACK_ID).toBe('FotheringAction');
  });

  it('may pause and read back fothering-bulk alone, beside its table, SES read and log actions', () => {
    const grants = grantsOfRole(stacks.action, 'ActionRole');
    expect(Object.keys(grants).sort().join(',')).toBe(
      'dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSet,ses:GetConfigurationSetEventDestinations,ses:GetEmailIdentity,ses:ListConfigurationSets,ses:ListEmailIdentities,ses:PutConfigurationSetSendingOptions',
    );
    for (const action of PAUSE_ACTIONS) expect(grants[action]).toEqual([configurationSetArn('fothering-bulk')]);
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']) {
      expect(grants[action]).toHaveLength(1);
      expect(grants[action]?.[0]).toMatch(TABLE_IMPORT);
    }
    expect(grants['ses:GetConfigurationSetEventDestinations']).toEqual(stacks.laneMap.lanes.map((lane) => configurationSetArn(lane.configurationSet)).sort());
  });

  it('lets the reopen role read and update named items, and reopen and read back fothering-bulk alone (D-104)', () => {
    const grants = grantsOfRole(stacks.action, 'ReopenRole');
    expect(Object.keys(grants).sort().join(',')).toBe(
      'dynamodb:GetItem,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSet,ses:PutConfigurationSetSendingOptions',
    );
    for (const action of PAUSE_ACTIONS) expect(grants[action]).toEqual([configurationSetArn('fothering-bulk')]);
    for (const action of ['dynamodb:GetItem', 'dynamodb:UpdateItem']) {
      expect(grants[action]).toHaveLength(1);
      expect(grants[action]?.[0]).toMatch(TABLE_IMPORT);
    }
    const role = resourcesOfType(stacks.action, 'AWS::IAM::Role')[logicalIdWithPrefix(stacks.action, 'AWS::IAM::Role', 'ReopenRole')];
    const policyNames = ((role?.Properties?.Policies ?? []) as Array<{ PolicyName: string }>).map((policy) => policy.PolicyName);
    expect(policyNames).toContain(ACCOUNT_SENDING_DENY_POLICY_NAME);
  });

  it.each(PAUSING_ROLES)('names in the %s pause grant exactly the statically closeable sets of lanes.json, both ways (AC-E16)', (role) => {
    const paused = pausedSetsOf(grantsOfRole(stacks.action, role));
    const closeable = stacks.laneMap.lanes.filter(isStaticallyCloseable).map((lane) => lane.configurationSet);
    expect(closeable.length).toBeGreaterThan(0);
    expect([...paused].sort()).toEqual([...closeable].sort());
    expect(new Set(paused).size).toBe(paused.length);
  });

  it.each([ACTION_FUNCTION, REOPEN_FUNCTION])('gives %s the table name from the ingest stack and nothing else in a default synth', (prefix) => {
    const variables = functionOf(stacks.action, prefix).properties.Environment.Variables;
    expect(Object.keys(variables).join(',')).toBe('FOTHERING_TABLE_NAME');
    expect(JSON.stringify(variables.FOTHERING_TABLE_NAME)).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:/);
  });
});

describe('an action stack over a lane map with nothing statically closeable', () => {
  it('synthesizes no statement granting the pause on either role, never * and never an empty list (AC-E17)', { timeout: 60_000 }, () => {
    const lanes = lanesJson.lanes.map((lane) => (lane.configurationSet === 'fothering-bulk' ? { ...lane, criticality: 'transactional' } : lane));
    const laneMap = parseLaneMap({ ...lanesJson, lanes });
    expect(laneMap.lanes.filter(isStaticallyCloseable)).toEqual([]);
    const assets = createStubAssets();
    try {
      const env = { region: 'eu-central-1' };
      const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
      const ingest = new IngestStack(app, 'PlantedIngest', { env, laneMap, ingestAssetDir: assets.ingestAssetDir, forgetAssetDir: assets.forgetAssetDir });
      const action = Template.fromStack(
        new ActionStack(app, 'PlantedAction', { env, laneMap, actionAssetDir: assets.ingestAssetDir, reopenAssetDir: assets.forgetAssetDir, ingest }),
      );
      for (const role of PAUSING_ROLES) expect(Object.keys(grantsOfRole(action, role))).toContain('dynamodb:GetItem');
      const statements = Object.values(statementsByRole(action)).flat();
      expect(statements.some((statement) => statement.actions.includes('dynamodb:Query'))).toBe(true);
      for (const statement of statements) {
        expect(statement.actions.some((granted) => grantsAction(granted, 'ses:PutConfigurationSetSendingOptions'))).toBe(false);
        expect(statement.resources.length).toBeGreaterThan(0);
      }
    } finally {
      assets.remove();
    }
  });
});

const TRUST = { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] };

function policiesOfRoles(stack: Stack): Array<Array<{ PolicyName: string; PolicyDocument: unknown }>> {
  return Object.values(resourcesOfType(Template.fromStack(stack), 'AWS::IAM::Role')).map(
    (role) => (role.Properties?.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>,
  );
}

describe('the account-level Deny Aspect', () => {
  it('adds one Deny policy to a role, keeping the inline policy it already held, however often it is applied', () => {
    const app = new App();
    const stack = new Stack(app, 'Planted');
    const kept = new PolicyDocument({ statements: [new PolicyStatement({ effect: Effect.ALLOW, actions: ['sqs:SendMessage'], resources: ['*'] })] });
    new Role(stack, 'Kept', { assumedBy: new ServicePrincipal('lambda.amazonaws.com'), inlinePolicies: { Kept: kept } });
    applyAccountSendingDeny(app);
    applyAccountSendingDeny(app);
    const [policies] = policiesOfRoles(stack);
    expect(policies?.map((policy) => policy.PolicyName)).toEqual(['Kept', ACCOUNT_SENDING_DENY_POLICY_NAME]);
    expect(policies?.[1]?.PolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: [...ACCOUNT_SENDING_ACTIONS], Resource: '*' }],
    });
  });

  it('covers a role an AgentCore runtime holds through withoutPolicyUpdates', () => {
    const app = new App();
    const stack = new Stack(app, 'Planted');
    const role = new Role(stack, 'Immutable', { assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com') });
    role.withoutPolicyUpdates().addToPrincipalPolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ['s3:GetObject'], resources: ['*'] }));
    applyAccountSendingDeny(app);
    expect(policiesOfRoles(stack).map((policies) => policies.map((policy) => policy.PolicyName))).toEqual([[ACCOUNT_SENDING_DENY_POLICY_NAME]]);
  });

  it('throws at synth on an IAM role built without CfnRole, naming its path', () => {
    const app = new App();
    const stack = new Stack(app, 'Planted');
    new CfnResource(stack, 'RawRole', { type: 'AWS::IAM::Role', properties: { AssumeRolePolicyDocument: TRUST } });
    applyAccountSendingDeny(app);
    expect(() => app.synth()).toThrow(/Planted\/RawRole is an IAM role built without CfnRole, so the account-level Deny cannot be added to it/);
  });

  it('throws at synth on a role whose inline policies are a token it cannot extend', () => {
    const app = new App();
    const stack = new Stack(app, 'Planted');
    new CfnRole(stack, 'TokenRole', { assumeRolePolicyDocument: TRUST, policies: Lazy.any({ produce: () => [] }) });
    applyAccountSendingDeny(app);
    expect(() => app.synth()).toThrow(/Planted\/TokenRole holds its inline policies as a token/);
  });
});

describe.each([ACTION_FUNCTION, REOPEN_FUNCTION])('%s carries the switch only from the context key', (prefix) => {
  it('holds no live value in a default synth', { timeout: 60_000 }, () => {
    expect(functionVariables({}, prefix)[LIVE_SWITCH]).toBeUndefined();
  });

  it('carries live when the context key is live', { timeout: 60_000 }, () => {
    expect(functionVariables({ 'fothering:live': 'live' }, prefix)[LIVE_SWITCH]).toBe('live');
  });
});
