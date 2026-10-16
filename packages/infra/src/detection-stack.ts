import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { IBedrockAgentRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import type { LaneMap } from '@fothering/core/lanes';
import { DETECT_FUNCTION_TIMEOUT_MS } from '@fothering/core/model-values';
import { liveSwitchEnvironment } from './live-switch.js';
import { ALARM_PERIOD, alarmOnAny, alarmOnErrorLines, createFunctionRole, functionBase } from './log-statements.js';

export interface DetectionStackProps extends StackProps {
  readonly laneMap: LaneMap;
  /** Directory holding the bundled detection handler (dist/detect in a build, a stub folder in synth tests). */
  readonly detectAssetDir: string;
  // Only the two attributes detection reads: a concrete Table is not assignable to the whole ITable
  // under exactOptionalPropertyTypes (its tableStreamArn may be undefined).
  readonly table: Pick<ITable, 'tableArn' | 'tableName'>;
  readonly runtime: IBedrockAgentRuntime;
}

// Its own stack, so the runtime can be deployed and tried alone while ingest and detection stay
// undeployed, and neither of the other two stacks depends on this one. It reads the table and the
// runtime through cross-stack exports, which is why it deploys after both and is destroyed first.
export class DetectionStack extends Stack {
  constructor(scope: Construct, id: string, props: DetectionStackProps) {
    super(scope, id, props);

    // A transaction's Update items authorize as UpdateItem, so the counter reservation needs no
    // action of its own (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html,
    // read 2026-10-16). Detection never deletes and never scans. The SES reads are the four
    // readSesFacts makes; nothing here can change SES state.
    const detectRole = createFunctionRole(this, 'Detect', [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [props.table.tableArn],
      }),
      // Neither list action has a resource type, so it can only be granted on every resource.
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['ses:ListEmailIdentities', 'ses:ListConfigurationSets'], resources: ['*'] }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:GetEmailIdentity'],
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:GetConfigurationSetEventDestinations'],
        resources: props.laneMap.lanes.map((lane) =>
          this.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: lane.configurationSet }),
        ),
      }),
    ]);
    // InvokeAgentRuntime alone, on the runtime and its endpoints; grantInvoke would add the
    // on-behalf-of-a-user action too.
    props.runtime.grantInvokeRuntime(detectRole.role);

    // No reserved concurrency: two overlapping cycles are carried by the conditional writes. No
    // Lambda retry either, because the schedule already reruns the cycle five minutes later, and a
    // retry would only start a second cycle that spends SES reads and invocation caps again.
    const detectFunction = new LambdaFunction(this, 'DetectFunction', {
      ...functionBase(props.detectAssetDir, detectRole),
      timeout: Duration.millis(DETECT_FUNCTION_TIMEOUT_MS),
      memorySize: 512,
      retryAttempts: 0,
      environment: {
        FOTHERING_TABLE_NAME: props.table.tableName,
        FOTHERING_AGENT_RUNTIME_ARN: props.runtime.agentRuntimeArn,
        ...liveSwitchEnvironment(this),
      },
    });

    new Rule(this, 'DetectSchedule', {
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaFunctionTarget(detectFunction)],
    });

    // A cycle that throws whole counts as a function error. A step the cycle contains (a lifecycle,
    // an opening, an agent attempt, a missing runtime ARN) logs an error-level line and returns, so
    // without the second alarm every incident could fail to open, or never reach the agent, while
    // the errors alarm stays green.
    alarmOnAny(this, 'DetectErrorsAlarm', detectFunction.metricErrors({ period: ALARM_PERIOD, statistic: 'Sum' }));
    alarmOnErrorLines(this, 'Detect', detectRole.logGroup);
  }
}
