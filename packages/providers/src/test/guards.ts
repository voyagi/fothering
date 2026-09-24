import { isIPv4 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The names AWS SDKs read to source credentials outside an explicit config: static keys, an
// assumed profile, a role to assume, and every container or web-identity credential source.
// Deleting only the static keys would leave a profile or a container endpoint still reachable.
const AWS_CREDENTIAL_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
] as const;

// Never created. Pointing the SDK's file-based credential sources at a directory that does not
// exist is equivalent to there being no profile at all, without touching the real ~/.aws files
// this machine holds (D-27).
const NO_AWS_PROFILE_DIR = join(tmpdir(), 'fothering-test-no-aws-profile');

export function stripAwsCredentials(env: Record<string, string | undefined>): void {
  for (const key of AWS_CREDENTIAL_VARS) delete env[key];
  env.AWS_SHARED_CREDENTIALS_FILE = join(NO_AWS_PROFILE_DIR, 'credentials');
  env.AWS_CONFIG_FILE = join(NO_AWS_PROFILE_DIR, 'config');
  env.AWS_EC2_METADATA_DISABLED = 'true';
}

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const mapped = IPV4_MAPPED_RE.exec(normalized);
  const ipv4Candidate = mapped?.[1] ?? normalized;
  return isIPv4(ipv4Candidate) && ipv4Candidate.startsWith('127.');
}

export class NetworkGuardError extends Error {
  constructor(host: string) {
    super(`refused a non-loopback connection to ${host}: tests run on fixtures only`);
    this.name = 'NetworkGuardError';
  }
}

// Monkey-patch plumbing: the real signatures are overloaded per Node built-in, and the guard
// exists to intercept every call shape, not to reproduce their types.
type AnyFn = (...args: any[]) => any;

export interface NetworkGuardModules {
  net: { Socket: { prototype: { connect: AnyFn } } };
  dns: {
    lookup: AnyFn;
    promises: { lookup: AnyFn; Resolver: { prototype: object } };
    Resolver: { prototype: object };
  };
  dgram: { Socket: { prototype: { send: AnyFn; connect: AnyFn } } };
}

// Marks a wrapped function so a second install call recognizes it and skips re-wrapping. A plain
// boolean flag on the target object would work too, but the marker travels with the FUNCTION
// itself, so it survives even if callers move it between objects.
const GUARD_MARKER = Symbol('networkGuardWrapped');

function isGuarded(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<PropertyKey, unknown>)[GUARD_MARKER] === true;
}

function wrapMethod(target: object, prop: string, checkArgs: (args: unknown[]) => void): void {
  const bag = target as Record<string, unknown>;
  const original = bag[prop];
  if (typeof original !== 'function' || isGuarded(original)) return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    checkArgs(args);
    return (original as (...fnArgs: unknown[]) => unknown).apply(this, args);
  };
  (wrapped as unknown as Record<PropertyKey, unknown>)[GUARD_MARKER] = true;
  bag[prop] = wrapped;
}

// net.connect() pre-normalizes its own arguments into [options, callback] before handing them to
// Socket.prototype.connect, so a caller through the module function and a caller through the
// prototype method directly hand this two different shapes (Pitfall 6).
function firstConnectArg(args: unknown[]): unknown {
  return Array.isArray(args[0]) ? args[0][0] : args[0];
}

function assertAllowedConnect(args: unknown[]): void {
  const target = firstConnectArg(args);
  let host: string | undefined;
  let path: string | undefined;
  if (typeof target === 'object' && target !== null) {
    const opts = target as { host?: string; path?: string };
    host = opts.host;
    path = opts.path;
  } else if (typeof target === 'string') {
    path = target; // Socket.prototype.connect(path, ...) is the IPC form.
  } else if (typeof target === 'number') {
    const maybeHost = args[1];
    host = typeof maybeHost === 'string' ? maybeHost : undefined;
  }
  if (path !== undefined) return; // a Unix socket or named pipe never reaches the network.
  if (host !== undefined && !isLoopbackHost(host)) throw new NetworkGuardError(host);
}

function assertAllowedHostname(hostname: unknown): void {
  if (typeof hostname === 'string' && !isLoopbackHost(hostname)) throw new NetworkGuardError(hostname);
}

// dns.resolve4, resolveMx, reverse and every sibling share this prefix; matching by name means a
// Node release adding another resolve* method is covered without editing this list.
const HOSTNAME_METHOD_RE = /^(resolve|reverse)/;

function wrapHostnameMethods(target: object): void {
  const bag = target as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(bag)) {
    if (!HOSTNAME_METHOD_RE.test(key)) continue;
    wrapMethod(bag, key, (args) => assertAllowedHostname(args[0]));
  }
}

function lastNonCallbackArg(args: unknown[]): unknown {
  const withoutCallback = typeof args[args.length - 1] === 'function' ? args.slice(0, -1) : args;
  return withoutCallback[withoutCallback.length - 1];
}

export function installNetworkGuard(modules: NetworkGuardModules): void {
  const { net, dns, dgram } = modules;

  wrapMethod(net.Socket.prototype, 'connect', assertAllowedConnect);

  wrapMethod(dns, 'lookup', (args) => assertAllowedHostname(args[0]));
  wrapMethod(dns.promises, 'lookup', (args) => assertAllowedHostname(args[0]));
  wrapHostnameMethods(dns);
  wrapHostnameMethods(dns.promises);
  wrapHostnameMethods(dns.Resolver.prototype);
  wrapHostnameMethods(dns.promises.Resolver.prototype);

  wrapMethod(dgram.Socket.prototype, 'send', (args) => {
    const target = lastNonCallbackArg(args);
    if (typeof target === 'string') assertAllowedHostname(target);
  });
  wrapMethod(dgram.Socket.prototype, 'connect', (args) => {
    if (typeof args[1] === 'string') assertAllowedHostname(args[1]);
  });
}
