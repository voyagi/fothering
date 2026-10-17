import { compareText, type StackTemplates } from './permissions.js';

export interface ResourceEntry {
  stack: string;
  logicalId: string;
  type: string;
  /** The template's DeletionPolicy, or Delete when the template sets none (CloudFormation's default). */
  deletionPolicy: string;
}

export interface ResourceDiff {
  /** In the first list and not the second. */
  missing: ResourceEntry[];
  /** In the second list and not the first. */
  extra: ResourceEntry[];
}

function compareResources(a: ResourceEntry, b: ResourceEntry): number {
  return compareText(a.stack, b.stack) || compareText(a.logicalId, b.logicalId);
}

// Built from the four fields, so a snapshot written with its keys in another order compares equal
// and a changed DeletionPolicy reads as one entry missing and one extra.
function resourceKey(entry: ResourceEntry): string {
  return JSON.stringify([entry.stack, entry.logicalId, entry.type, entry.deletionPolicy]);
}

export function collectResources(templates: StackTemplates): ResourceEntry[] {
  return Object.entries(templates)
    .flatMap(([stack, template]) =>
      Object.entries(template.Resources ?? {}).map(([logicalId, resource]) => ({
        stack,
        logicalId,
        type: resource.Type,
        deletionPolicy: resource.DeletionPolicy ?? 'Delete',
      })),
    )
    .sort(compareResources);
}

export function diffResources(first: readonly ResourceEntry[], second: readonly ResourceEntry[]): ResourceDiff {
  const inFirst = new Set(first.map(resourceKey));
  const inSecond = new Set(second.map(resourceKey));
  return {
    missing: first.filter((entry) => !inSecond.has(resourceKey(entry))),
    extra: second.filter((entry) => !inFirst.has(resourceKey(entry))),
  };
}

export function serializeResources(entries: readonly ResourceEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
