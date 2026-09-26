import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import { PARTITION_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import type { LaneMap } from '@fothering/core/lanes';

// The six detail-types EventBridge publishes for SES configuration-set event destinations
// (SPEC requirement 5); Send is excluded here because the ingest handler drops a Send with no
// destination itself, not because the rule filters it out (D-16's ordering runs at the handler).
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
// function, writing into one table. Plan 01-09 completes the stack (queue, alarm, secret, log
// groups, explicit roles, the forget function); no construct here needs a context lookup or a
// literal account id, so `cdk synth` runs with no credentials (D-23, AC-E36).
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

    const ingestFunction = new LambdaFunction(this, 'IngestFunction', {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
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
