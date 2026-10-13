import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData, type IMetric } from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { FilterPattern, MetricFilter } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { PARTITION_KEY, RECIPIENT_INDEX_NAME, RECIPIENT_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import type { LaneMap } from '@fothering/core/lanes';
import { DETAIL_TYPE_BY_EVENT_TYPE } from '@fothering/core/ses-events';
import { liveSwitchEnvironment } from './live-switch.js';
import { createFunctionRole, functionBase } from './log-statements.js';

// The six of the SES detail-types EventBridge carries that a lane's health is read from, taken from
// the map the event parser checks each envelope against, so the rule forwards exactly the types the
// parser accepts; opens, clicks, rendering failures and subscriptions are never ingested. Email Sent
// stays in the list: the ingest handler itself drops a Send with no destination, so the rule never
// filters Send out.
const SES_DETAIL_TYPES = Object.values(DETAIL_TYPE_BY_EVENT_TYPE);

// The address key is one JSON secret: CDK generates the first version's key into the k1 field of
// this template, and the first version has been active since epoch 0.
const ADDRESS_KEY_TEMPLATE = JSON.stringify({ current: 'k1', activeFrom: { k1: 0 } });

const ALARM_PERIOD = Duration.minutes(5);

export interface IngestStackProps extends StackProps {
  readonly laneMap: LaneMap;
  /** Directory holding the bundled ingest handler (dist/ingest in a build, a stub folder in synth tests). */
  readonly ingestAssetDir: string;
  /** Directory holding the bundled forget handler (dist/forget in a build, a stub folder in synth tests). */
  readonly forgetAssetDir: string;
}

// Nothing here needs a context lookup or a literal account id, so `cdk synth` runs with no
// credentials, and no resource sets a physical name.
export class IngestStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    const table = this.createTable();
    this.table = table;
    const queue = new Queue(this, 'DeadLetterQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const addressKey = new Secret(this, 'AddressKey', {
      generateSecretString: {
        secretStringTemplate: ADDRESS_KEY_TEMPLATE,
        generateStringKey: 'k1',
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false,
      },
      // CloudFormation's Delete policy removes a secret with no recovery window, so stack removal
      // leaves no key behind: no scheduled deletion to wait out or cancel.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ingestRole = createFunctionRole(this, 'Ingest', [
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['dynamodb:PutItem'], resources: [table.tableArn] }),
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [addressKey.secretArn] }),
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [queue.queueArn] }),
    ]);
    // Forget finds a recipient's records through the recipient index alone and never queries the
    // base table, so Query names only the index.
    const forgetRole = createFunctionRole(this, 'Forget', [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${RECIPIENT_INDEX_NAME}`],
      }),
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['dynamodb:DeleteItem'], resources: [table.tableArn] }),
      new PolicyStatement({ effect: Effect.ALLOW, actions: ['secretsmanager:GetSecretValue'], resources: [addressKey.secretArn] }),
    ]);

    // Never CDK's defaults (3 s, 128 MB, with CPU scaled to memory): one Send can carry up to 50
    // destinations, each its own conditional put, after a cold start that also reads the key
    // secret. A timeout is never a clean failure here, because Lambda stops the handler before its
    // own dead-letter path runs and the event is gone after its retries. These values are headroom,
    // not a measurement; the live runs measure the real duration.
    const ingestFunction = new LambdaFunction(this, 'IngestFunction', {
      ...functionBase(props.ingestAssetDir, ingestRole),
      timeout: Duration.seconds(30),
      memorySize: 512,
      // Both are Lambda's defaults, written out so a synth test can pin them. There is deliberately
      // no failure destination: any destination would carry the raw event, which the minimizer
      // exists to keep out of storage.
      retryAttempts: 2,
      maxEventAge: Duration.hours(6),
      environment: {
        FOTHERING_TABLE_NAME: table.tableName,
        FOTHERING_DLQ_URL: queue.queueUrl,
        FOTHERING_ADDRESS_KEY_SECRET_ID: addressKey.secretArn,
        ...liveSwitchEnvironment(this),
      },
    });

    // Sized from the delete loop: one DeleteItem at a time, at most 4 passes (the main pass and 3
    // re-reads, each re-read after a 200 ms wait), and a re-read may list keys the index has not
    // yet dropped, so a lagging index costs a second delete call per stale key. At 15 ms a call and
    // 5 s for a cold start plus the key read, 300 s covers about 4,900 records a recipient even
    // when every re-read finds them all again. A run cut off by this limit removes what it reached
    // and a second run finishes the rest.
    const forgetFunction = new LambdaFunction(this, 'ForgetFunction', {
      ...functionBase(props.forgetAssetDir, forgetRole),
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        FOTHERING_TABLE_NAME: table.tableName,
        FOTHERING_ADDRESS_KEY_SECRET_ID: addressKey.secretArn,
        ...liveSwitchEnvironment(this),
      },
    });

    new Rule(this, 'SesEvents', {
      eventPattern: {
        source: ['aws.ses'],
        detailType: SES_DETAIL_TYPES,
        detail: {
          mail: {
            tags: {
              'ses:configuration-set': props.laneMap.lanes.map((lane) => lane.configurationSet),
            },
          },
        },
      },
      targets: [new LambdaFunctionTarget(ingestFunction)],
    });

    // Lambda drops an event that failed its retries with no record, and the queue alarm never sees
    // it, so a failing ingest function would be silent without this one.
    this.alarmOnAny('IngestErrorsAlarm', ingestFunction.metricErrors({ period: ALARM_PERIOD, statistic: 'Sum' }));
    // The errors alarm fires on a failed attempt, even one a retry then fixes; this one fires on an
    // event that is gone. It also sees the drops the errors alarm cannot: Lambda counts a throttled
    // request as neither an invocation nor an error, so an event still throttled when its 6 hours
    // run out, or one met by a reserved concurrency of 0, is dropped without a single error
    // (Lambda metrics page, AsyncEventsDropped).
    this.alarmOnAny('IngestDroppedEventsAlarm', ingestFunction.metric('AsyncEventsDropped', { period: ALARM_PERIOD, statistic: 'Sum' }));
    this.alarmOnAny(
      'DeadLetterDepthAlarm',
      queue.metricApproximateNumberOfMessagesVisible({ period: ALARM_PERIOD, statistic: 'Maximum' }),
    );
    // A schema failure or an unstorable send time is logged at error level and the handler returns
    // without throwing, so none of the three alarms above counts it and the event is gone: an SES
    // format change that failed every event would leave them all green. This one counts every
    // error-level line, so a failure that also throws shows here and under the errors alarm. The
    // handler writes its JSON lines straight to stdout, which Lambda's Node.js logging page leaves
    // unprefixed (it prefixes console output), so the filter reads each line's own level field.
    const errorLines = new MetricFilter(this, 'IngestErrorLines', {
      logGroup: ingestRole.logGroup,
      filterPattern: FilterPattern.stringValue('$.level', '=', 'error'),
      metricNamespace: 'Fothering',
      metricName: 'IngestErrorLines',
      metricValue: '1',
    });
    this.alarmOnAny('IngestErrorLinesAlarm', errorLines.metric({ period: ALARM_PERIOD, statistic: 'Sum' }));

    new CfnOutput(this, 'ForgetFunctionName', { value: forgetFunction.functionName });
  }

  // Every alarm here fires on a single occurrence within one period and acts on nothing: the
  // operator reads the alarm state, and no action exists yet for it to take.
  private alarmOnAny(id: string, metric: IMetric): Alarm {
    return new Alarm(this, id, {
      metric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  private createTable(): Table {
    const table = new Table(this, 'EventStore', {
      partitionKey: { name: PARTITION_KEY, type: AttributeType.STRING },
      sortKey: { name: SORT_KEY, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: RECIPIENT_INDEX_NAME,
      partitionKey: { name: RECIPIENT_KEY, type: AttributeType.STRING },
      sortKey: { name: SORT_KEY, type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    return table;
  }

}
