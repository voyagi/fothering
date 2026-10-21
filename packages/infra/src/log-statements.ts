import { ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData, type IMetric } from 'aws-cdk-lib/aws-cloudwatch';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { FilterPattern, LogGroup, MetricFilter, RetentionDays, type ILogGroup } from 'aws-cdk-lib/aws-logs';
import type { LaneMap } from '@fothering/core/lanes';

export const ALARM_PERIOD = Duration.minutes(5);

// Every alarm fires on a single occurrence within one period and acts on nothing: the operator reads
// the alarm state, and no action exists yet for it to take.
export function alarmOnAny(stack: Stack, id: string, metric: IMetric): Alarm {
  return new Alarm(stack, id, {
    metric,
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  });
}

// Counts every error-level line of a function's log group and alarms on one. The handlers write their
// JSON lines straight to stdout, which Lambda's Node.js logging page leaves unprefixed (it prefixes
// console output), so the filter reads each line's own level field.
export function alarmOnErrorLines(stack: Stack, name: string, logGroup: ILogGroup): Alarm {
  const errorLines = new MetricFilter(stack, `${name}ErrorLines`, {
    logGroup,
    filterPattern: FilterPattern.stringValue('$.level', '=', 'error'),
    metricNamespace: 'Fothering',
    metricName: `${name}ErrorLines`,
    metricValue: '1',
  });
  return alarmOnAny(stack, `${name}ErrorLinesAlarm`, errorLines.metric({ period: ALARM_PERIOD, statistic: 'Sum' }));
}

// Scoped to the log streams of the one group the stack created for this role, never the group
// wildcard a managed execution policy would grant.
export function logWriteStatement(stack: Stack, logGroup: ILogGroup): PolicyStatement {
  return new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [
      stack.formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: `${logGroup.logGroupName}:log-stream:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      }),
    ],
  });
}

// The four reads readSesFacts makes. Detection and the action re-check the same facts, so both roles
// take them from here and cannot drift apart.
export function sesFactReadStatements(stack: Stack, laneMap: LaneMap): PolicyStatement[] {
  return [
    // Neither list action has a resource type, so it can only be granted on every resource.
    new PolicyStatement({ effect: Effect.ALLOW, actions: ['ses:ListEmailIdentities', 'ses:ListConfigurationSets'], resources: ['*'] }),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:GetEmailIdentity'],
      resources: [stack.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
    }),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:GetConfigurationSetEventDestinations'],
      resources: laneMap.lanes.map((lane) => stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: lane.configurationSet })),
    }),
  ];
}

interface FunctionRole {
  readonly role: Role;
  readonly logGroup: LogGroup;
}

// The role and its log group exist before the function so the function's own role never gains the
// managed execution policy, and the stack, not first invocation, creates the log group.
export function createFunctionRole(stack: Stack, name: string, statements: PolicyStatement[]): FunctionRole {
  const role = new Role(stack, `${name}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  const logGroup = new LogGroup(stack, `${name}Logs`, {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  for (const statement of [...statements, logWriteStatement(stack, logGroup)]) role.addToPolicy(statement);
  return { role, logGroup };
}

export function functionBase(assetDir: string, { role, logGroup }: FunctionRole) {
  return {
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    code: Code.fromAsset(assetDir),
    handler: 'index.handler',
    role,
    logGroup,
  };
}
