# ADR 0001: Stack

- Status: accepted
- Date: 2026-09-16
- Revised: 2026-09-24 (agent bundle corrected to CommonJS, site workspace path recorded, fallback order corrected)

## Context

Fothering reads Amazon SES events per configuration set, works out the cause of a bounce or complaint spike from evidence, pauses one configuration set, reads the setting back, and asks the operator to approve by email reply. It must use Amazon SES and Amazon Bedrock AgentCore, run in eu-central-1, and ship a public site where anyone can replay a recorded incident without installing anything.

Three constraints shape every choice below:

1. Nothing calls a live AWS service by default. Tests and the public site run on recorded fixtures, and one documented switch turns live mode on.
2. The decision to close a lane is made by code over an evidence table. The model explains and chooses among options the code already approved.
3. One language across the agent, the functions, the infrastructure and the site, so the event schemas and fixtures are shared rather than copied.

## Decision

| Area | Choice | Version checked 2026-09-16 |
|---|---|---|
| Language | TypeScript | 6.0.3 |
| Runtime | Node.js 22 | AgentCore `NODE_22` |
| Agent framework | Strands Agents TypeScript SDK | `@strands-agents/sdk` 1.x, pinned below 1.18.0 until it is three days old |
| Agent contract server | `bedrock-agentcore` (`BedrockAgentCoreApp`) | 0.4.4, pinned exactly |
| Agent host | Amazon Bedrock AgentCore Runtime, code package (CodeZip), arm64 | eu-central-1 |
| Model | Claude Sonnet 5 through the EU inference profile `eu.anthropic.claude-sonnet-5` | |
| SES access | SES API v2 (`@aws-sdk/client-sesv2`) | 3.x |
| Event destination | EventBridge (default bus) | |
| Event store | DynamoDB, on demand, TTL | |
| Infrastructure | AWS CDK in TypeScript | `aws-cdk-lib` 2.269.0 |
| Site | Astro, static output, at `packages/web` inside the existing `packages/*` workspace glob | 7.3.2 |
| Site host | Cloudflare Workers with static assets | `wrangler` 4.x |
| Schemas | zod | 4.x |
| Tests | vitest, fast-check, StrykerJS | vitest 4.1.x |
| Package manager | npm workspaces | |

### Why AgentCore Runtime with TypeScript works

- AWS documents a TypeScript Strands agent deployed to AgentCore Runtime as a code package: [Get started with the AgentCore CLI in TypeScript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html). The CLI compiles the agent, packages it as a CodeZip archive and deploys it through the AWS CDK. The runtime is arm64 only.
- `NODE_22` is the one Node.js runtime for direct code deploy, deprecation 2027-04-30: [Supported language runtimes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-code-deploy-supported-runtimes.html).
- Europe (Frankfurt) supports AgentCore Runtime and AgentCore Memory: [Supported AWS Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html).
- `aws-cdk-lib` 2.269.0 ships `AgentRuntimeArtifact.fromCodeAsset({ path, runtime, entrypoint })` with `AgentCoreRuntime.NODE_22` in `aws-bedrockagentcore/lib/runtime/runtime-artifact.d.ts`.

The one part without an official example is a Node code package deployed through our own CDK app rather than the AgentCore CLI. The CDK module README only shows Python for `fromCodeAsset`. The first deploy of the agent settles it. If it fails, in order:

1. Let the AgentCore CLI deploy the runtime and import its ARN into the CDK app for everything else.
2. Keep the same agent code and build a linux/arm64 container with `AgentRuntimeArtifact.fromAsset`.

### Why these and not the alternatives

- **TypeScript 6.0.3, not 7.x.** `typescript-eslint` 8.70.0 requires `<6.1.0` and `@astrojs/check` 0.9.10 requires `^5 || ^6`.
- **vitest 4, not 5.** `@cloudflare/vitest-pool-workers` 0.22.0 requires `vitest ^4.1.0`.
- **EU profile, not global, not Haiku 4.5.** A `global.` profile routes requests worldwide, which contradicts the EU processing statement. Haiku 4.5 can reach end of life in October 2026. The EU profile routes across several EU Regions, so the privacy page says "EU Regions", not "Frankfurt".
- **EventBridge, not SNS or Firehose.** EventBridge filters on event type before invoking a function. Firehose buffers into batches, which is too slow for a guard. SES delivers to EventBridge best effort and possibly out of order, so ingest deduplicates and buckets by send time.
- **DynamoDB, not Timestream or S3 with Athena.** Per-item TTL gives the 30-day retention without a cleanup job. TTL deletes within a few days of expiry, so reads filter on the expiry attribute and the privacy page states that timing.
- **CDK, not Terraform or SAM.** CDK has stable AgentCore Runtime and Memory constructs in the same library as SES, EventBridge, Lambda and DynamoDB, and `cdk synth` produces one template the deploy page can publish with its IAM policy.
- **Astro static, not SvelteKit or Next.js.** The replay reads committed JSON at build time and needs no server. Astro ships no JavaScript by default and hydrates only the replay timeline and the console. Next.js on Workers through vinext is still beta.
- **npm workspaces, not pnpm.** npm ships with Node, CI needs no extra setup step, and the gate scripts run through `npm run`.

## Consequences

- Local development and CI run Node 22 so tests exercise the version that ships. The repo declares `engines.node` as `>=22.18`, the floor the locked tooling (size-limit, Babel under Stryker) requires.
- Every AWS client sits behind a port with a fixture implementation and a live one. The default resolves to fixtures, and a test fails if it ever resolves live.
- Nothing native may enter the agent bundle unless it is built for linux/arm64. The agent is bundled with esbuild into one CommonJS file, main.js, because bedrock-agentcore builds its own require at run time and an ESM bundle cannot start on the runtime; a small build plugin removes the line that builds that require before the bundle is written.
- Account-level SES sending is never exposed by a port and never granted by IAM.
- Deploying anything, sending mail and calling Bedrock are manual steps run with the live switch on. None of them run in CI.
