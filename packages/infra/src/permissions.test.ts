import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectPermissions,
  diffPermissions,
  serializePermissions,
  synthesizePermissionTemplates,
  type CfnTemplate,
  type PermissionEntry,
  type StackTemplates,
} from './permissions.js';

const SNAPSHOT_URL = new URL('../permissions.json', import.meta.url);

function committedSnapshot(): PermissionEntry[] {
  return JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as PermissionEntry[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface PlantedStatement {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Principal?: unknown;
  Condition?: unknown;
}

// The statement of a synthesized template that a plant edits, found by what it grants rather than
// by its position, so a reordered template still plants in the right place.
function statementIn(templates: StackTemplates, stack: string, resourceType: string, action: string): PlantedStatement {
  const template = templates[stack] as CfnTemplate;
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== resourceType) continue;
    const document = (resource.Properties?.PolicyDocument ?? resource.Properties?.AssumeRolePolicyDocument) as { Statement: PlantedStatement[] };
    const found = document.Statement.find((statement) => [statement.Action].flat().includes(action));
    if (found !== undefined) return found;
  }
  throw new Error(`no ${resourceType} statement in ${stack} grants ${action}`);
}

function rolesOf(entries: readonly PermissionEntry[], stack: string, prefix: string): PermissionEntry[] {
  return entries.filter((entry) => entry.stack === stack && entry.role.startsWith(prefix));
}

function actionsOf(entries: readonly PermissionEntry[]): string[] {
  return [...new Set(entries.filter((entry) => entry.kind === 'permission').map((entry) => entry.action))].sort();
}

describe('the permissions snapshot', () => {
  let templates: StackTemplates;
  let synthesized: PermissionEntry[];
  beforeAll(() => {
    templates = synthesizePermissionTemplates();
    synthesized = collectPermissions(templates);
  }, 60_000);

  it('equals the permissions the two stacks synthesize, in both directions', () => {
    const committed = committedSnapshot();
    expect(committed.length).toBeGreaterThan(0);
    expect(diffPermissions(committed, synthesized)).toEqual({ missing: [], extra: [] });
  });

  it('turns red on one planted added action, naming exactly that entry', () => {
    const planted = clone(templates);
    const statement = statementIn(planted, 'FotheringIngest', 'AWS::IAM::Policy', 'dynamodb:PutItem');
    statement.Action = ['dynamodb:PutItem', 'dynamodb:DeleteItem'];
    const diff = diffPermissions(committedSnapshot(), collectPermissions(planted));
    expect(diff.missing).toEqual([]);
    expect(diff.extra.map((entry) => entry.action)).toEqual(['dynamodb:DeleteItem']);
  });

  it('turns red on a removed condition, a Deny turned Allow and a widened trust principal', () => {
    const noCondition = clone(templates);
    delete statementIn(noCondition, 'FotheringRuntime', 'AWS::IAM::Role', 'sts:AssumeRole').Condition;
    const conditionDiff = diffPermissions(committedSnapshot(), collectPermissions(noCondition));
    expect(conditionDiff.missing).toHaveLength(1);
    expect(conditionDiff.extra).toHaveLength(1);
    expect(conditionDiff.missing[0]?.condition).not.toBeNull();
    expect(conditionDiff.extra[0]?.condition).toBeNull();

    const widened = clone(templates);
    statementIn(widened, 'FotheringRuntime', 'AWS::IAM::Role', 'sts:AssumeRole').Principal = { AWS: '*' };
    const widenedDiff = diffPermissions(committedSnapshot(), collectPermissions(widened));
    expect(widenedDiff.missing).toHaveLength(1);
    expect(widenedDiff.extra.map((entry) => entry.principal)).toEqual(['{"AWS":"*"}']);

    // The committed file holds no Deny, so this pair is built from a plant of its own: the same
    // statement as a Deny, then as an Allow.
    const denied = clone(templates);
    const denyStatement = statementIn(denied, 'FotheringIngest', 'AWS::IAM::Policy', 'dynamodb:PutItem');
    denyStatement.Effect = 'Deny';
    const allowed = clone(denied);
    statementIn(allowed, 'FotheringIngest', 'AWS::IAM::Policy', 'dynamodb:PutItem').Effect = 'Allow';
    const effectDiff = diffPermissions(collectPermissions(denied), collectPermissions(allowed));
    expect(effectDiff.missing.map((entry) => entry.effect)).toEqual(['Deny']);
    expect(effectDiff.extra.map((entry) => entry.effect)).toEqual(['Allow']);
  });

  it('serializes byte for byte the same from two syntheses, and whatever order the template lists things in', () => {
    const again = collectPermissions(synthesizePermissionTemplates());
    expect(serializePermissions(again)).toBe(serializePermissions(synthesized));

    const reversed: StackTemplates = Object.fromEntries(
      Object.entries(templates)
        .reverse()
        .map(([stack, template]) => [stack, { ...template, Resources: Object.fromEntries(Object.entries(template.Resources ?? {}).reverse()) }]),
    );
    expect(serializePermissions(collectPermissions(reversed))).toBe(serializePermissions(synthesized));
  });

  it('lists entries sorted by stack, role, kind, action and resource', () => {
    const order = synthesized.map((entry) => [entry.stack, entry.role, entry.kind, entry.action, entry.resource ?? '']);
    const sorted = [...order].sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const left = a[i] as string;
        const right = b[i] as string;
        if (left !== right) return left < right ? -1 : 1;
      }
      return 0;
    });
    expect(order).toEqual(sorted);
    expect(new Set(synthesized.map((entry) => JSON.stringify(entry))).size).toBe(synthesized.length);
  });

  it('holds exactly the actions of the ingest, forget and runtime roles, and no ses: action anywhere', () => {
    expect(actionsOf(rolesOf(synthesized, 'FotheringIngest', 'IngestRole'))).toEqual([
      'dynamodb:PutItem',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'secretsmanager:GetSecretValue',
      'sqs:SendMessage',
    ]);
    expect(actionsOf(rolesOf(synthesized, 'FotheringIngest', 'ForgetRole'))).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'secretsmanager:GetSecretValue',
    ]);
    const runtimeActions = actionsOf(rolesOf(synthesized, 'FotheringRuntime', 'RuntimeRole'));
    expect(runtimeActions).toEqual(['logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents']);
    for (const action of runtimeActions) expect(action).not.toMatch(/^(ses|dynamodb|s3|bedrock):/);
    for (const entry of synthesized) expect(entry.action).not.toMatch(/^ses:/);
  });

  it('records who may assume each role, with the runtime role tied to this account', () => {
    const trust = synthesized.filter((entry) => entry.kind === 'trust');
    expect(trust.map((entry) => [entry.role.replace(/[0-9A-F]{8}$/, ''), entry.principal, entry.action])).toEqual([
      ['ForgetRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['IngestRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['RuntimeRole', '{"Service":"bedrock-agentcore.amazonaws.com"}', 'sts:AssumeRole'],
    ]);
    const runtimeTrust = trust.find((entry) => entry.stack === 'FotheringRuntime');
    expect(runtimeTrust?.condition).toBe('{"StringEquals":{"aws:SourceAccount":{"Ref":"AWS::AccountId"}}}');
    for (const entry of synthesized.filter((candidate) => candidate.kind === 'permission')) expect(entry.effect).toBe('Allow');
  });
});

