import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import type { AddressKeySet } from '@fothering/core/address';
import { LiveConfigMissingError, type AddressKeyPort } from '../port-types.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;
// A version id doubles as a field name in the same object, so an id equal to one of these would
// read that field as its key material ("current" would make the short version name the secret).
const RESERVED_FIELD_NAMES = new Set(['current', 'activeFrom']);

export class AddressKeySecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressKeySecretError';
  }
}

// D-13/D-34: {"current":"k1","activeFrom":{"k1":0,...},"k1":"<secret>",...}. Every version named in
// activeFrom needs a matching top-level secret field, and current must name the newest one -
// checked here so a malformed secret never produces a partially built key set.
const addressKeySecretSchema = z
  .object({
    current: z.string().min(1),
    activeFrom: z.record(z.string(), z.number()),
  })
  .catchall(z.string().min(MIN_SECRET_LENGTH))
  .superRefine((value, ctx) => {
    const versionIds = Object.keys(value.activeFrom);
    if (versionIds.length === 0) {
      ctx.addIssue('activeFrom names no key version');
      return;
    }
    const rawFields = value as unknown as Record<string, unknown>;
    let newestId: string | undefined;
    let newestActiveFromMs = Number.NEGATIVE_INFINITY;
    for (const id of versionIds) {
      if (id === '' || RESERVED_FIELD_NAMES.has(id)) {
        ctx.addIssue('activeFrom names an empty or reserved version id');
        continue;
      }
      if (typeof rawFields[id] !== 'string') {
        ctx.addIssue(`activeFrom names version ${id} with no matching secret field`);
        continue;
      }
      const activeFromMs = value.activeFrom[id];
      if (activeFromMs !== undefined && activeFromMs > newestActiveFromMs) {
        newestActiveFromMs = activeFromMs;
        newestId = id;
      }
    }
    if (value.current !== newestId) {
      ctx.addIssue('current does not name the version with the newest activeFrom');
    }
  });

function parseAddressKeySet(raw: unknown): AddressKeySet {
  const result = addressKeySecretSchema.safeParse(raw);
  if (!result.success) throw new AddressKeySecretError('the address key secret failed validation');

  const { activeFrom, ...fields } = result.data;
  const secretsById = fields as Record<string, string>;
  const versions = Object.entries(activeFrom)
    .map(([id, activeFromMs]) => {
      const secret = secretsById[id];
      if (secret === undefined) throw new AddressKeySecretError('the address key secret failed validation');
      return { id, secret, activeFromMs };
    })
    .sort((a, b) => a.activeFromMs - b.activeFromMs);
  return { versions };
}

export interface CreateSecretsManagerAddressKeyOptions {
  secretId: string | undefined;
  client: () => SecretsManagerClient;
  now: () => number;
}

// D-13's 5-minute per-container cache: a container's own clock decides staleness, so two
// containers holding different cached key sets is expected, bounded by the README's rotation
// margin (a new version's activeFrom sits at least 10 minutes after it is written).
export function createSecretsManagerAddressKey(options: CreateSecretsManagerAddressKeyOptions): AddressKeyPort {
  let cached: { keySet: AddressKeySet; fetchedAtMs: number } | undefined;

  return {
    async getKeySet() {
      if (options.secretId === undefined) throw new LiveConfigMissingError('FOTHERING_ADDRESS_KEY_SECRET_ID');
      const nowMs = options.now();
      if (cached !== undefined && nowMs - cached.fetchedAtMs < CACHE_TTL_MS) return cached.keySet;

      const response = await options.client().send(new GetSecretValueCommand({ SecretId: options.secretId }));
      if (response.SecretString === undefined) throw new AddressKeySecretError('the address key secret has no SecretString');

      let raw: unknown;
      try {
        raw = JSON.parse(response.SecretString);
      } catch {
        throw new AddressKeySecretError('the address key secret is not valid JSON');
      }
      const keySet = parseAddressKeySet(raw);
      cached = { keySet, fetchedAtMs: nowMs };
      return keySet;
    },
  };
}
