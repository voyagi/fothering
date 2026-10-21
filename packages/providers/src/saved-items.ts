import { unmarshall } from '@aws-sdk/util-dynamodb';

type DynamoDbItem = Parameters<typeof unmarshall>[0];

// Callers read only the name, so a saved file's text never travels inside an error message.
class SavedItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedItemsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The saved output of one `aws dynamodb query`, as plain items: the one reader check-saved and the capture share. */
export function readSavedItems(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SavedItemsError('the saved text is not JSON');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.Items)) throw new SavedItemsError('the saved JSON holds no Items list');
  return parsed.Items.map((item: unknown) => unmarshall(item as DynamoDbItem));
}
