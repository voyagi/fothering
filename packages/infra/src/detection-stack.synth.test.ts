import { App } from 'aws-cdk-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLaneMap } from '@fothering/core/lanes';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { DETECT_FUNCTION_TIMEOUT_MS } from '@fothering/core/model-values';
import lanesJson from '../../../lanes.json' with { type: 'json' };
import { ACCOUNT_SENDING_ACTIONS, applyAccountSendingDeny } from './account-deny.js';
import { ActionStack } from './action-stack.js';
import { cdkJsonContext } from './cdk-context.js';
import { ACTION_STACK_ID, DETECTION_STACK_ID, INGEST_STACK_ID, RUNTIME_STACK_ID } from './create-app.js';
import { DetectionStack } from './detection-stack.js';
import { IngestStack } from './ingest-stack.js';
import {
  collectPermissions,
  serializePermissions,
  synthesizePermissionTemplates,
  type CfnTemplate,
  type PermissionEntry,
  type StackTemplates,
} from './permissions.js';
import { RuntimeStack } from './runtime-stack.js';
import { createStubAssets } from './stub-assets.js';
import {
  denyViolations,
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
    // The same constant detection reads as a cycle's longest life, so the two cannot drift apart.
    expect(properties.Timeout).toBe(DETECT_FUNCTION_TIMEOUT_MS / 1000);
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

  it('alarms on a function error and on any error-level line, acting on nothing', () => {
    stacks.detection.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    stacks.detection.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: detectFunction().logicalId } }],
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
    stacks.detection.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.level = "error" }',
      MetricTransformations: [{ MetricNamespace: 'Fothering', MetricName: 'DetectErrorLines', MetricValue: '1' }],
    });
    stacks.detection.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'Fothering', MetricName: 'DetectErrorLines', Threshold: 1 });
    for (const alarm of Object.values(resourcesOfType(stacks.detection, 'AWS::CloudWatch::Alarm'))) {
      expect(alarm.Properties?.AlarmActions).toBeUndefined();
      expect(alarm.Properties?.OKActions).toBeUndefined();
    }
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

function configurationSetArn(name: string): Record<string, unknown> {
  return { 'Fn::Join': ['', ['arn:aws:ses:eu-central-1:', { Ref: 'AWS::AccountId' }, `:configuration-set/${name}`]] };
}

const PAUSE_ACTION = 'ses:PutConfigurationSetSendingOptions';

function pauseEntry(stack: string, role: string, name: string): PermissionEntry {
  return {
    stack,
    role,
    kind: 'permission',
    effect: 'Allow',
    action: PAUSE_ACTION,
    resource: JSON.stringify(configurationSetArn(name)),
    principal: null,
    condition: null,
  };
}

function includesEnding(violations: readonly string[], ending: string): boolean {
  return violations.some((violation) => violation.endsWith(ending));
}

