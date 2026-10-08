import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTITION_KEY, RECIPIENT_INDEX_NAME, RECIPIENT_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import { expectTemplate, fixedNames, logicalIdOf, resourcesOfType, statementsByRole, synthStacks, type SynthesizedStacks } from './test/synth.js';

const SES_DETAIL_TYPES = [
  'Email Sent',
  'Email Delivered',
  'Email Bounced',
  'Email Complaint Received',
  'Email Rejected',
  'Email Delivery Delayed',
];

const LOG_ACTIONS = ['logs:CreateLogStream', 'logs:PutLogEvents'];

interface FunctionProperties {
  Runtime: string;
  Architectures: string[];
  Handler: string;
  Timeout: number;
  MemorySize: number;
  Role: { 'Fn::GetAtt': [string, string] };
  Environment: { Variables: Record<string, unknown> };
  LoggingConfig: { LogGroup: { Ref: string } };
  DeadLetterConfig?: unknown;
}

// A synth loads aws-cdk-lib whole and hashes an asset: 3.3 s alone, and 6.3 s once under a full
// parallel suite, past vitest's default hook limit. Every limit here is explicit so load cannot fail it.
describe('IngestStack synth', () => {
  let stacks: SynthesizedStacks;
  beforeAll(() => {
    stacks = synthStacks();
  }, 60_000);
  afterAll(() => stacks.dispose());

  function functionByEnvironment(variable: string): { logicalId: string; properties: FunctionProperties } {
    const matches = Object.entries(resourcesOfType(stacks.ingest, 'AWS::Lambda::Function')).filter(
      ([, resource]) => (resource.Properties as unknown as FunctionProperties).Environment.Variables[variable] !== undefined,
    );
    const [only] = matches;
    if (matches.length !== 1 || only === undefined) throw new Error(`expected exactly one function reading ${variable}, found ${matches.length}`);
    return { logicalId: only[0], properties: only[1].Properties as unknown as FunctionProperties };
  }
  const ingestFunction = (): ReturnType<typeof functionByEnvironment> => functionByEnvironment('FOTHERING_DLQ_URL');
  // The stack holds exactly two functions (asserted below), so the forget function is the other one.
  const forgetFunction = (): ReturnType<typeof functionByEnvironment> => {
    const ids = Object.keys(resourcesOfType(stacks.ingest, 'AWS::Lambda::Function')).filter((id) => id !== ingestFunction().logicalId);
    const [only] = ids;
    if (ids.length !== 1 || only === undefined) throw new Error('expected exactly one function beside the ingest function');
    return { logicalId: only, properties: resourcesOfType(stacks.ingest, 'AWS::Lambda::Function')[only]?.Properties as unknown as FunctionProperties };
  };

  it('routes the six SES detail-types of exactly the mapped configuration sets to one target with no dead-letter queue', { timeout: 30_000 }, () => {
    stacks.ingest.resourceCountIs('AWS::Events::Rule', 1);
    const [rule] = Object.values(resourcesOfType(stacks.ingest, 'AWS::Events::Rule'));
    const pattern = rule?.Properties?.EventPattern as Record<string, unknown>;
    expect(pattern.source).toEqual(['aws.ses']);
    expect(pattern['detail-type']).toEqual(SES_DETAIL_TYPES);
    const detail = pattern.detail as { mail: { tags: Record<string, string[]> } };
    expect(detail.mail.tags['ses:configuration-set']).toEqual(stacks.laneMap.lanes.map((lane) => lane.configurationSet));
    const targets = rule?.Properties?.Targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.DeadLetterConfig).toBeUndefined();
    expect(targets[0]?.Arn).toEqual({ 'Fn::GetAtt': [ingestFunction().logicalId, 'Arn'] });
  });

  it('lets only this stack rule invoke the ingest function', () => {
    const [permission] = Object.values(resourcesOfType(stacks.ingest, 'AWS::Lambda::Permission'));
    expect(permission?.Properties).toEqual({
      Action: 'lambda:InvokeFunction',
      FunctionName: { 'Fn::GetAtt': [ingestFunction().logicalId, 'Arn'] },
      Principal: 'events.amazonaws.com',
      SourceArn: { 'Fn::GetAtt': [logicalIdOf(stacks.ingest, 'AWS::Events::Rule'), 'Arn'] },
    });
    stacks.ingest.resourceCountIs('AWS::Lambda::Permission', 1);
  });

  it('runs both functions on nodejs22.x arm64 with explicit limits, never the 3 s and 128 MB defaults', () => {
    for (const { properties } of [ingestFunction(), forgetFunction()]) {
      expect(properties.Runtime).toBe('nodejs22.x');
      expect(properties.Architectures).toEqual(['arm64']);
      expect(properties.Handler).toBe('index.handler');
    }
    expect(ingestFunction().properties).toMatchObject({ Timeout: 30, MemorySize: 512 });
    // 5 minutes: the delete loop's worst case is worked out beside the function in ingest-stack.ts.
    expect(forgetFunction().properties).toMatchObject({ Timeout: 300, MemorySize: 256 });
  });

  it('gives each function exactly the environment its composition root reads', () => {
    const table = { Ref: logicalIdOf(stacks.ingest, 'AWS::DynamoDB::Table') };
    const secret = { Ref: logicalIdOf(stacks.ingest, 'AWS::SecretsManager::Secret') };
    expect(ingestFunction().properties.Environment.Variables).toEqual({
      FOTHERING_TABLE_NAME: table,
      FOTHERING_DLQ_URL: { Ref: logicalIdOf(stacks.ingest, 'AWS::SQS::Queue') },
      FOTHERING_ADDRESS_KEY_SECRET_ID: secret,
    });
    expect(forgetFunction().properties.Environment.Variables).toEqual({
      FOTHERING_TABLE_NAME: table,
      FOTHERING_ADDRESS_KEY_SECRET_ID: secret,
    });
  });

  it('retries a failed event twice within 6 hours and names no failure destination or dead-letter queue', () => {
    stacks.ingest.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
    const [config] = Object.values(resourcesOfType(stacks.ingest, 'AWS::Lambda::EventInvokeConfig'));
    expect(config?.Properties).toEqual({
      FunctionName: { Ref: ingestFunction().logicalId },
      MaximumEventAgeInSeconds: 21_600,
      MaximumRetryAttempts: 2,
      Qualifier: '$LATEST',
    });
    for (const resource of Object.values(resourcesOfType(stacks.ingest, 'AWS::Lambda::Function'))) {
      expect((resource.Properties as unknown as FunctionProperties).DeadLetterConfig).toBeUndefined();
    }
  });

  it('keeps events in one on-demand table with a TTL and a keys-only recipient index, deleted with the stack', () => {
    expectTemplate(() =>
      stacks.ingest.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: PARTITION_KEY, KeyType: 'HASH' },
          { AttributeName: SORT_KEY, KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
        GlobalSecondaryIndexes: [
          {
            IndexName: RECIPIENT_INDEX_NAME,
            KeySchema: [
              { AttributeName: RECIPIENT_KEY, KeyType: 'HASH' },
              { AttributeName: SORT_KEY, KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      }),
    );
    expectTemplate(() => stacks.ingest.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' }));
    expect(Object.keys(resourcesOfType(stacks.ingest, 'AWS::DynamoDB::Table'))).toHaveLength(1);
  });

  it('queues minimized records encrypted with the SQS-managed key for 4 days, deleted with the stack, with no redrive', () => {
    stacks.ingest.resourceCountIs('AWS::SQS::Queue', 1);
    stacks.ingest.hasResource('AWS::SQS::Queue', {
      Properties: { SqsManagedSseEnabled: true, MessageRetentionPeriod: 345_600 },
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    const [queue] = Object.values(resourcesOfType(stacks.ingest, 'AWS::SQS::Queue'));
    expect(queue?.Properties?.RedrivePolicy).toBeUndefined();
  });

  function alarmProperties(metricName: string): Record<string, unknown> | undefined {
    return Object.values(resourcesOfType(stacks.ingest, 'AWS::CloudWatch::Alarm'))
      .map((alarm) => alarm.Properties)
      .find((properties) => properties?.MetricName === metricName);
  }

  // Compared whole, so a name, an action or any extra setting on the alarm fails the comparison too.
  it('alarms on any visible message in the queue over one 5-minute period, with no alarm action', () => {
    const queueId = logicalIdOf(stacks.ingest, 'AWS::SQS::Queue');
    expect(alarmProperties('ApproximateNumberOfMessagesVisible')).toEqual({
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [queueId, 'QueueName'] } }],
      Statistic: 'Maximum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('alarms on any ingest error in a 5-minute period, because Lambda drops a failed event with no record', () => {
    expect(alarmProperties('Errors')).toEqual({
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: ingestFunction().logicalId } }],
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  // Lambda counts a throttled request as neither an invocation nor an error, so an event that
  // expires in the asynchronous queue never reaches the errors alarm; this metric counts every event
  // Lambda drops, whatever the reason.
  it('alarms on any ingest event Lambda drops in a 5-minute period, since a throttled event that expires is no error', () => {
    expect(alarmProperties('AsyncEventsDropped')).toEqual({
      Namespace: 'AWS/Lambda',
      MetricName: 'AsyncEventsDropped',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: ingestFunction().logicalId } }],
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('holds exactly three alarms and none of them acts on anything', () => {
    stacks.ingest.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    for (const alarm of Object.values(resourcesOfType(stacks.ingest, 'AWS::CloudWatch::Alarm'))) {
      expect(alarm.Properties?.AlarmActions).toBeUndefined();
      expect(alarm.Properties?.OKActions).toBeUndefined();
      expect(alarm.Properties?.InsufficientDataActions).toBeUndefined();
    }
  });

  // CloudFormation's Delete policy removes a secret with no recovery window: its DeletionPolicy
  // page says "The default behavior of CloudFormation is to delete the secret with the
  // ForceDeleteWithoutRecovery flag." The AWS::SecretsManager::Secret page states no other rule.
  it('generates the address key from the versioned template and deletes it with the stack', () => {
    expect(Object.keys(resourcesOfType(stacks.ingest, 'AWS::SecretsManager::Secret'))).toHaveLength(1);
    expectTemplate(() =>
      stacks.ingest.hasResource('AWS::SecretsManager::Secret', {
        Properties: {
          GenerateSecretString: {
            SecretStringTemplate: '{"current":"k1","activeFrom":{"k1":0}}',
            GenerateStringKey: 'k1',
            PasswordLength: 64,
            ExcludePunctuation: true,
            IncludeSpace: false,
          },
        },
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      }),
    );
  });

  // The AWS::SecretsManager::Secret page says "Updating the GenerateSecretString property triggers
  // the creation of a new secret version." After a hand rotation the secret holds k2 and a moved
  // current, so any change to this block, an added setting included, would make the next deploy write
  // a fresh k1-only value over it and leave every stored hash under a key that no longer exists.
  // Compared whole with toEqual, since the matcher above lets an added key through.
  it('pins the address key generation settings exactly, so no deploy after the first replaces the key', () => {
    const [secret] = Object.values(resourcesOfType(stacks.ingest, 'AWS::SecretsManager::Secret'));
    expect(secret?.Properties?.GenerateSecretString).toEqual({
      SecretStringTemplate: '{"current":"k1","activeFrom":{"k1":0}}',
      GenerateStringKey: 'k1',
      PasswordLength: 64,
      ExcludePunctuation: true,
      IncludeSpace: false,
    });
  });

  it('creates one 30-day log group per function, deleted with the stack, and points each function at its own', () => {
    stacks.ingest.resourceCountIs('AWS::Logs::LogGroup', 2);
    stacks.ingest.hasResource('AWS::Logs::LogGroup', { Properties: { RetentionInDays: 30 }, DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    const groups = Object.entries(resourcesOfType(stacks.ingest, 'AWS::Logs::LogGroup'));
    for (const [, group] of groups) expect(group.Properties).toEqual({ RetentionInDays: 30 });
    const used = [ingestFunction(), forgetFunction()].map(({ properties }) => properties.LoggingConfig.LogGroup.Ref);
    expect(new Set(used).size).toBe(2);
    expect([...used].sort()).toEqual(groups.map(([id]) => id).sort());
    expect(Object.keys(resourcesOfType(stacks.ingest, 'AWS::Lambda::Function'))).toHaveLength(2);
  });

  it('outputs the forget function name and nothing else', () => {
    expect(stacks.ingest.toJSON().Outputs).toEqual({ ForgetFunctionName: { Value: { Ref: forgetFunction().logicalId } } });
  });

  it('holds only the resources the deploy page lists, and no custom resource', () => {
    const types = Object.values(stacks.ingest.toJSON().Resources as Record<string, { Type: string }>)
      .map((resource) => resource.Type)
      .filter((type) => type !== 'AWS::CDK::Metadata')
      .sort();
    expect(types).toEqual([
      'AWS::CloudWatch::Alarm',
      'AWS::CloudWatch::Alarm',
      'AWS::CloudWatch::Alarm',
      'AWS::DynamoDB::Table',
      'AWS::Events::Rule',
      'AWS::IAM::Policy',
      'AWS::IAM::Policy',
      'AWS::IAM::Role',
      'AWS::IAM::Role',
      'AWS::Lambda::EventInvokeConfig',
      'AWS::Lambda::Function',
      'AWS::Lambda::Function',
      'AWS::Lambda::Permission',
      'AWS::Logs::LogGroup',
      'AWS::Logs::LogGroup',
      'AWS::SQS::Queue',
      'AWS::SecretsManager::Secret',
    ]);
  });

  it('sets no physical name on any resource', () => {
    expect(fixedNames(stacks.ingest)).toEqual([]);
  });

  it('the name check finds a planted fixed name and lets a bare reference through', () => {
    const planted = Template.fromJSON({
      Resources: {
        Named: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'fixed' } },
        Pointer: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Named' } } },
        Built: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: { 'Fn::Join': ['', ['/x/', { Ref: 'Named' }]] } } },
      },
    });
    expect(fixedNames(planted).map(({ logicalId }) => logicalId)).toEqual(['Named', 'Built']);
  });

  describe('the function roles', () => {
    function roleActions(roleId: string): string[] {
      return (statementsByRole(stacks.ingest)[roleId] ?? []).flatMap((statement) => statement.actions).sort();
    }
    function roleOf(properties: FunctionProperties): string {
      return properties.Role['Fn::GetAtt'][0];
    }

    it('assume lambda.amazonaws.com and carry no managed policy', () => {
      const roles = Object.values(resourcesOfType(stacks.ingest, 'AWS::IAM::Role'));
      expect(roles).toHaveLength(2);
      for (const role of roles) {
        expect(role.Properties?.ManagedPolicyArns).toBeUndefined();
        expect(JSON.stringify(role.Properties?.AssumeRolePolicyDocument)).toContain('"Service":"lambda.amazonaws.com"');
      }
      expect(roleOf(ingestFunction().properties)).not.toBe(roleOf(forgetFunction().properties));
    });

    it('lets the ingest role put items, read the address key, send to the queue and write its own log group, and nothing more', () => {
      const statements = statementsByRole(stacks.ingest)[roleOf(ingestFunction().properties)] ?? [];
      const tableArn = { 'Fn::GetAtt': [logicalIdOf(stacks.ingest, 'AWS::DynamoDB::Table'), 'Arn'] };
      expect(roleActions(roleOf(ingestFunction().properties))).toEqual([
        'dynamodb:PutItem',
        ...LOG_ACTIONS,
        'secretsmanager:GetSecretValue',
        'sqs:SendMessage',
      ]);
      expect(statements.find((s) => s.actions.includes('dynamodb:PutItem'))?.resources).toEqual([tableArn]);
      expect(statements.find((s) => s.actions.includes('secretsmanager:GetSecretValue'))?.resources).toEqual([
        { Ref: logicalIdOf(stacks.ingest, 'AWS::SecretsManager::Secret') },
      ]);
      expect(statements.find((s) => s.actions.includes('sqs:SendMessage'))?.resources).toEqual([
        { 'Fn::GetAtt': [logicalIdOf(stacks.ingest, 'AWS::SQS::Queue'), 'Arn'] },
      ]);
    });

    it('lets the forget role query only its recipient index, delete items, read the address key and write its own log group, and nothing more', () => {
      const statements = statementsByRole(stacks.ingest)[roleOf(forgetFunction().properties)] ?? [];
      const tableArn = { 'Fn::GetAtt': [logicalIdOf(stacks.ingest, 'AWS::DynamoDB::Table'), 'Arn'] };
      expect(roleActions(roleOf(forgetFunction().properties))).toEqual([
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        ...LOG_ACTIONS,
        'secretsmanager:GetSecretValue',
      ]);
      expect(statements.find((s) => s.actions.includes('dynamodb:Query'))?.resources).toEqual([
        { 'Fn::Join': ['', [tableArn, `/index/${RECIPIENT_INDEX_NAME}`]] },
      ]);
      expect(statements.find((s) => s.actions.includes('dynamodb:DeleteItem'))?.resources).toEqual([tableArn]);
    });

    it('never names a wildcard resource, an SES action or a service beyond the five above', () => {
      for (const statement of Object.values(statementsByRole(stacks.ingest)).flat()) {
        expect(statement.effect).toBe('Allow');
        expect(statement.resources).not.toContain('*');
        for (const action of statement.actions) expect(action).toMatch(/^(dynamodb|logs|secretsmanager|sqs):/);
      }
    });

    it('scopes each role log statement to the log streams of that role own group', () => {
      for (const { properties } of [ingestFunction(), forgetFunction()]) {
        const statements = statementsByRole(stacks.ingest)[roleOf(properties)] ?? [];
        const logStatement = statements.find((s) => s.actions.includes('logs:PutLogEvents'));
        expect(logStatement?.actions).toEqual(LOG_ACTIONS);
        expect(JSON.stringify(logStatement?.resources)).toContain(properties.LoggingConfig.LogGroup.Ref);
        expect(JSON.stringify(logStatement?.resources)).toContain(':log-stream:*');
      }
    });
  });
});
