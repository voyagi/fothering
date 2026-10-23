import { describe, expect, it } from 'vitest';
import { collectPermissions, diffPermissions, serializePermissions, type StackTemplates } from './permissions.js';

// Hand-built templates in shapes CloudFormation accepts and CDK can emit: the snapshot either lists
// what each one grants, one entry per grant, or refuses it by name.

const TRUST = { Statement: { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' } };

function roleWith(policyDocument: unknown, extra: Record<string, unknown> = {}): StackTemplates {
  return {
    Stack: {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: TRUST, Policies: [{ PolicyName: 'inline', PolicyDocument: policyDocument }], ...extra } },
      },
    },
  };
}

describe('collectPermissions lists every grant once', () => {
  it('reads a single statement object and a single action string', () => {
    const entries = collectPermissions(roleWith({ Statement: { Effect: 'Allow', Action: 'ses:GetConfigurationSet', Resource: '*' } }));
    expect(entries.map((entry) => [entry.kind, entry.action])).toEqual([
      ['permission', 'ses:GetConfigurationSet'],
      ['trust', 'sts:AssumeRole'],
    ]);
  });

  it('keeps two different intrinsic actions as two entries', () => {
    const actions = [{ 'Fn::Sub': 'ses:${Verb}ConfigurationSet' }, { 'Fn::Join': ['', ['ses:', 'SendEmail']] }];
    const entries = collectPermissions(roleWith({ Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }] }));
    expect(entries.filter((entry) => entry.kind === 'permission')).toHaveLength(2);
  });

  it('lists the same grant once when it is written twice', () => {
    const statement = { Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendEmail'], Resource: ['arn:aws:ses:eu-central-1:111122223333:identity/a', 'arn:aws:ses:eu-central-1:111122223333:identity/a'] };
    expect(collectPermissions(roleWith({ Statement: [statement, statement] })).filter((entry) => entry.kind === 'permission')).toHaveLength(1);
  });

  it('renders a condition the same whatever order its keys were written in', () => {
    const one = collectPermissions(roleWith({ Statement: [{ Effect: 'Allow', Action: 'ses:SendEmail', Resource: '*', Condition: { StringEquals: { 'ses:FromAddress': 'a', 'aws:SourceAccount': '1' } } }] }));
    const two = collectPermissions(roleWith({ Statement: [{ Effect: 'Allow', Action: 'ses:SendEmail', Resource: '*', Condition: { StringEquals: { 'aws:SourceAccount': '1', 'ses:FromAddress': 'a' } } }] }));
    expect(diffPermissions(one, two)).toEqual({ missing: [], extra: [] });
  });

  it.each([
    ['NotAction', { Statement: [{ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }] }, {}],
    ['NotResource', { Statement: [{ Effect: 'Allow', Action: 'ses:SendEmail', NotResource: 'arn:aws:ses:::x' }] }, {}],
    ['no Resource', { Statement: [{ Effect: 'Allow', Action: 'ses:SendEmail' }] }, {}],
    ['a managed policy', { Statement: [] }, { ManagedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'] }],
  ])('refuses a role statement with %s', (_case, document, extra) => {
    expect(() => collectPermissions(roleWith(document, extra))).toThrow();
  });

  it.each([
    ['a managed policy resource', { Type: 'AWS::IAM::ManagedPolicy', Properties: {} }],
    ['a policy attached to a user', { Type: 'AWS::IAM::Policy', Properties: { Users: ['u'], PolicyDocument: { Statement: [] } } }],
    ['a policy naming its role by attribute', { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ 'Fn::GetAtt': ['Role', 'Arn'] }], PolicyDocument: { Statement: [] } } }],
  ])('refuses %s', (_case, resource) => {
    expect(() => collectPermissions({ Stack: { Resources: { Odd: resource } } })).toThrow();
  });
});

describe('diffPermissions and serializePermissions', () => {
  const first = collectPermissions(roleWith({ Statement: [{ Effect: 'Allow', Action: ['ses:SendEmail', 'ses:GetConfigurationSet'], Resource: '*' }] }));
  const second = collectPermissions(roleWith({ Statement: [{ Effect: 'Allow', Action: ['ses:GetConfigurationSet', 'ses:PutConfigurationSetSendingOptions'], Resource: '*' }] }));

  it('reports each side of a change as the mirror of the other', () => {
    const forward = diffPermissions(first, second);
    const backward = diffPermissions(second, first);
    expect([forward.missing, forward.extra]).toEqual([backward.extra, backward.missing]);
    expect(forward.missing.map((entry) => entry.action)).toEqual(['ses:SendEmail']);
  });

  it('round-trips through its own serialized text', () => {
    const text = serializePermissions(first);
    expect(text.endsWith('\n')).toBe(true);
    expect(diffPermissions(JSON.parse(text) as typeof first, first)).toEqual({ missing: [], extra: [] });
  });
});
