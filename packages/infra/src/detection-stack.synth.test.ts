import { App } from 'aws-cdk-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLaneMap } from '@fothering/core/lanes';
import { LIVE_SWITCH } from '@fothering/core/mode';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { cdkJsonContext } from './cdk-context.js';
import { DETECTION_STACK_ID, INGEST_STACK_ID, RUNTIME_STACK_ID } from './create-app.js';
import { DetectionStack } from './detection-stack.js';
import { IngestStack } from './ingest-stack.js';
import { collectPermissions, serializePermissions, synthesizePermissionTemplates, type CfnTemplate, type StackTemplates } from './permissions.js';
import { RuntimeStack } from './runtime-stack.js';
import { createStubAssets } from './stub-assets.js';
import {
  expectTemplate,
  grantsAction,
  logicalIdOf,
  permissionViolations,
  resourcesOfType,
  statementsByRole,
  synthStacks,
  type SynthesizedStacks,
} from './test/synth.js';

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

describe('grantsAction matches an IAM action pattern the way IAM does', () => {
  it.each([
    ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntime', true],
    ['BEDROCK-AGENTCORE:invokeagentruntime', 'bedrock-agentcore:InvokeAgentRuntime', true],
    ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser', false],
    ['bedrock-agentcore:Invoke*', 'bedrock-agentcore:InvokeAgentRuntimeCommandShell', true],
    ['bedrock-agentcore:Invoke?gentRuntime', 'bedrock-agentcore:InvokeAgentRuntime', true],
    ['ses:Put*', 'ses:PutConfigurationSetSendingOptions', true],
    ['dynamodb:Get*', 'dynamodb:PutItem', false],
    ['*', 's3:GetObject', true],
    ['s3:Get.bject', 's3:GetObject', false],
  ])('%s against %s is %s', (granted, probe, expected) => {
    expect(grantsAction(granted, probe)).toBe(expected);
  });
});

// A grant planted into a deep copy of the synthesized templates, on the policy attached to the
// named role, so each boundary is shown to fail on the shape it guards against.
function plantOn(templates: StackTemplates, stack: string, rolePrefix: string, statement: Record<string, unknown>): StackTemplates {
  const planted = JSON.parse(JSON.stringify(templates)) as StackTemplates;
  const policy = Object.values((planted[stack] as CfnTemplate).Resources ?? {}).find(
    (resource) =>
      resource.Type === 'AWS::IAM::Policy' &&
      (resource.Properties?.Roles as Array<{ Ref: string }>).some((role) => role.Ref.startsWith(rolePrefix)),
  );
  if (policy === undefined) throw new Error(`no policy in ${stack} is attached to a ${rolePrefix} role`);
  (policy.Properties?.PolicyDocument as { Statement: unknown[] }).Statement.push(statement);
  return planted;
}

describe('the permission boundaries, with every wildcard expanded', () => {
  let templates: StackTemplates;
  beforeAll(() => {
    templates = synthesizePermissionTemplates();
  }, 60_000);

  it('finds no violation in the three synthesized stacks, which hold the detection grants', () => {
    const entries = collectPermissions(templates);
    expect(entries.some((entry) => entry.stack === DETECTION_STACK_ID && entry.action === 'bedrock-agentcore:InvokeAgentRuntime')).toBe(true);
    expect(permissionViolations(entries)).toEqual([]);
  });

  it('reports a dynamodb:* grant planted on the runtime role', () => {
    const planted = plantOn(templates, RUNTIME_STACK_ID, 'RuntimeRole', { Effect: 'Allow', Action: 'dynamodb:*', Resource: '*' });
    const violations = permissionViolations(collectPermissions(planted));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^FotheringRuntime\/RuntimeRole\w+ dynamodb:\*: the runtime role reaches dynamodb$/);
  });

  it('reports an InvokeAgentRuntime grant planted on the ingest role', () => {
    const planted = plantOn(templates, INGEST_STACK_ID, 'IngestRole', { Effect: 'Allow', Action: 'bedrock-agentcore:InvokeAgentRuntime', Resource: '*' });
    const violations = permissionViolations(collectPermissions(planted));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^FotheringIngest\/IngestRole\w+ bedrock-agentcore:InvokeAgentRuntime: only the detection role may invoke the runtime$/);
  });

  it('reports a * grant planted on the runtime role as reaching ses, dynamodb and s3', () => {
    const planted = plantOn(templates, RUNTIME_STACK_ID, 'RuntimeRole', { Effect: 'Allow', Action: '*', Resource: '*' });
    const violations = permissionViolations(collectPermissions(planted));
    for (const service of ['ses', 'dynamodb', 's3']) {
      expect(violations.some((violation) => violation.endsWith(`: the runtime role reaches ${service}`))).toBe(true);
    }
    expect(violations.some((violation) => violation.endsWith('no role may hold ses:PutConfigurationSetSendingOptions'))).toBe(true);
  });

  it('serializes two syntheses to byte-identical snapshots', { timeout: 60_000 }, () => {
    const again = serializePermissions(collectPermissions(synthesizePermissionTemplates()));
    expect(again).toBe(serializePermissions(collectPermissions(templates)));
  });

  it('collects the same permissions when the runtime stack is created before the ingest stack', { timeout: 60_000 }, () => {
    const assets = createStubAssets();
    try {
      const env = { region: 'eu-central-1' };
      const laneMap = parseLaneMap(lanesJson);
      const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
      const runtime = new RuntimeStack(app, RUNTIME_STACK_ID, { env, agentAssetDir: assets.agentAssetDir });
      const ingest = new IngestStack(app, INGEST_STACK_ID, { env, laneMap, ingestAssetDir: assets.ingestAssetDir, forgetAssetDir: assets.forgetAssetDir });
      new DetectionStack(app, DETECTION_STACK_ID, { env, laneMap, detectAssetDir: assets.ingestAssetDir, table: ingest.table, runtime: runtime.runtime });
      const assembly = app.synth();
      const reordered = Object.fromEntries(
        [INGEST_STACK_ID, RUNTIME_STACK_ID, DETECTION_STACK_ID].map((id) => [id, assembly.getStackByName(id).template as CfnTemplate]),
      );
      expect(serializePermissions(collectPermissions(reordered))).toBe(serializePermissions(collectPermissions(templates)));
    } finally {
      assets.remove();
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
