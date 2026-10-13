import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays, type ILogGroup } from 'aws-cdk-lib/aws-logs';

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

interface FunctionRole {
  readonly role: Role;
  readonly logGroup: LogGroup;
}

// The role and its log group exist before the function so the function's own role never gains the
// managed execution policy, and the stack, not first invocation, creates the log group.
export function createFunctionRole(stack: Stack, name: string, statements: PolicyStatement[]): FunctionRole {
  const role = new Role(stack, `${name}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
  const logGroup = new LogGroup(stack, `${name}Logs`, {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  for (const statement of [...statements, logWriteStatement(stack, logGroup)]) role.addToPolicy(statement);
  return { role, logGroup };
}

export function functionBase(assetDir: string, { role, logGroup }: FunctionRole) {
  return {
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    code: Code.fromAsset(assetDir),
    handler: 'index.handler',
    role,
    logGroup,
  };
}
