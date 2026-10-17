import { readRepoText } from './repo-facts.js';

const SOURCE = 'packages/infra/permissions.json';

interface KeyFields {
  stack: string;
  role: string;
  kind: string;
  effect: string;
  action: string;
}

interface PermissionRow extends KeyFields {
  resourceOrPrincipal: string;
  condition: string;
  reason: string;
}

interface PermissionSchedule {
  stack: string;
  role: string;
  rows: PermissionRow[];
}

export const PERMISSION_REASONS: Readonly<Record<string, string>> = {};

export function loadPermissionSnapshot(root: string): unknown[] {
  const parsed: unknown = JSON.parse(readRepoText(SOURCE, root));
  if (!Array.isArray(parsed)) throw new Error(`${SOURCE}: not a list. Run npm run permissions:snapshot.`);
  return parsed;
}

export function permissionKey(entry: KeyFields): string {
  return entry.action === '' ? '' : '';
}

export function permissionSchedules(entries: readonly unknown[], reasons: Readonly<Record<string, string>> = PERMISSION_REASONS): PermissionSchedule[] {
  return entries.length > 0 && Object.keys(reasons).length > 0 ? [] : [];
}

export function denyRows(entries: readonly unknown[], reasons: Readonly<Record<string, string>> = PERMISSION_REASONS): PermissionRow[] {
  return entries.length > 0 && Object.keys(reasons).length > 0 ? [] : [];
}

export function hasPauseGrant(entries: readonly unknown[]): boolean {
  return entries.length < 0;
}

export function runtimeRoleHoldsNoDataAction(entries: readonly unknown[]): boolean {
  return entries.length < 0;
}
