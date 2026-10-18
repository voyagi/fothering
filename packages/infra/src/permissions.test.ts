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

const SES_READS = ['ses:GetConfigurationSetEventDestinations', 'ses:GetEmailIdentity', 'ses:ListConfigurationSets', 'ses:ListEmailIdentities'];
const PAUSE_ACTIONS = ['ses:GetConfigurationSet', 'ses:PutConfigurationSetSendingOptions'];

// Written out rather than imported, so a change to the Aspect's own list cannot pass by moving this
// expectation with it.
const ACCOUNT_LEVEL_ACTIONS = ['ses:PutAccountSendingAttributes', 'ses:UpdateAccountSendingEnabled', 'ses:UpdateConfigurationSetSendingEnabled'];
const ACCOUNT_SENDING_DENY = {
  PolicyName: 'AccountSendingDeny',
  PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ACCOUNT_LEVEL_ACTIONS, Resource: '*' }] },
};

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
  return [...new Set(entries.filter((entry) => entry.kind === 'permission' && entry.effect === 'Allow').map((entry) => entry.action))].sort();
}

describe('the permissions snapshot', () => {
  let templates: StackTemplates;
  let synthesized: PermissionEntry[];
  beforeAll(() => {
    templates = synthesizePermissionTemplates();
    synthesized = collectPermissions(templates);
  }, 60_000);

  it('equals the permissions the four stacks synthesize, in both directions', () => {
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

    // The committed Deny entries are all account-level ones on *, so this pair is built from a plant of
    // its own: the same table statement as a Deny, then as an Allow.
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

  it('holds exactly the actions of the detection role', () => {
    expect(actionsOf(rolesOf(synthesized, 'FotheringDetection', 'DetectRole')).join(',')).toBe(
      'bedrock-agentcore:InvokeAgentRuntime,dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSetEventDestinations,ses:GetEmailIdentity,ses:ListConfigurationSets,ses:ListEmailIdentities',
    );
  });

  it('holds exactly the actions of the action role', () => {
    expect(actionsOf(rolesOf(synthesized, 'FotheringAction', 'ActionRole')).join(',')).toBe(
      'dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSet,ses:GetConfigurationSetEventDestinations,ses:GetEmailIdentity,ses:ListConfigurationSets,ses:ListEmailIdentities,ses:PutConfigurationSetSendingOptions',
    );
  });

  it('holds exactly the actions of the reopen role: named items read and updated, the reopen and its read-back (D-104)', () => {
    expect(actionsOf(rolesOf(synthesized, 'FotheringAction', 'ReopenRole')).join(',')).toBe(
      'dynamodb:GetItem,dynamodb:UpdateItem,logs:CreateLogStream,logs:PutLogEvents,ses:GetConfigurationSet,ses:PutConfigurationSetSendingOptions',
    );
  });

  it('allows SES actions on the detection, action and reopen roles only: the four reads, the pause and its read-back on the action role, and the reopen role the pause pair alone', () => {
    const sesEntries = synthesized.filter((entry) => entry.effect === 'Allow' && entry.action.toLowerCase().startsWith('ses:'));
    expect(sesEntries.length).toBeGreaterThan(0);
    const allowed: Record<string, readonly string[]> = {
      'FotheringDetection/DetectRole': SES_READS,
      'FotheringAction/ActionRole': [...SES_READS, ...PAUSE_ACTIONS],
      'FotheringAction/ReopenRole': PAUSE_ACTIONS,
    };
    for (const entry of sesEntries) {
      const role = `${entry.stack}/${entry.role.replace(/[0-9A-F]{8}$/, '')}`;
      expect(Object.keys(allowed)).toContain(role);
      expect(allowed[role]).toContain(entry.action);
    }
  });

  it('gives every role in the four stacks the AccountSendingDeny inline policy, beside the policies it already held', () => {
    let roles = 0;
    for (const [stack, template] of Object.entries(templates)) {
      for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
        if (resource.Type !== 'AWS::IAM::Role') continue;
        roles += 1;
        const policies = (resource.Properties?.Policies ?? []) as Array<{ PolicyName: string }>;
        expect(policies.map((policy) => policy.PolicyName), `${stack}/${logicalId} policy names`).toContain('AccountSendingDeny');
        expect(policies).toContainEqual(ACCOUNT_SENDING_DENY);
        expect(policies.filter((policy) => policy.PolicyName === 'AccountSendingDeny')).toHaveLength(1);
      }
    }
    expect(roles).toBe(6);
  });

  it('holds Deny entries only for the account-level actions on *, three per role, and every other permission entry is Allow', () => {
    const denies = synthesized.filter((entry) => entry.kind === 'permission' && entry.effect === 'Deny');
    expect(denies).toHaveLength(18);
    for (const entry of denies) {
      expect(ACCOUNT_LEVEL_ACTIONS).toContain(entry.action);
      expect(entry.resource).toBe('"*"');
      expect(entry.condition).toBeNull();
    }
    for (const entry of synthesized.filter((candidate) => candidate.kind === 'permission' && candidate.effect !== 'Deny')) expect(entry.effect).toBe('Allow');
  });

  it('holds exactly the actions of the ingest, forget and runtime roles', () => {
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
    expect(runtimeActions).toEqual(['bedrock:InvokeModel', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents']);
    for (const action of runtimeActions) expect(action).not.toMatch(/^(ses|dynamodb|s3):/);
  });

  it('records who may assume each role, with the runtime role tied to this account', () => {
    const trust = synthesized.filter((entry) => entry.kind === 'trust');
    expect(trust.map((entry) => [entry.role.replace(/[0-9A-F]{8}$/, ''), entry.principal, entry.action])).toEqual([
      ['ActionRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['ReopenRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['DetectRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['ForgetRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['IngestRole', '{"Service":"lambda.amazonaws.com"}', 'sts:AssumeRole'],
      ['RuntimeRole', '{"Service":"bedrock-agentcore.amazonaws.com"}', 'sts:AssumeRole'],
    ]);
    const runtimeTrust = trust.find((entry) => entry.stack === 'FotheringRuntime');
    expect(runtimeTrust?.condition).toBe(
      '{"ArnLike":{"aws:SourceArn":{"Fn::Join":["",["arn:aws:bedrock-agentcore:eu-central-1:",{"Ref":"AWS::AccountId"},":*"]]}},"StringEquals":{"aws:SourceAccount":{"Ref":"AWS::AccountId"}}}',
    );
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
