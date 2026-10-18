import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_FUNCTION_TIMEOUT_MS } from '@fothering/core/close-values';
import { LIVE_SWITCH } from '@fothering/core/mode';
import { logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

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

  it('reads the table name from the ingest stack and nothing else in a default synth', () => {
    const variables = actionFunction().properties.Environment.Variables;
    expect(Object.keys(variables).join(',')).toBe('FOTHERING_TABLE_NAME');
    expect(JSON.stringify(variables.FOTHERING_TABLE_NAME)).toMatch(/^\{"Fn::ImportValue":"FotheringIngest:/);
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
