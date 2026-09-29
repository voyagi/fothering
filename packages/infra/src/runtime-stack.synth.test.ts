import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENTCORE_RUNTIME } from '@fothering/agent/listen-host';
import { expectTemplate, fixedNames, logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

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

  it('gives the role its own log group and no other permission, so it holds no s3, ses, dynamodb or model action', () => {
    const roleId = logicalIdOf(stacks.runtime, 'AWS::IAM::Role');
    const statements = statementsByRole(stacks.runtime)[roleId] ?? [];
    const actions = statements.flatMap((statement) => statement.actions).sort();
    expect(actions).toEqual(['logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents']);
    for (const action of actions) expect(action).not.toMatch(/^(s3|ses|dynamodb|bedrock):/);
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

  it('holds only the runtime, its role and policy and its log group', () => {
    const types = Object.values(stacks.runtime.toJSON().Resources as Record<string, { Type: string }>)
      .map((resource) => resource.Type)
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual(['AWS::BedrockAgentCore::Runtime', 'AWS::IAM::Policy', 'AWS::IAM::Role', 'AWS::Logs::LogGroup']);
  });

  it('names nothing itself: the runtime name is derived by CDK and the log group name is built from the runtime id', () => {
    expect(fixedNames(stacks.runtime).map(({ type, property }) => `${type}.${property}`).sort()).toEqual([
      'AWS::BedrockAgentCore::Runtime.AgentRuntimeName',
      'AWS::Logs::LogGroup.LogGroupName',
    ]);
    expect(runtimeProperties().AgentRuntimeName).toMatch(/^FotheringRuntime[0-9A-F]{8}$/);
  });

  it('waits for nothing that waits for it: the policy naming the log group is not a dependency of the runtime', () => {
    const [runtime] = Object.values(resourcesOfType(stacks.runtime, 'AWS::BedrockAgentCore::Runtime'));
    const policyId = logicalIdOf(stacks.runtime, 'AWS::IAM::Policy');
    expect(runtime?.DependsOn ?? []).not.toContain(policyId);
  });
});
