import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { IBedrockAgentRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { LaneMap } from '@fothering/core/lanes';

export interface DetectionStackProps extends StackProps {
  readonly laneMap: LaneMap;
  /** Directory holding the bundled detection handler (dist/detect in a build, a stub folder in synth tests). */
  readonly detectAssetDir: string;
  // Only the two attributes detection reads: a concrete Table is not assignable to the whole ITable
  // under exactOptionalPropertyTypes (its tableStreamArn may be undefined).
  readonly table: Pick<ITable, 'tableArn' | 'tableName'>;
  readonly runtime: IBedrockAgentRuntime;
}

export class DetectionStack extends Stack {
  constructor(scope: Construct, id: string, props: DetectionStackProps) {
    super(scope, id, props);
    new LogGroup(this, 'DetectLogs', { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
  }
}
