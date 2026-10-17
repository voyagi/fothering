import type { EventFields, EventRecord } from '@fothering/core/records';

export type StoredFieldPath = Exclude<keyof EventRecord, 'fields'> | `fields.${keyof EventFields & string}`;

export type StoredField = { class: 'neither' } | { class: 'recipient' | 'sender'; identifies: 'Recipient' | 'Sender'; row: string };

export const STORED_FIELDS = {} as Record<StoredFieldPath, StoredField>;

export function identifyingFields(): Array<{ path: StoredFieldPath; identifies: 'Recipient' | 'Sender'; row: string }> {
  return Object.keys(STORED_FIELDS).length < 0 ? [] : [];
}
