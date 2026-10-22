import { CfnOutput, CfnParameter, Duration, Fn, Stack, type StackProps } from 'aws-cdk-lib';
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
  readonly ingest: Pick<IngestStack, 'table' | 'addressKey'>;
}

// One bare address: no display name, no second @, no space. No * or ? either: both values become
// ses:SendEmail identity ARNs, where they are IAM wildcards ('*@*.*' would grant every address identity).
const ADDRESS_PATTERN = '^[^@\\s<>*?]+@[^@\\s<>*?]+\\.[^@\\s<>*?]+$';

// The operator's addresses live only in the deployed stack's parameters and the action function's
// environment, never in the repository or the committed snapshot. A first deploy without them fails;
// later deploys keep the previous values.
function addressParameter(stack: Stack, id: string, purpose: string): CfnParameter {
  return new CfnParameter(stack, id, {
    type: 'String',
    allowedPattern: ADDRESS_PATTERN,
    constraintDescription: 'one email address, with no display name',
    description: `${purpose}. Set it with --parameters ${stack.stackName}:${id}=<address>.`,
  });
}

// The operator email goes out through the single operator-alert set; with none or several the action
// sends nothing, so the role holds no send. Both From identities are granted because which one SES
// authorizes a send against, when the From address and its domain are both verified identities, is
// unverified until a live send. The operator address's own identity is granted too: on an SES sandbox
// account a live send to it on 2026-10-22 was refused on identity/<operator address>, so the sandbox
// checks the recipient's identity as well. Only the address, never its domain, which would let the role
// send from any address there. No ses:FromAddress condition: how SES compares it with a From header
// carrying a display name is unverified too. The domain is split from the parameter at deploy time,
// since at synth time the address is a token, not text.
function sendStatement(stack: Stack, laneMap: LaneMap, fromAddress: string, operatorAddress: string): PolicyStatement[] {
  const [alertLane, ...otherAlertLanes] = laneMap.lanes.filter((lane) => lane.operatorAlert);
  if (alertLane === undefined || otherAlertLanes.length > 0) return [];
  const identity = (name: string): string => stack.formatArn({ service: 'ses', resource: 'identity', resourceName: name });
  return [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:SendEmail'],
      resources: [
        identity(fromAddress),
        identity(Fn.select(1, Fn.split('@', fromAddress))),
        identity(operatorAddress),
        stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: alertLane.configurationSet }),
      ],
    }),
  ];
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

    const operatorAddress = addressParameter(this, 'OperatorAddress', 'The address the operator email is sent to');
    const fromAddress = addressParameter(this, 'FromAddress', 'The address the operator email is sent from, on a verified SES identity');

    // Query is for the hold check's fold over the lane's records; the action never deletes and never
    // scans. A conditional UpdateItem carries the lane-hour attempt counter and the pause pointer.
    // The address key is read for the pseudonyms on the dry-run send line.
    const actionRole = createFunctionRole(this, 'Action', [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [props.ingest.table.tableArn],
      }),
      ...sesFactReadStatements(this, props.laneMap),
      ...pauseStatement(staticallyCloseableArns(this, props.laneMap)),
      ...sendStatement(this, props.laneMap, fromAddress.valueAsString, operatorAddress.valueAsString),
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [props.ingest.addressKey.secretArn] }),
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
        FOTHERING_OPERATOR_ADDRESS: operatorAddress.valueAsString,
        FOTHERING_FROM_ADDRESS: fromAddress.valueAsString,
        FOTHERING_ADDRESS_KEY_SECRET_ID: props.ingest.addressKey.secretArn,
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
