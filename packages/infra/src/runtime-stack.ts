import { ArnFormat, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AgentCoreRuntime, AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Effect, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { AGENTCORE_RUNTIME } from '@fothering/agent/listen-host';
import { liveSwitchEnvironment } from './live-switch.js';
import { logWriteStatement } from './log-statements.js';

export interface RuntimeStackProps extends StackProps {
  /** Directory holding the bundled runtime, main.js alone (dist/agent in a build, a stub folder in synth tests). */
  readonly agentAssetDir: string;
}

// The runtime deployed here holds no model and no AWS client, so its role can write its own log
// group and nothing else. AWS's published direct deploy execution role (the permissions page cited
// below) holds four more statements this role leaves out: logs:CreateLogGroup (the stack creates
// the group, see below), logs:PutResourcePolicy on the runtime's own log groups, X-Ray trace writes
// and cloudwatch:PutMetricData in the bedrock-agentcore namespace. The last two carry telemetry from
// instrumented agent code, and this runtime has none. If the first deployed runtime fails to start
// or writes no log line, those four are what to add back, CreateLogGroup first.
//
// The trust conditions are the pair AWS documents for this role ("AgentCore Runtime trust policy",
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html): this
// account, and a source ARN of any AgentCore resource in this account and Region, which needs no
// runtime ARN and so is written before the first deploy.
export class RuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const role = new Role(this, 'RuntimeRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': this.formatArn({ service: 'bedrock-agentcore', resource: '*', arnFormat: ArnFormat.NO_RESOURCE_NAME }),
          },
        },
      }),
    });

    const runtime = new Runtime(this, 'Runtime', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
        path: props.agentAssetDir,
        runtime: AgentCoreRuntime.NODE_22,
        entrypoint: ['main.js'],
      }),
      // The read-only wrapper drops the statements the construct would otherwise add on its own,
      // among them read access to the code asset bucket, so the role holds exactly what is written
      // below and the permissions snapshot can show it. The direct deploy execution role AWS
      // publishes on the permissions page cited above carries no S3 action, so the code zip is not
      // read with this role; the first deploy is the proof.
      executionRole: role.withoutPolicyUpdates(),
      // Without the runtime marker the agent listens on loopback and fails its first health check:
      // the AgentCore contract needs every interface inside the runtime's own microVM.
      environmentVariables: { FOTHERING_DEPLOYED_RUNTIME: AGENTCORE_RUNTIME, ...liveSwitchEnvironment(this) },
    });

    // AgentCore writes the runtime's logs to this name (<runtime id>-<endpoint name>, DEFAULT being
    // the endpoint every runtime gets) and creates a missing group through the execution role,
    // which AWS's published policy lets it do. This role holds no logs:CreateLogGroup, so the stack
    // creates the group, with a retention and inside the stack's removal, and AgentCore can never
    // create it first. The first invocation after the first deploy must show a log line here;
    // without one, the create permission is the fallback.
    const logGroup = new LogGroup(this, 'RuntimeLogs', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${runtime.agentRuntimeId}-DEFAULT`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // A policy of its own, not the role's default one: the runtime depends on everything under its
    // role, and this policy names the log group, whose name comes from the runtime's id, so a
    // statement added to the role itself would make the three wait on each other.
    // DescribeLogStreams authorizes on the log group itself, so its ARN has no ":*" suffix; the
    // stream writes authorize on log streams and so take the ":log-stream:*" form (CloudWatch Logs
    // guide, "Using identity-based policies", examples 3a and 3b).
    new Policy(this, 'RuntimeLogPolicy', {
      roles: [role],
      statements: [
        logWriteStatement(this, logGroup),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['logs:DescribeLogStreams'],
          resources: [this.logGroupArn(logGroup.logGroupName)],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['logs:DescribeLogGroups'],
          resources: [this.logGroupArn('*')],
        }),
      ],
    });
  }

  private logGroupArn(name: string): string {
    return this.formatArn({ service: 'logs', resource: 'log-group', resourceName: name, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
  }
}
