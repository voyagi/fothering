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

const SCALAR_TYPES = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'NULL', 'BOOL']);

// unmarshall reads a plain value as a map of its characters and accepts a second type key
// silently, so the shape is checked here, all the way down, before it runs.
function isAttributeValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  const [type, inner] = entries[0] ?? [];
  if (entries.length !== 1 || type === undefined) return false;
  if (type === 'M') return isDynamoDbItem(inner);
  if (type === 'L') return Array.isArray(inner) && inner.every(isAttributeValue);
  return SCALAR_TYPES.has(type);
}

function isDynamoDbItem(item: unknown): item is DynamoDbItem {
  return isRecord(item) && Object.values(item).every(isAttributeValue);
}

function plainItem(item: unknown, index: number): Record<string, unknown> {
  if (!isDynamoDbItem(item)) throw new SavedItemsError(`Items entry ${index + 1} is not DynamoDB JSON`);
  try {
    return unmarshall(item);
  } catch {
    throw new SavedItemsError(`Items entry ${index + 1} could not be unmarshalled`);
  }
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
  return parsed.Items.map((item: unknown, index) => plainItem(item, index));
}