describe('the permission boundaries, with every wildcard expanded', () => {
  const laneMap = parseLaneMap(lanesJson);
  let templates: StackTemplates;
  beforeAll(() => {
    templates = synthesizePermissionTemplates();
  }, 60_000);

  const violationsOf = (planted: StackTemplates) => permissionViolations(collectPermissions(planted), laneMap);

  it('finds no violation in the four synthesized stacks, which hold the detection grants and the pause', () => {
    const entries = collectPermissions(templates);
    expect(entries.some((entry) => entry.stack === DETECTION_STACK_ID && entry.action === 'bedrock-agentcore:InvokeAgentRuntime')).toBe(true);
    expect(entries.some((entry) => entry.stack === ACTION_STACK_ID && entry.effect === 'Allow' && entry.action === PAUSE_ACTION)).toBe(true);
    expect(permissionViolations(entries, laneMap)).toEqual([]);
    expect(denyViolations(entries)).toEqual([]);
  });

  it('reports a dynamodb:* grant planted on the runtime role', () => {
    const violations = violationsOf(plantOn(templates, RUNTIME_STACK_ID, 'RuntimeRole', { Effect: 'Allow', Action: 'dynamodb:*', Resource: '*' }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^FotheringRuntime\/RuntimeRole\w+ dynamodb:\*: the runtime role reaches dynamodb$/);
  });

  it('reports an InvokeAgentRuntime grant planted on the ingest role', () => {
    const violations = violationsOf(
      plantOn(templates, INGEST_STACK_ID, 'IngestRole', { Effect: 'Allow', Action: 'bedrock-agentcore:InvokeAgentRuntime', Resource: '*' }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^FotheringIngest\/IngestRole\w+ bedrock-agentcore:InvokeAgentRuntime: only the detection role may invoke the runtime$/);
  });

  it('reports a * grant planted on the runtime role as reaching ses, dynamodb and s3, account-level sending and the pause beside a model action', () => {
    const violations = violationsOf(plantOn(templates, RUNTIME_STACK_ID, 'RuntimeRole', { Effect: 'Allow', Action: '*', Resource: '*' }));
    for (const service of ['ses', 'dynamodb', 's3']) expect(includesEnding(violations, `: the runtime role reaches ${service}`)).toBe(true);
    for (const action of ACCOUNT_SENDING_ACTIONS) expect(includesEnding(violations, `: no role may hold ${action}`)).toBe(true);
    expect(includesEnding(violations, `: only a pausing role may hold ${PAUSE_ACTION}`)).toBe(true);
    expect(includesEnding(violations, `: holds ${PAUSE_ACTION} beside a bedrock or bedrock-agentcore action`)).toBe(true);
  });

  it('reports ses:* planted on the ingest role as the three account-level actions and the pause', () => {
    const violations = violationsOf(plantOn(templates, INGEST_STACK_ID, 'IngestRole', { Effect: 'Allow', Action: 'ses:*', Resource: '*' }));
    for (const action of ACCOUNT_SENDING_ACTIONS) expect(includesEnding(violations, `ses:*: no role may hold ${action}`)).toBe(true);
    expect(includesEnding(violations, `ses:*: only a pausing role may hold ${PAUSE_ACTION}`)).toBe(true);
  });

  it('reports ses:Put* planted on the action role over fothering-transactional as a pause outside the closeable set', () => {
    const violations = violationsOf(
      plantOn(templates, ACTION_STACK_ID, 'ActionRole', { Effect: 'Allow', Action: 'ses:Put*', Resource: configurationSetArn('fothering-transactional') }),
    );
    expect(includesEnding(violations, `ses:Put*: ${PAUSE_ACTION} reaches a configuration set outside the statically closeable lanes`)).toBe(true);
    expect(violations.some((violation) => violation.startsWith('FotheringAction/ActionRole') && violation.includes(': only a pausing role'))).toBe(false);
  });

  it('reports ses:Update* planted on the action role as the two v1 actions', () => {
    const violations = violationsOf(plantOn(templates, ACTION_STACK_ID, 'ActionRole', { Effect: 'Allow', Action: 'ses:Update*', Resource: '*' }));
    expect(violations.filter((violation) => violation.includes(': no role may hold ses:Update')).sort()).toEqual(
      ['ses:UpdateAccountSendingEnabled', 'ses:UpdateConfigurationSetSendingEnabled'].map((action) => expect.stringContaining(`ses:Update*: no role may hold ${action}`)),
    );
  });

  it('reports * planted on the action role as the account-level actions and the pause beside a model action', () => {
    const violations = violationsOf(plantOn(templates, ACTION_STACK_ID, 'ActionRole', { Effect: 'Allow', Action: '*', Resource: '*' }));
    for (const action of ACCOUNT_SENDING_ACTIONS) expect(includesEnding(violations, `*: no role may hold ${action}`)).toBe(true);
    expect(includesEnding(violations, `: holds ${PAUSE_ACTION} beside a bedrock or bedrock-agentcore action`)).toBe(true);
  });

  it('reports bedrock:InvokeModel planted on the action role as the pause beside a model action, and nothing else', () => {
    const violations = violationsOf(plantOn(templates, ACTION_STACK_ID, 'ActionRole', { Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: '*' }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^FotheringAction\/ActionRole\w+: holds ses:PutConfigurationSetSendingOptions beside a bedrock or bedrock-agentcore action$/);
  });

  it('allows the pause on fothering-bulk to a reopen role in the action stack, and to no reopen role anywhere else', () => {
    const entries = collectPermissions(templates);
    expect(permissionViolations([...entries, pauseEntry(ACTION_STACK_ID, 'ReopenRole12345678', 'fothering-bulk')], laneMap)).toEqual([]);
    expect(permissionViolations([...entries, pauseEntry(DETECTION_STACK_ID, 'ReopenRole12345678', 'fothering-bulk')], laneMap)).toEqual([
      `FotheringDetection/ReopenRole12345678 ${PAUSE_ACTION}: only a pausing role may hold ${PAUSE_ACTION}`,
    ]);
  });

  it('reports a role whose account-level Deny entries were removed', () => {
    const entries = collectPermissions(templates);
    const ingestRole = entries.find((entry) => entry.stack === INGEST_STACK_ID && entry.kind === 'trust' && entry.role.startsWith('IngestRole'))?.role;
    const stripped = entries.filter((entry) => !(entry.role === ingestRole && entry.effect === 'Deny'));
    expect(entries.length - stripped.length).toBe(ACCOUNT_SENDING_ACTIONS.length);
    expect(denyViolations(stripped)).toEqual(ACCOUNT_SENDING_ACTIONS.map((action) => `FotheringIngest/${ingestRole}: no Deny on * for ${action}`));
  });

  it('serializes two syntheses to byte-identical snapshots', { timeout: 60_000 }, () => {
    const again = serializePermissions(collectPermissions(synthesizePermissionTemplates()));
    expect(again).toBe(serializePermissions(collectPermissions(templates)));
  });

  it('collects the same permissions when the four stacks are created in another order', { timeout: 60_000 }, () => {
    const assets = createStubAssets();
    try {
      const env = { region: 'eu-central-1' };
      const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
      const runtime = new RuntimeStack(app, RUNTIME_STACK_ID, { env, agentAssetDir: assets.agentAssetDir });
      const ingest = new IngestStack(app, INGEST_STACK_ID, { env, laneMap, ingestAssetDir: assets.ingestAssetDir, forgetAssetDir: assets.forgetAssetDir });
      new ActionStack(app, ACTION_STACK_ID, { env, laneMap, actionAssetDir: assets.ingestAssetDir, reopenAssetDir: assets.forgetAssetDir, ingest });
      new DetectionStack(app, DETECTION_STACK_ID, { env, laneMap, detectAssetDir: assets.ingestAssetDir, table: ingest.table, runtime: runtime.runtime });
      applyAccountSendingDeny(app);
      const assembly = app.synth();
      const reordered = Object.fromEntries(
        [INGEST_STACK_ID, RUNTIME_STACK_ID, DETECTION_STACK_ID, ACTION_STACK_ID].map((id) => [id, assembly.getStackByName(id).template as CfnTemplate]),
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
