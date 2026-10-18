import { App, CfnResource, Lazy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnRole, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_FUNCTION_TIMEOUT_MS } from '@fothering/core/close-values';
import { isStaticallyCloseable } from '@fothering/core/closeability';
import { parseLaneMap } from '@fothering/core/lanes';
import { LIVE_SWITCH } from '@fothering/core/mode';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { ACCOUNT_SENDING_ACTIONS, ACCOUNT_SENDING_DENY_POLICY_NAME, applyAccountSendingDeny } from './account-deny.js';
import { ActionStack } from './action-stack.js';
import { cdkJsonContext } from './cdk-context.js';
import { IngestStack } from './ingest-stack.js';
import { createStubAssets } from './stub-assets.js';
import { grantsAction, logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

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

function configurationSetArn(name: string): string {
  return JSON.stringify({ 'Fn::Join': ['', ['arn:aws:ses:eu-central-1:', { Ref: 'AWS::AccountId' }, `:configuration-set/${name}`]] });
}

function actionVariables(context: Record<string, unknown>): Record<string, unknown> {
  const stacks = synthStacks(context);
  try {
    const [action] = Object.values(resourcesOfType(stacks.action, 'AWS::Lambda::Function'));
    return (action?.Properties as FunctionProperties | undefined)?.Environment.Variables ?? {};
  } finally {
    stacks.dispose();
  }
}

// A synth loads aws-cdk-lib whole and hashes the stub assets, which under a full parallel suite runs
// past vitest's default hook limit, so every limit here is explicit.
describe('ActionStack synth', () => {
  let stacks: SynthesizedStacks;
  beforeAll(() => {
    stacks = synthStacks();
  }, 60_000);
  afterAll(() => stacks.dispose());

  function actionFunction(): { logicalId: string; properties: FunctionProperties } {
    const logicalId = logicalIdOf(stacks.action, 'AWS::Lambda::Function');
    const resource = resourcesOfType(stacks.action, 'AWS::Lambda::Function')[logicalId];
    return { logicalId, properties: resource?.Properties as unknown as FunctionProperties };
  }

  // Every resource each action is granted on, as canonical JSON, so merged and split statements read
  // the same.
  function grantsOfActionRole(): Record<string, string[]> {
    const roleId = logicalIdOf(stacks.action, 'AWS::IAM::Role');
    const grants: Record<string, string[]> = {};
    for (const statement of statementsByRole(stacks.action)[roleId] ?? []) {
      expect(statement.effect).toBe('Allow');
      for (const action of statement.actions) {
        grants[action] = [...(grants[action] ?? []), ...statement.resources.map((resource) => JSON.stringify(resource))].sort();
      }
    }
    return grants;
  }

  it('runs the action function on a five-minute schedule under its own role', () => {
    expect(stacks.action, 'the app holds no FotheringAction stack').toBeInstanceOf(Template);
    const { logicalId, properties } = actionFunction();
    expect(properties.Timeout).toBe(ACTION_FUNCTION_TIMEOUT_MS / 1000);
    expect(properties.Timeout).toBe(300);
    expect(properties.MemorySize).toBe(512);
    expect(properties.Runtime).toBe('nodejs22.x');
    expect(properties.Architectures).toEqual(['arm64']);
    expect(properties.Handler).toBe('index.handler');
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(properties.Role).toEqual({ 'Fn::GetAtt': [logicalIdOf(stacks.action, 'AWS::IAM::Role'), 'Arn'] });
    stacks.action.resourceCountIs('AWS::Events::Rule', 1);
    const [rule] = Object.values(resourcesOfType(stacks.action, 'AWS::Events::Rule'));
    expect(rule?.Properties?.ScheduleExpression).toBe('rate(5 minutes)');
    const targets = rule?.Properties?.Targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.Arn).toEqual({ 'Fn::GetAtt': [logicalId, 'Arn'] });
  });

  it('may pause and read back fothering-bulk alone, beside its table, SES read and log actions', () => {
    const grants = grantsOfActionRole();
    expect(Object.keys(grants).sort().join(',')).toBe(
      'dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSet,ses:GetConfigurationSetEventDestinations,ses:GetEmailIdentity,ses:ListConfigurationSets,ses:ListEmailIdentities,ses:PutConfigurationSetSendingOptions',
    );
    for (const action of PAUSE_ACTIONS) expect(grants[action]).toEqual([configurationSetArn('fothering-bulk')]);
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']) {
      expect(grants[action]).toHaveLength(1);
      expect(grants[action]?.[0]).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:[^"]*EventStore[^"]*Arn[^"]*"\}$/);
    }
    expect(grants['ses:GetConfigurationSetEventDestinations']).toEqual(stacks.laneMap.lanes.map((lane) => configurationSetArn(lane.configurationSet)).sort());
  });

  it('names in the pause grant exactly the statically closeable sets of lanes.json, both ways', () => {
    const paused = (grantsOfActionRole()['ses:PutConfigurationSetSendingOptions'] ?? []).map((resource) => {
      const match = /:configuration-set\/([^"]+)"\]\]\}$/.exec(resource);
      if (match?.[1] === undefined) throw new Error(`the pause grant names something other than one configuration set: ${resource}`);
      return match[1];
    });
    const closeable = stacks.laneMap.lanes.filter(isStaticallyCloseable).map((lane) => lane.configurationSet);
    expect(closeable.length).toBeGreaterThan(0);
    expect([...paused].sort()).toEqual([...closeable].sort());
    expect(new Set(paused).size).toBe(paused.length);
  });

  it('reads the table name from the ingest stack and nothing else in a default synth', () => {
    const variables = actionFunction().properties.Environment.Variables;
    expect(Object.keys(variables).join(',')).toBe('FOTHERING_TABLE_NAME');
    expect(JSON.stringify(variables.FOTHERING_TABLE_NAME)).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:/);
  });
});

describe('an action stack over a lane map with nothing statically closeable', () => {
  it('synthesizes no statement granting the pause, never * and never an empty list', { timeout: 60_000 }, () => {
    const lanes = lanesJson.lanes.map((lane) => (lane.configurationSet === 'fothering-bulk' ? { ...lane, criticality: 'transactional' } : lane));
    const laneMap = parseLaneMap({ ...lanesJson, lanes });
    expect(laneMap.lanes.filter(isStaticallyCloseable)).toEqual([]);
    const assets = createStubAssets();
    try {
      const env = { region: 'eu-central-1' };
      const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
      const ingest = new IngestStack(app, 'PlantedIngest', { env, laneMap, ingestAssetDir: assets.ingestAssetDir, forgetAssetDir: assets.forgetAssetDir });
      const action = Template.fromStack(new ActionStack(app, 'PlantedAction', { env, laneMap, actionAssetDir: assets.ingestAssetDir, ingest }));
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

describe('the action function carries the switch only from the context key', () => {
  it('holds no live value in a default synth', { timeout: 60_000 }, () => {
    expect(actionVariables({})[LIVE_SWITCH]).toBeUndefined();
  });

  it('carries live when the context key is live', { timeout: 60_000 }, () => {
    expect(actionVariables({ 'fothering:live': 'live' })[LIVE_SWITCH]).toBe('live');
  });
});
