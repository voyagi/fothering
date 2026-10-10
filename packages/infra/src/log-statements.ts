import { ArnFormat, Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';

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
