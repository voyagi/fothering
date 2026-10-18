import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { ACTION_FUNCTION_TIMEOUT_MS, REOPEN_FUNCTION_TIMEOUT_MS } from '@fothering/core/close-values';
import { isStaticallyCloseable } from '@fothering/core/closeability';
import type { LaneMap } from '@fothering/core/lanes';
import type { IngestStack } from './ingest-stack.js';
import { liveSwitchEnvironment } from './live-switch.js';
import { ALARM_PERIOD, alarmOnAny, alarmOnErrorLines, createFunctionRole, functionBase, sesFactReadStatements } from './log-statements.js';

export interface ActionStackProps extends StackProps {
  readonly laneMap: LaneMap;
  /** Directory holding the bundled action handler (dist/action in a build, a stub folder in synth tests). */
  readonly actionAssetDir: string;
  /** Directory holding the bundled reopen handler (dist/reopen in a build, a stub folder in synth tests). */
  readonly reopenAssetDir: string;
  readonly ingest: Pick<IngestStack, 'table'>;
}

// The lane-map rule the action applies at run time, so IAM can never let a role pause a set the code
// would refuse, and the code can never need a set IAM withholds.
export function staticallyCloseableArns(stack: Stack, laneMap: LaneMap): string[] {
  return laneMap.lanes
    .filter(isStaticallyCloseable)
    .map((lane) => stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: lane.configurationSet }));
}

// Every role that may pause takes this one statement, so the pause grants cannot drift apart. A lane
// map with nothing closeable gets no statement at all: an empty resource list would fail the deploy,
// and a * would reach every set.
function pauseStatement(arns: readonly string[]): PolicyStatement[] {
  if (arns.length === 0) return [];
  return [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:GetConfigurationSet', 'ses:PutConfigurationSetSendingOptions'],
      resources: [...arns],
    }),
  ];
}

// The only stack holding an SES write, so a deployment without it can watch and detect but never
// pause anything; that is why it deploys last and is destroyed first. It takes the table from the
// ingest stack and depends on neither the runtime nor detection.
export class ActionStack extends Stack {
  constructor(scope: Construct, id: string, props: ActionStackProps) {
    super(scope, id, props);

    // Query is for the hold check's fold over the lane's records; the action never deletes and never
    // scans. A conditional UpdateItem carries the lane-hour attempt counter and the pause pointer.
    const actionRole = createFunctionRole(this, 'Action', [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [props.ingest.table.tableArn],
      }),
      ...sesFactReadStatements(this, props.laneMap),
      ...pauseStatement(staticallyCloseableArns(this, props.laneMap)),
    ]);

    // No reserved concurrency: overlapping runs are carried by the conditional writes. No Lambda retry
    // either, because the schedule reruns the action five minutes later.
    const actionFunction = new LambdaFunction(this, 'ActionFunction', {
      ...functionBase(props.actionAssetDir, actionRole),
      timeout: Duration.millis(ACTION_FUNCTION_TIMEOUT_MS),
      memorySize: 512,
      retryAttempts: 0,
      environment: {
        FOTHERING_TABLE_NAME: props.ingest.table.tableName,
        ...liveSwitchEnvironment(this),
      },
    });

    new Rule(this, 'ActionSchedule', {
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaFunctionTarget(actionFunction)],
    });

    alarmOnAny(this, 'ActionErrorsAlarm', actionFunction.metricErrors({ period: ALARM_PERIOD, statistic: 'Sum' }));
    alarmOnErrorLines(this, 'Action', actionRole.logGroup);

    // D-104: the reopen reads its pause pointer and closure by key and moves them by conditional
    // update (the claim, the outcome and the lane-hour counter), so no Query, PutItem, DeleteItem or Scan.
    const reopenRole = createFunctionRole(this, 'Reopen', [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [props.ingest.table.tableArn],
      }),
      ...pauseStatement(staticallyCloseableArns(this, props.laneMap)),
    ]);

    // No schedule and no alarm: the operator runs it by hand and reads its result from the invoke.
    const reopenFunction = new LambdaFunction(this, 'ReopenFunction', {
      ...functionBase(props.reopenAssetDir, reopenRole),
      timeout: Duration.millis(REOPEN_FUNCTION_TIMEOUT_MS),
      memorySize: 256,
      environment: {
        FOTHERING_TABLE_NAME: props.ingest.table.tableName,
        ...liveSwitchEnvironment(this),
      },
    });

    new CfnOutput(this, 'ReopenFunctionName', { value: reopenFunction.functionName });
  }
}
