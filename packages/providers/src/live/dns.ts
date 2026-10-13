import type { DnsPort } from '../port-types.js';

export const DNS_LOOKUP_TIMEOUT_MS = 2_000;
export const DNS_LOOKUP_TRIES = 1;

export interface DnsResolverOptions {
  timeout: number;
  tries: number;
}

export interface DnsMxAnswer {
  exchange: string;
  priority: number;
}

export interface DnsResolver {
  resolveMx(name: string): Promise<DnsMxAnswer[]>;
  resolveTxt(name: string): Promise<string[][]>;
  cancel(): void;
}

export type DnsResolverFactory = (options: DnsResolverOptions) => DnsResolver;

export interface CreateLiveDnsOptions {
  resolverFactory?: DnsResolverFactory | undefined;
  timeoutMs?: number | undefined;
}

export function createLiveDns(_options: CreateLiveDnsOptions = {}): DnsPort {
  return {
    resolveMx: async () => ({ kind: 'unknown' }),
    resolveTxt: async () => ({ kind: 'unknown' }),
  };
}
