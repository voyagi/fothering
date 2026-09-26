import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import { PARTITION_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import type { LaneMap } from '@fothering/core/lanes';

// The six detail-types EventBridge publishes for SES configuration-set event destinations
// (SPEC requirement 5). Email Sent stays in the list: the ingest handler itself drops a Send with
// no destination (D-16's ordering runs at the handler), so the rule never filters Send out.
const SES_DETAIL_TYPES = [
  'Email Sent',
  'Email Delivered',
  'Email Bounced',
  'Email Complaint Received',
  'Email Rejected',
  'Email Delivery Delayed',
];

export interface IngestStackProps extends StackProps {
  readonly laneMap: LaneMap;
  /** Directory holding the bundled ingest handler (dist/ingest in build, a stub folder in synth tests, D-19). */
  readonly ingestAssetDir: string;
}

// The skeleton this phase proves: one rule routing every mapped configuration set's events to one
// function, writing into one table. Plan 01-09 completes the stack (the byRecipient index the
// forget path queries, queue, alarm, secret, log groups, explicit roles, the forget function, and
// the dead-letter and key-secret variables the ingest function reads); no construct here needs a
// context lookup or a literal account id, so `cdk synth` runs with no credentials (D-23, AC-E36).
export class IngestStack extends Stack {
  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    const table = new Table(this, 'EventStore', {
      partitionKey: { name: PARTITION_KEY, type: AttributeType.STRING },
      sortKey: { name: SORT_KEY, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Never CDK's defaults (3 s, 128 MB, with CPU scaled to memory): one Send can carry up to 50
    // destinations, each its own conditional put, after a cold start that also reads the key
    // secret. A timeout is never a clean failure here, because Lambda stops the handler before its
    // own dead-letter path runs and the event is gone after its retries. These values are headroom,
    // not a measurement; the live runs measure the real duration.
    const ingestFunction = new LambdaFunction(this, 'IngestFunction', {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      memorySize: 512,
      code: Code.fromAsset(props.ingestAssetDir),
      handler: 'index.handler',
      environment: {
        FOTHERING_TABLE_NAME: table.tableName,
      },
    });
    table.grant(ingestFunction, 'dynamodb:PutItem');

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
  }
}
