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

// A Bedrock API key rides in AWS_BEARER_TOKEN_BEDROCK, and the SDK derives the variable name
// from each service's signing name, so the whole prefix goes rather than one listed name.
const AWS_BEARER_TOKEN_PREFIX = 'AWS_BEARER_TOKEN_';

export function stripAwsCredentials(env: Record<string, string | undefined>): void {
  for (const key of AWS_CREDENTIAL_VARS) delete env[key];
  // Upper-cased before matching: Windows reads environment names case-insensitively.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith(AWS_BEARER_TOKEN_PREFIX)) delete env[key];
  }
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

// Exported so a test can prove a real module's function is the wrapper without calling it, which
// would reach the network if the wrap were missing.
export function isNetworkGuarded(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<PropertyKey, unknown>)[GUARD_MARKER] === true;
}

function wrapMethod(target: object, prop: string, checkArgs: (args: unknown[]) => void): void {
  const bag = target as Record<string, unknown>;
  const original = bag[prop];
  if (typeof original !== 'function' || isNetworkGuarded(original)) return;
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

// Node's own rule for a bare string argument: it is a pipe name only when Number() does not
// read it as a non-negative number, so connect('443', host) is a TCP port, not a path.
function isPipeName(value: string): boolean {
  return !(Number(value) >= 0);
}

function assertAllowedConnect(args: unknown[]): void {
  const target = firstConnectArg(args);
  let host: unknown;
  let path: unknown;
  if (typeof target === 'object' && target !== null) {
    const opts = target as { host?: unknown; path?: unknown };
    host = opts.host;
    path = opts.path;
  } else if (typeof target === 'string' && isPipeName(target)) {
    path = target; // Socket.prototype.connect(path, ...) is the IPC form.
  } else {
    host = args[1]; // connect(port, host): the port may be a number or a numeric string.
  }
  // Node opens a pipe only for a truthy path; an empty or null path falls through to TCP.
  if (typeof path === 'string' && path !== '') return; // a Unix socket or named pipe never reaches the network.
  if (typeof host === 'string' && !isLoopbackHost(host)) throw new NetworkGuardError(host);
}

function assertAllowedHostname(hostname: unknown): void {
  if (typeof hostname === 'string' && !isLoopbackHost(hostname)) throw new NetworkGuardError(hostname);
}

// dns.resolve4, resolveMx, reverse and every sibling share this prefix; matching by name means a
// Node release adding another resolve* method is covered without editing this list.
// lookupService is the one other query: a reverse lookup whose first argument is the address.
const HOSTNAME_METHOD_RE = /^(resolve|reverse|lookupService$)/;

function wrapHostnameMethods(target: object): void {
  const bag = target as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(bag)) {
    if (!HOSTNAME_METHOD_RE.test(key)) continue;
    wrapMethod(bag, key, (args) => assertAllowedHostname(args[0]));
  }
}

// socket.send(msg[, offset, length][, port][, address][, callback]) and a connected socket's
// send(msg[, callback]), which takes no port or address. Node's own send reads the offset form
// only when a fifth argument or a non-function fourth one is present, and the short form's
// address as the third; this mirrors that choice so a message is never read as a destination.
function dgramSendAddress(args: unknown[]): unknown {
  const usesOffsetForm = Boolean(args[4]) || (Boolean(args[3]) && typeof args[3] !== 'function');
  return usesOffsetForm ? args[4] : args[2];
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
    const target = dgramSendAddress(args);
    if (typeof target === 'string') assertAllowedHostname(target);
  });
  wrapMethod(dgram.Socket.prototype, 'connect', (args) => {
    if (typeof args[1] === 'string') assertAllowedHostname(args[1]);
  });
}
