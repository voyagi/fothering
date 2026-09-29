import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnWaitConditionHandle } from 'aws-cdk-lib/aws-cloudformation';
import type { Construct } from 'constructs';

export interface RuntimeStackProps extends StackProps {
  readonly agentAssetDir: string;
}

// A stack CloudFormation accepts holds at least one resource; the runtime itself comes next.
export class RuntimeStack extends Stack {
  constructor(scope: Construct, id: string, _props: RuntimeStackProps) {
    super(scope, id, _props);
    new CfnWaitConditionHandle(this, 'Placeholder');
  }
}
