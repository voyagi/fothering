import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import { PARTITION_KEY, SORT_KEY, TTL_ATTRIBUTE } from '@fothering/core/records';
import type { LaneMap } from '@fothering/core/lanes';

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
  readonly ingestAssetDir: string;
  readonly forgetAssetDir: string;
}

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
