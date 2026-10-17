import * as dnsPromises from 'node:dns/promises';
import type { DnsMxOutcome, DnsTxtOutcome } from '@fothering/core/evidence-rows';
import type { DnsPort } from '../port-types.js';

// D-58: one lookup may take 2 s; at DNS_LOOKUP_CONCURRENCY in flight the cycle's worst case stays
// near 40 s of the detection function's 300 s. tries counts per name server, so with N servers a
// resolver alone could take N times the timeout: the outer timer below holds the 2 s whatever the
// server list.
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

/** The part of node's dns/promises Resolver this adapter calls. */
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

// Only these two codes say the name has no such record. Everything else, a timeout, a server
// failure, a refused query, a cancel or an error with no code at all, says the lookup failed, and a
// failed lookup read as missing would send the operator to fix a record that exists (AC-P11).
const NO_SUCH_RECORD: ReadonlySet<unknown> = new Set<unknown>([dnsPromises.NODATA, dnsPromises.NOTFOUND]);

function isNoSuchRecord(error: unknown): boolean {
  return typeof error === 'object' && error !== null && NO_SUCH_RECORD.has((error as { code?: unknown }).code);
}

const TIMED_OUT = Symbol('timed-out');

function defaultResolverFactory(options: DnsResolverOptions): DnsResolver {
  return new dnsPromises.Resolver(options);
}

function normalizedExchange(exchange: string): string {
  return exchange.toLowerCase().replace(/\.$/, '');
}

export function createLiveDns(options: CreateLiveDnsOptions = {}): DnsPort {
  const resolverFactory = options.resolverFactory ?? defaultResolverFactory;
  const timeoutMs = options.timeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;

  // A resolver per lookup: cancel() ends every outstanding query of the resolver it is called on, so
  // one shared by concurrent lookups would turn a slow neighbour's timeout into unknown answers for
  // lookups still inside their own bound.
  async function bounded<T>(lookup: (resolver: DnsResolver) => Promise<T>): Promise<T | typeof TIMED_OUT> {
    const resolver = resolverFactory({ timeout: timeoutMs, tries: DNS_LOOKUP_TRIES });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
        resolver.cancel();
      }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => lookup(resolver))(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async resolveTxt(name): Promise<DnsTxtOutcome> {
      try {
        const answer = await bounded((resolver) => resolver.resolveTxt(name));
        if (answer === TIMED_OUT) return { kind: 'unknown' };
        return { kind: 'records', records: answer.map((chunks) => chunks.join('')) };
      } catch (error) {
        return isNoSuchRecord(error) ? { kind: 'missing' } : { kind: 'unknown' };
      }
    },

    async resolveMx(name): Promise<DnsMxOutcome> {
      try {
        const answer = await bounded((resolver) => resolver.resolveMx(name));
        if (answer === TIMED_OUT) return { kind: 'unknown' };
        return { kind: 'records', exchanges: answer.map((record) => normalizedExchange(record.exchange)) };
      } catch (error) {
        return isNoSuchRecord(error) ? { kind: 'missing' } : { kind: 'unknown' };
      }
    },
  };
}
