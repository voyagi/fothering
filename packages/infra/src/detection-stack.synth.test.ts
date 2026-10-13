import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { expectTemplate, logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

interface FunctionProperties {
  Runtime: string;
  Architectures: string[];
  Handler: string;
  Timeout: number;
  MemorySize: number;
  ReservedConcurrentExecutions?: number;
  Role: { 'Fn::GetAtt': [string, string] };
  Environment: { Variables: Record<string, unknown> };
  LoggingConfig: { LogGroup: { Ref: string } };
}

function detectionVariables(context: Record<string, unknown>): Record<string, unknown> {
  const stacks = synthStacks(context);
  try {
    const [detect] = Object.values(resourcesOfType(stacks.detection, 'AWS::Lambda::Function'));
    return (detect?.Properties as FunctionProperties | undefined)?.Environment.Variables ?? {};
  } finally {
    stacks.dispose();
  }
}

// A synth loads aws-cdk-lib whole and hashes the stub assets, which under a full parallel suite runs
// past vitest's default hook limit, so every limit here is explicit.
describe('DetectionStack synth', () => {
  let stacks: SynthesizedStacks;
  beforeAll(() => {
    stacks = synthStacks();
  }, 60_000);
  afterAll(() => stacks.dispose());

  function detectFunction(): { logicalId: string; properties: FunctionProperties } {
    const logicalId = logicalIdOf(stacks.detection, 'AWS::Lambda::Function');
    const resource = resourcesOfType(stacks.detection, 'AWS::Lambda::Function')[logicalId];
    return { logicalId, properties: resource?.Properties as unknown as FunctionProperties };
  }

  // Every resource each action is granted on, as canonical JSON, so merged and split statements read
  // the same.
  function grantsOfDetectRole(): Record<string, string[]> {
    const roleId = logicalIdOf(stacks.detection, 'AWS::IAM::Role');
    const grants: Record<string, string[]> = {};
    for (const statement of statementsByRole(stacks.detection)[roleId] ?? []) {
      expect(statement.effect).toBe('Allow');
      for (const action of statement.actions) {
        grants[action] = [...(grants[action] ?? []), ...statement.resources.map((resource) => JSON.stringify(resource))].sort();
      }
    }
    return grants;
  }

  it('runs one function on nodejs22.x arm64 for 300 s with 512 MB, no reserved concurrency and no retry', () => {
    const { logicalId, properties } = detectFunction();
    expect(properties.Runtime).toBe('nodejs22.x');
    expect(properties.Architectures).toEqual(['arm64']);
    expect(properties.Handler).toBe('index.handler');
    expect(properties.Timeout).toBe(300);
    expect(properties.MemorySize).toBe(512);
    expect(properties.ReservedConcurrentExecutions).toBeUndefined();
    expect(properties.Role).toEqual({ 'Fn::GetAtt': [logicalIdOf(stacks.detection, 'AWS::IAM::Role'), 'Arn'] });
    expectTemplate(() =>
      stacks.detection.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
        FunctionName: { Ref: logicalId },
        MaximumRetryAttempts: 0,
      }),
    );
  });

  it('reads the table name and the runtime arn from the other two stacks, and nothing else, in a default synth', () => {
    const variables = detectFunction().properties.Environment.Variables;
    expect(Object.keys(variables).sort().join(',')).toBe('FOTHERING_AGENT_RUNTIME_ARN,FOTHERING_TABLE_NAME');
    expect(JSON.stringify(variables.FOTHERING_TABLE_NAME)).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:/);
    expect(JSON.stringify(variables.FOTHERING_AGENT_RUNTIME_ARN)).toMatch(/^\{"Fn::ImportValue":"FotheringRuntime:/);
  });

  it('runs every five minutes, the rule targeting the function and nothing else', () => {
    stacks.detection.resourceCountIs('AWS::Events::Rule', 1);
    const [rule] = Object.values(resourcesOfType(stacks.detection, 'AWS::Events::Rule'));
    expect(rule?.Properties?.ScheduleExpression).toBe('rate(5 minutes)');
    expect(rule?.Properties?.EventPattern).toBeUndefined();
    const targets = rule?.Properties?.Targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.Arn).toEqual({ 'Fn::GetAtt': [detectFunction().logicalId, 'Arn'] });
    const [permission] = Object.values(resourcesOfType(stacks.detection, 'AWS::Lambda::Permission'));
    expect(permission?.Properties).toEqual({
      Action: 'lambda:InvokeFunction',
      FunctionName: { 'Fn::GetAtt': [detectFunction().logicalId, 'Arn'] },
      Principal: 'events.amazonaws.com',
      SourceArn: { 'Fn::GetAtt': [logicalIdOf(stacks.detection, 'AWS::Events::Rule'), 'Arn'] },
    });
    stacks.detection.resourceCountIs('AWS::Lambda::Permission', 1);
  });

  it('logs to a stack-created group kept 30 days and deleted with the stack', () => {
    const logGroupId = logicalIdOf(stacks.detection, 'AWS::Logs::LogGroup');
    expect(detectFunction().properties.LoggingConfig.LogGroup).toEqual({ Ref: logGroupId });
    expectTemplate(() =>
      stacks.detection.hasResource('AWS::Logs::LogGroup', {
        Properties: { RetentionInDays: 30 },
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      }),
    );
  });

  it('lets only lambda.amazonaws.com assume the role, with no managed policy', () => {
    const [role] = Object.values(resourcesOfType(stacks.detection, 'AWS::IAM::Role'));
    expect(role?.Properties?.ManagedPolicyArns).toBeUndefined();
    expect(role?.Properties?.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    });
  });

  it('grants the role exactly its table, SES read, invoke and log actions', () => {
    expect(Object.keys(grantsOfDetectRole()).sort().join(',')).toBe(
      'bedrock-agentcore:InvokeAgentRuntime,dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSetEventDestinations,ses:GetEmailIdentity,ses:ListConfigurationSets,ses:ListEmailIdentities',
    );
  });

  it('grants each action on exactly its resources', () => {
    const grants = grantsOfDetectRole();
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']) {
      expect(grants[action]).toHaveLength(1);
      expect(grants[action]?.[0]).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:[^"]*EventStore[^"]*Arn[^"]*"\}$/);
    }
    expect(grants['ses:ListEmailIdentities']).toEqual(['"*"']);
    expect(grants['ses:ListConfigurationSets']).toEqual(['"*"']);
    expect(grants['ses:GetEmailIdentity']).toEqual([
      JSON.stringify({ 'Fn::Join': ['', ['arn:aws:ses:eu-central-1:', { Ref: 'AWS::AccountId' }, ':identity/*']] }),
    ]);
    expect(grants['ses:GetConfigurationSetEventDestinations']).toEqual(
      stacks.laneMap.lanes
        .map((lane) => JSON.stringify({ 'Fn::Join': ['', ['arn:aws:ses:eu-central-1:', { Ref: 'AWS::AccountId' }, `:configuration-set/${lane.configurationSet}`]] }))
        .sort(),
    );
    const invoke = grants['bedrock-agentcore:InvokeAgentRuntime'] ?? [];
    expect(invoke).toHaveLength(2);
    const runtimeArn = invoke.find((resource) => resource.startsWith('{"Fn::ImportValue"'));
    expect(runtimeArn).toMatch(/^\{"Fn::ImportValue":"FotheringRuntime:[^"]*"\}$/);
    expect(invoke).toContain(JSON.stringify({ 'Fn::Join': ['', [JSON.parse(runtimeArn ?? 'null'), '/*']] }));
    const logGroupId = logicalIdOf(stacks.detection, 'AWS::Logs::LogGroup');
    expect(grants['logs:PutLogEvents']).toEqual(grants['logs:CreateLogStream']);
    expect(grants['logs:PutLogEvents']?.[0]).toContain(`"Ref":"${logGroupId}"`);
    expect(grants['logs:PutLogEvents']?.[0]).toContain(':log-stream:*');
  });

  it('never grants a scan, a delete, a transaction of its own or an SES write', () => {
    const actions = Object.keys(grantsOfDetectRole());
    for (const action of actions) expect(action).not.toMatch(/^dynamodb:(Scan|DeleteItem|BatchWriteItem|TransactWriteItems)$/);
    for (const action of actions) expect(action).not.toMatch(/^ses:(Put|Update|Send|Create|Delete)/);
    expect(actions).not.toContain('bedrock-agentcore:InvokeAgentRuntimeForUser');
  });

  it('holds no AgentCore Memory resource in any of the three templates', () => {
    for (const template of [stacks.ingest, stacks.runtime, stacks.detection]) {
      expect(Object.keys(resourcesOfType(template, 'AWS::BedrockAgentCore::Memory'))).toEqual([]);
    }
  });
});

describe('the detection function carries the switch only from the context key', () => {
  it('holds no live value in a default synth', { timeout: 60_000 }, () => {
    expect(detectionVariables({})[LIVE_SWITCH]).toBeUndefined();
  });

  it('carries live when the context key is live', { timeout: 60_000 }, () => {
    expect(detectionVariables({ 'fothering:live': 'live' })[LIVE_SWITCH]).toBe('live');
  });
});