describe('collectPermissions refuses what a snapshot cannot describe', () => {
  const role = (properties: Record<string, unknown>): StackTemplates => ({
    Stack: { Resources: { Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [] }, ...properties } } } },
  });

  it('throws on a role carrying a managed policy arn, and on a managed policy resource', () => {
    expect(() => collectPermissions(role({ ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] }))).toThrow(/ManagedPolicyArns/);
    expect(() => collectPermissions({ Stack: { Resources: { Managed: { Type: 'AWS::IAM::ManagedPolicy', Properties: {} } } } })).toThrow(/AWS::IAM::ManagedPolicy/);
    expect(collectPermissions(role({}))).toEqual([]);
  });

  it('throws on a statement it cannot read as a grant, and on a policy attached to a user', () => {
    const notAction = role({
      Policies: [{ PolicyName: 'p', PolicyDocument: { Statement: [{ Effect: 'Allow', NotAction: 'ses:*', Resource: '*' }] } }],
    });
    expect(() => collectPermissions(notAction)).toThrow(/NotAction/);
    const noResource = role({ Policies: [{ PolicyName: 'p', PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'logs:PutLogEvents' }] } }] });
    expect(() => collectPermissions(noResource)).toThrow(/no Resource/);
    const userPolicy: StackTemplates = {
      Stack: { Resources: { P: { Type: 'AWS::IAM::Policy', Properties: { Users: [{ Ref: 'U' }], PolicyDocument: { Statement: [] } } } } },
    };
    expect(() => collectPermissions(userPolicy)).toThrow(/user or a group/);
  });

  it('reads inline role policies and separate policies attached to a role the same way', () => {
    const statement = { Effect: 'Allow', Action: ['logs:PutLogEvents'], Resource: [{ Ref: 'A' }, { 'Fn::GetAtt': ['B', 'Arn'] }] };
    const inline = collectPermissions(role({ Policies: [{ PolicyName: 'p', PolicyDocument: { Statement: [statement] } }] }));
    const attached = collectPermissions({
      Stack: {
        Resources: {
          Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [] } } },
          Policy: { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ Ref: 'Role' }], PolicyDocument: { Statement: [statement] } } },
        },
      },
    });
    expect(inline).toHaveLength(2);
    expect(attached).toEqual(inline);
    expect(inline.map((entry) => entry.resource)).toEqual(['{"Fn::GetAtt":["B","Arn"]}', '{"Ref":"A"}']);
  });
});
