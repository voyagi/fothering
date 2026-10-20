import { readRepoJson } from './repo-facts.js';

const SOURCE = 'packages/infra/resources.json';

export function loadResourceSnapshot(root: string): unknown[] {
  const parsed = readRepoJson(SOURCE, root, 'Run npm run permissions:snapshot.');
  if (!Array.isArray(parsed)) throw new Error(`${SOURCE}: not a list. Run npm run permissions:snapshot.`);
  return parsed;
}

// Every CloudFormation type the synthesized stacks hold is in exactly one of these two maps, so a
// type a later stack change adds fails the deploy page's tests until someone says how to show it.
export const RESOURCE_NOUNS = {
  'AWS::BedrockAgentCore::Runtime': 'runtime',
  'AWS::CloudWatch::Alarm': 'alarm',
  'AWS::DynamoDB::Table': 'table',
  'AWS::Events::Rule': 'rule',
  'AWS::IAM::Role': 'role',
  'AWS::Lambda::Function': 'function',
  'AWS::Logs::LogGroup': 'log group',
  'AWS::Logs::MetricFilter': 'metric filter',
  'AWS::SQS::Queue': 'queue',
  'AWS::SecretsManager::Secret': 'secret',
} as const satisfies Record<string, string>;

export const NOT_LISTED = {
  'AWS::IAM::Policy': 'A policy attached to a role; the permissions table lists every grant it holds.',
  'AWS::Lambda::EventInvokeConfig': "A function's retry setting for the events that invoke it; it is removed with the function it configures.",
  'AWS::Lambda::Permission': 'The grant that lets an event rule invoke its function; the rule and the function are both listed.',
} as const satisfies Record<string, string>;

type ResourceNoun = (typeof RESOURCE_NOUNS)[keyof typeof RESOURCE_NOUNS];

interface ResourceRow {
  stack: string;
  logicalId: string;
  noun: ResourceNoun;
  /** True when `npx cdk destroy --all` deletes it, false when the stack keeps it (Retain). */
  deletedOnRemoval: boolean;
}

interface SnapshotResource {
  stack: string;
  logicalId: string;
  type: string;
  deletionPolicy: string;
}

const REMOVAL: Readonly<Record<string, boolean>> = { Delete: true, Retain: false };

function snapshotResource(value: unknown, index: number): SnapshotResource {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  for (const field of ['stack', 'logicalId', 'type', 'deletionPolicy']) {
    if (typeof entry[field] !== 'string' || entry[field] === '') {
      throw new Error(`${SOURCE}: [${index}].${field}: missing or not text. Run npm run permissions:snapshot.`);
    }
  }
  return entry as unknown as SnapshotResource;
}

export function resourceRows(entries: readonly unknown[]): ResourceRow[] {
  if (entries.length === 0) throw new Error(`${SOURCE}: no entries. Run npm run permissions:snapshot.`);
  return entries.flatMap((value, index): ResourceRow[] => {
    const entry = snapshotResource(value, index);
    const name = `${entry.stack}/${entry.logicalId}`;
    const deletedOnRemoval = REMOVAL[entry.deletionPolicy];
    if (deletedOnRemoval === undefined) {
      throw new Error(`${SOURCE}: [${index}].deletionPolicy: ${name} has ${entry.deletionPolicy}, which the deploy page has no removal wording for. Add the wording to resources-view.ts.`);
    }
    if (Object.hasOwn(NOT_LISTED, entry.type)) return [];
    if (!Object.hasOwn(RESOURCE_NOUNS, entry.type)) {
      throw new Error(`${SOURCE}: [${index}].type: ${name} is a ${entry.type}, which is not classed. Add it to RESOURCE_NOUNS or NOT_LISTED in resources-view.ts.`);
    }
    const noun = RESOURCE_NOUNS[entry.type as keyof typeof RESOURCE_NOUNS];
    return [{ stack: entry.stack, logicalId: entry.logicalId, noun, deletedOnRemoval }];
  });
}
