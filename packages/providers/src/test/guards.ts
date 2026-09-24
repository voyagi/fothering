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

// GREEN phase implements the wrapping; RED phase proves the target assertions can fail for real.
export function installNetworkGuard(modules: NetworkGuardModules): void {
  void modules;
}
