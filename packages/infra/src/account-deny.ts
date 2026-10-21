import { AspectPriority, Aspects, CfnResource, Tokenization, type IAspect } from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

// None of the three takes a resource type in the Service Authorization Reference (list_ses.html and
// list_sesv2.html), so * is the only resource a statement on them can name.
export const ACCOUNT_SENDING_ACTIONS = ['ses:PutAccountSendingAttributes', 'ses:UpdateAccountSendingEnabled', 'ses:UpdateConfigurationSetSendingEnabled'] as const;
export const ACCOUNT_SENDING_DENY_POLICY_NAME = 'AccountSendingDeny';

function denyPolicy(): CfnRole.PolicyProperty {
  return {
    policyName: ACCOUNT_SENDING_DENY_POLICY_NAME,
    policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: [...ACCOUNT_SENDING_ACTIONS], Resource: '*' }] },
  };
}

function holdsDeny(policies: ReadonlyArray<CfnRole.PolicyProperty | object>): boolean {
  return policies.some((policy) => 'policyName' in policy && policy.policyName === ACCOUNT_SENDING_DENY_POLICY_NAME);
}

// A Deny wins over every Allow, so a later grant, typo or wildcard on any role still cannot reach
// account-level sending. Role.addToPolicy writes a separate AWS::IAM::Policy and sets CfnRole.policies
// once from inlinePolicies, so appending here keeps every policy the role already held. Aspects can
// visit a node more than once while the tree settles, hence the check by name.
class AccountSendingDeny implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || node.cfnResourceType !== CfnRole.CFN_RESOURCE_TYPE_NAME) return;
    if (!(node instanceof CfnRole)) {
      throw new Error(`${node.node.path} is an IAM role built without CfnRole, so the account-level Deny cannot be added to it`);
    }
    const existing = node.policies ?? [];
    if (Tokenization.isResolvable(existing) || !Array.isArray(existing)) {
      throw new Error(`${node.node.path} holds its inline policies as a token, so the account-level Deny cannot be added to it`);
    }
    if (holdsDeny(existing)) return;
    node.policies = [...existing, denyPolicy()];
  }
}

export function applyAccountSendingDeny(scope: IConstruct): void {
  Aspects.of(scope).add(new AccountSendingDeny(), { priority: AspectPriority.MUTATING });
}
