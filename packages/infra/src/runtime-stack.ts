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
// group and nothing else.
export class RuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const role = new Role(this, 'RuntimeRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
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
      // below and the permissions snapshot can show it.
      executionRole: role.withoutPolicyUpdates(),
      // Without the runtime marker the agent listens on loopback and fails its first health check:
      // the AgentCore contract needs every interface inside the runtime's own microVM.
      environmentVariables: { FOTHERING_DEPLOYED_RUNTIME: AGENTCORE_RUNTIME, ...liveSwitchEnvironment(this) },
    });

    // AgentCore writes to this name on the first invocation and would otherwise create the group
    // itself, with no retention and outside the stack's removal.
    const logGroup = new LogGroup(this, 'RuntimeLogs', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${runtime.agentRuntimeId}-DEFAULT`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // A policy of its own, not the role's default one: the runtime depends on everything under its
    // role, and this policy names the log group, whose name comes from the runtime's id, so a
    // statement added to the role itself would make the three wait on each other.
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
