import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENTCORE_RUNTIME } from '@fothering/agent/listen-host';
import { cdkJsonContext } from './cdk-context.js';
import { RUNTIME_STACK_ID } from './create-app.js';
import { RuntimeStack } from './runtime-stack.js';
import { createStubAssets } from './stub-assets.js';
import { expectTemplate, fixedNames, logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

interface PolicyStatementJson {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

// Spelled out here rather than built from model-values.ts, so the test stays an oracle independent of
// the code it checks.
const PROFILE_ARN = { 'Fn::Join': ['', ['arn:aws:bedrock:eu-central-1:', { Ref: 'AWS::AccountId' }, ':inference-profile/eu.anthropic.claude-sonnet-5']] };
const FOUNDATION_MODEL_ARNS = ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'].map(
  (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-5`,
);

describe('RuntimeStack synth', () => {
  let stacks: SynthesizedStacks;
  beforeAll(() => {
    stacks = synthStacks();
  }, 60_000);
  afterAll(() => stacks.dispose());

  function runtimeProperties(): Record<string, unknown> {
    const [runtime] = Object.values(resourcesOfType(stacks.runtime, 'AWS::BedrockAgentCore::Runtime'));
    return runtime?.Properties ?? {};
  }

  function policyStatements(): PolicyStatementJson[] {
    return Object.values(resourcesOfType(stacks.runtime, 'AWS::IAM::Policy')).flatMap(
      (policy) => (policy.Properties as { PolicyDocument: { Statement: PolicyStatementJson[] } }).PolicyDocument.Statement,
    );
  }

  it('deploys the code asset on NODE_22 with main.js as its entry point', () => {
    stacks.runtime.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    const artifact = runtimeProperties().AgentRuntimeArtifact as { CodeConfiguration: { Code: { S3: Record<string, unknown> }; EntryPoint: string[]; Runtime: string } };
    expect(artifact.CodeConfiguration.EntryPoint).toEqual(['main.js']);
    expect(artifact.CodeConfiguration.Runtime).toBe('NODE_22');
    // A code location must exist, or the no-S3-action assertions below would hold for an empty reason.
    expect(artifact.CodeConfiguration.Code.S3.Bucket).toBeDefined();
    expect(artifact.CodeConfiguration.Code.S3.Prefix).toBeDefined();
  });

  it('always carries the marker that opens the listener for the runtime, and no other variable by default', () => {
    expect(AGENTCORE_RUNTIME).toBe('agentcore');
    expect(runtimeProperties().EnvironmentVariables).toEqual({ FOTHERING_DEPLOYED_RUNTIME: AGENTCORE_RUNTIME });
  });

  it('runs under one role that only bedrock-agentcore.amazonaws.com, acting for this account and Region, can assume', () => {
    const roleId = logicalIdOf(stacks.runtime, 'AWS::IAM::Role');
    expect(runtimeProperties().RoleArn).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    const [role] = Object.values(resourcesOfType(stacks.runtime, 'AWS::IAM::Role'));
    expect(role?.Properties?.ManagedPolicyArns).toBeUndefined();
    expect(role?.Properties?.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
            ArnLike: { 'aws:SourceArn': { 'Fn::Join': ['', ['arn:aws:bedrock-agentcore:eu-central-1:', { Ref: 'AWS::AccountId' }, ':*']] } },
          },
        },
      ],
    });
  });

  it('gives the role its own log group and model invocation and nothing else, so it holds no s3, ses or dynamodb action', () => {
    const roleId = logicalIdOf(stacks.runtime, 'AWS::IAM::Role');
    const statements = statementsByRole(stacks.runtime)[roleId] ?? [];
    const actions = statements.flatMap((statement) => statement.actions).sort();
    expect([...new Set(actions)].join(',')).toBe('bedrock:InvokeModel,logs:CreateLogStream,logs:DescribeLogGroups,logs:DescribeLogStreams,logs:PutLogEvents');
    for (const action of actions) expect(action).not.toMatch(/^(s3|ses|dynamodb):/);
    const logGroupId = logicalIdOf(stacks.runtime, 'AWS::Logs::LogGroup');
    const streams = statements.find((s) => s.actions.includes('logs:PutLogEvents'));
    const group = statements.find((s) => s.actions.includes('logs:DescribeLogStreams'));
    const everyGroup = statements.find((s) => s.actions.includes('logs:DescribeLogGroups'));
    expect(JSON.stringify(streams?.resources)).toContain(`"Ref":"${logGroupId}"`);
    expect(JSON.stringify(streams?.resources)).toContain(':log-stream:*');
    expect(JSON.stringify(group?.resources)).toContain(`"Ref":"${logGroupId}"`);
    expect(JSON.stringify(group?.resources)).not.toContain('log-stream');
    expect(JSON.stringify(everyGroup?.resources)).toContain(':log-group:*');
    for (const statement of statements) expect(statement.effect).toBe('Allow');
  });

  it('invokes only the EU Claude Sonnet 5 profile, and its foundation model in the six destination Regions only through that profile', () => {
    const modelStatements = policyStatements().filter((statement) => [statement.Action].flat().includes('bedrock:InvokeModel'));
    expect(modelStatements).toHaveLength(2);
    for (const statement of modelStatements) {
      expect(statement.Effect).toBe('Allow');
      expect(statement.Action).toBe('bedrock:InvokeModel');
    }
    const profile = modelStatements.find((statement) => statement.Condition === undefined);
    expect(profile?.Resource).toEqual(PROFILE_ARN);
    const models = modelStatements.find((statement) => statement.Condition !== undefined);
    expect([models?.Resource].flat()).toEqual(FOUNDATION_MODEL_ARNS);
    expect(models?.Condition).toEqual({ StringEquals: { 'bedrock:InferenceProfileArn': PROFILE_ARN } });
  });

  it('never grants streaming invocation, a global profile or every model', () => {
    const text = JSON.stringify(policyStatements());
    expect(text).not.toContain('InvokeModelWithResponseStream');
    expect(text).not.toContain('global.');
    expect(text).not.toMatch(/foundation-model\/\*|inference-profile\/\*/);
  });

  it('creates the runtime log group under the name AgentCore writes to, kept 30 days and deleted with the stack', () => {
    const runtimeId = logicalIdOf(stacks.runtime, 'AWS::BedrockAgentCore::Runtime');
    expect(Object.keys(resourcesOfType(stacks.runtime, 'AWS::Logs::LogGroup'))).toHaveLength(1);
    expectTemplate(() =>
      stacks.runtime.hasResource('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: { 'Fn::Join': ['', ['/aws/bedrock-agentcore/runtimes/', { 'Fn::GetAtt': [runtimeId, 'AgentRuntimeId'] }, '-DEFAULT']] },
          RetentionInDays: 30,
        },
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      }),
    );
  });

  it('holds only the runtime, its role, its log and model policies and its log group', () => {
    const types = Object.values(stacks.runtime.toJSON().Resources as Record<string, { Type: string }>)
      .map((resource) => resource.Type)
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types.join(',')).toBe('AWS::BedrockAgentCore::Runtime,AWS::IAM::Policy,AWS::IAM::Policy,AWS::IAM::Role,AWS::Logs::LogGroup');
  });

  it('names nothing itself: the runtime name is derived by CDK and the log group name is built from the runtime id', () => {
    expect(fixedNames(stacks.runtime).map(({ type, property }) => `${type}.${property}`).sort()).toEqual([
      'AWS::BedrockAgentCore::Runtime.AgentRuntimeName',
      'AWS::Logs::LogGroup.LogGroupName',
    ]);
    expect(runtimeProperties().AgentRuntimeName).toMatch(/^FotheringRuntime[0-9A-F]{8}$/);
  });

  it('waits for nothing that waits for it: neither policy is a dependency of the runtime', () => {
    const [runtime] = Object.values(resourcesOfType(stacks.runtime, 'AWS::BedrockAgentCore::Runtime'));
    const policyIds = Object.keys(resourcesOfType(stacks.runtime, 'AWS::IAM::Policy'));
    expect(policyIds).toHaveLength(2);
    for (const policyId of policyIds) expect(runtime?.DependsOn ?? []).not.toContain(policyId);
  });
});

// The model adapter calls Bedrock in the profile's source Region whatever Region the stack deploys
// to, so the profile grant must name that Region too, or the first call is refused.
describe('RuntimeStack synth in another Region', () => {
  it('grants the profile in the Region the model adapter calls, not the stack Region', { timeout: 60_000 }, () => {
    const assets = createStubAssets();
    try {
      const app = new App({ context: { ...cdkJsonContext }, outdir: assets.outdir });
      const stack = new RuntimeStack(app, RUNTIME_STACK_ID, { env: { region: 'eu-west-1' }, agentAssetDir: assets.agentAssetDir });
      const statements = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')).flatMap(
        (policy) => (policy.Properties as { PolicyDocument: { Statement: PolicyStatementJson[] } }).PolicyDocument.Statement,
      );
      const profile = statements.find((statement) => statement.Action === 'bedrock:InvokeModel' && statement.Condition === undefined);
      expect(profile?.Resource).toEqual(PROFILE_ARN);
    } finally {
      assets.remove();
    }
  });
});
