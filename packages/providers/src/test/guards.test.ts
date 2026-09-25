import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import * as dnsNamespace from 'node:dns';
import { lookup as namedLookup, lookupService as namedLookupService, resolve4 as namedResolve4 } from 'node:dns';
import { lookup as namedPromisesLookup } from 'node:dns/promises';
import {
  NetworkGuardError,
  installNetworkGuard,
  isLoopbackHost,
  isNetworkGuarded,
  stripAwsCredentials,
  type NetworkGuardModules,
} from './guards.js';

// AC-E6: attempted at the top of this file's module scope, before any `describe`/`it` below runs.
// guards.setup.ts (a setupFile) already installed the guard by the time this line executes, so a
// real connection is refused synchronously here rather than left pending.
let moduleScopeConnectError: unknown;
try {
  const socket = net.connect({ host: '192.0.2.1', port: 9 });
  socket.on('error', () => {});
  socket.destroy();
} catch (error) {
  moduleScopeConnectError = error;
}

const AWS_ENV_VARS = [
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

interface FakeCallLog {
  connect: unknown[][];
  send: unknown[][];
  dgramConnect: unknown[][];
  lookup: unknown[][];
}

function fakeModules() {
  const calls: FakeCallLog = { connect: [], send: [], dgramConnect: [], lookup: [] };

  const netSocketPrototype = {
    connect(this: unknown, ...args: unknown[]) {
      calls.connect.push(args);
      return this;
    },
  };
  const dgramSocketPrototype = {
    send(this: unknown, ...args: unknown[]) {
      calls.send.push(args);
      return this;
    },
    connect(this: unknown, ...args: unknown[]) {
      calls.dgramConnect.push(args);
      return this;
    },
  };
  function recordingLookup(...args: unknown[]) {
    calls.lookup.push(args);
  }
  function recordingResolve(..._args: unknown[]) {}
  const resolverPrototype = { resolve4: recordingResolve, resolve6: recordingResolve };
  const promisesResolverPrototype = { resolve4: recordingResolve, resolve6: recordingResolve };

  return {
    calls,
    net: { Socket: { prototype: netSocketPrototype } },
    dns: {
      lookup: recordingLookup,
      lookupService: recordingResolve,
      resolve4: recordingResolve,
      promises: {
        lookup: recordingLookup,
        lookupService: recordingResolve,
        resolve4: recordingResolve,
        Resolver: { prototype: promisesResolverPrototype },
      },
      Resolver: { prototype: resolverPrototype },
    },
    dgram: { Socket: { prototype: dgramSocketPrototype } },
  };
}

// Shared between the real implementations and the no-op stand-ins below (AC-4), so a single
// assertion proves both that the real guard fires and that the assertion itself can go red.
function expectCredentialsStripped(strip: (env: Record<string, string | undefined>) => void): void {
  const env: Record<string, string | undefined> = {};
  for (const key of AWS_ENV_VARS) env[key] = 'planted-not-a-real-value';
  strip(env);
  for (const key of AWS_ENV_VARS) expect(env[key]).toBeUndefined();
  expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
  expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeDefined();
  expect(env.AWS_CONFIG_FILE).toBeDefined();
}

function expectConnectRefused(install: (modules: NetworkGuardModules) => void): void {
  const modules = fakeModules();
  install(modules);
  expect(() => modules.net.Socket.prototype.connect({ host: '192.0.2.1', port: 9 })).toThrow(NetworkGuardError);
}

describe('module scope (AC-E6)', () => {
  it('refused the connection before this file\'s own describe/it blocks ran', () => {
    expect(moduleScopeConnectError).toBeInstanceOf(Error);
    expect((moduleScopeConnectError as Error).name).toBe('NetworkGuardError');
  });
});

describe('the worker environment guards.setup.ts already applied', () => {
  it('has no AWS access key and reports IMDS disabled', () => {
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  // Identity checks only: calling these would reach the network if a wrap were missing.
  it.each([
    ['net Socket.prototype.connect', net.Socket.prototype.connect],
    ['dns.lookup', dns.lookup],
    ['dns.lookupService', dns.lookupService],
    ['dns.resolve4', dns.resolve4],
    ['dns.reverse', dns.reverse],
    ['dns.promises.lookup', dns.promises.lookup],
    ['dns.promises.lookupService', dns.promises.lookupService],
    ['dns.Resolver.prototype.resolve4', dns.Resolver.prototype.resolve4],
    ['dns.promises.Resolver.prototype.resolve4', dns.promises.Resolver.prototype.resolve4],
    ['dgram Socket.prototype.send', dgram.Socket.prototype.send],
    ['dgram Socket.prototype.connect', dgram.Socket.prototype.connect],
  ])('wrapped the real %s', (_name, fn) => {
    expect(isNetworkGuarded(fn)).toBe(true);
  });

  // A named or namespace import of a node: builtin is a separate ESM binding, which keeps the
  // original function unless the setup re-syncs it after patching (measured 2026-09-25).
  it.each([
    ['named import lookup', namedLookup],
    ['named import lookupService', namedLookupService],
    ['named import resolve4', namedResolve4],
    ['namespace import lookup', dnsNamespace.lookup],
    ['node:dns/promises named import lookup', namedPromisesLookup],
  ])('guards the %s too', (_name, fn) => {
    expect(isNetworkGuarded(fn)).toBe(true);
  });

  it('reports an unwrapped function as unguarded', () => {
    expect(isNetworkGuarded(() => undefined)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost', 'LOCALHOST'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['192.0.2.1', '2001:db8::1', 'example.com'])(
    'refuses %s as non-loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('stripAwsCredentials', () => {
  it('deletes every AWS credential variable, hides the profile files and disables IMDS', () => {
    expect(() => expectCredentialsStripped(stripAwsCredentials)).not.toThrow();
  });

  // A Bedrock API key is a bearer token read from AWS_BEARER_TOKEN_<SERVICE>, so the prefix is
  // stripped whole: the service this project calls, and any service a later SDK adds.
  it('deletes every AWS_BEARER_TOKEN_ variable, the Bedrock API key included', () => {
    const env: Record<string, string | undefined> = {
      AWS_BEARER_TOKEN_BEDROCK: 'planted-not-a-real-value',
      AWS_BEARER_TOKEN_SOMEFUTURESERVICE: 'planted-not-a-real-value',
      aws_bearer_token_lowercase: 'planted-not-a-real-value',
      AWS_REGION: 'eu-central-1',
    };
    stripAwsCredentials(env);
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_SOMEFUTURESERVICE).toBeUndefined();
    expect(env.aws_bearer_token_lowercase).toBeUndefined();
    expect(env.AWS_REGION).toBe('eu-central-1');
  });

  it('points the profile files at a path that does not exist', async () => {
    const { existsSync } = await import('node:fs');
    const env: Record<string, string | undefined> = {};
    stripAwsCredentials(env);
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeDefined();
    expect(env.AWS_CONFIG_FILE).toBeDefined();
    expect(existsSync(env.AWS_SHARED_CREDENTIALS_FILE as string)).toBe(false);
    expect(existsSync(env.AWS_CONFIG_FILE as string)).toBe(false);
  });
});

describe('installNetworkGuard', () => {
  it('refuses a non-loopback net.connect, including the pre-normalized array form (Pitfall 6)', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.net.Socket.prototype.connect({ host: '192.0.2.1', port: 9 })).toThrow(NetworkGuardError);
    expect(() =>
      modules.net.Socket.prototype.connect([{ host: '192.0.2.1', port: 9 }, undefined]),
    ).toThrow(NetworkGuardError);
  });

  it('allows a loopback host and a path (IPC) connect', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.net.Socket.prototype.connect({ host: '127.0.0.1', port: 9 })).not.toThrow();
    expect(() => modules.net.Socket.prototype.connect({ path: '/tmp/fothering-test.sock' })).not.toThrow();
    expect(() => modules.net.Socket.prototype.connect('/tmp/fothering-test.sock')).not.toThrow();
    expect(() => modules.net.Socket.prototype.connect(String.raw`\\.\pipe\fothering-test`)).not.toThrow();
    expect(modules.calls.connect).toHaveLength(4);
  });

  // Node reads a numeric string as a port, not a pipe name, and opens TCP whenever path is
  // falsy, so these shapes reach the network exactly like { host, port } (measured on Node
  // 22.22.3 and 24.21.0 against a loopback server).
  it.each([
    ['a port written as a string', ['9', '192.0.2.1']],
    ['a port string with spaces', [' 9 ', '192.0.2.1']],
    ['an empty path beside a host', [{ path: '', host: '192.0.2.1', port: 9 }]],
    ['a null path beside a host', [{ path: null, host: '192.0.2.1', port: 9 }]],
  ])('refuses %s, which Node connects over TCP', (_label, args) => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.net.Socket.prototype.connect(...args)).toThrow(NetworkGuardError);
    expect(modules.calls.connect).toHaveLength(0);
  });

  it('refuses dns.lookup and dns.resolve4 for a non-loopback name', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.dns.lookup('example.com', () => {})).toThrow(NetworkGuardError);
    expect(() => modules.dns.resolve4('example.com')).toThrow(NetworkGuardError);
    expect(() => modules.dns.promises.lookup('example.com')).toThrow(NetworkGuardError);
  });

  // lookupService is a reverse lookup of an address and port (getnameinfo), so it queries DNS
  // for a non-loopback address even though its name matches neither resolve nor reverse.
  it('refuses dns.lookupService for a non-loopback address and allows loopback', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.dns.lookupService('192.0.2.1', 53, () => {})).toThrow(NetworkGuardError);
    expect(() => modules.dns.promises.lookupService('192.0.2.1', 53)).toThrow(NetworkGuardError);
    expect(() => modules.dns.lookupService('127.0.0.1', 53, () => {})).not.toThrow();
  });

  it('refuses the Resolver classes\' resolve methods for a non-loopback name', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.dns.Resolver.prototype.resolve4('example.com')).toThrow(NetworkGuardError);
    expect(() => modules.dns.promises.Resolver.prototype.resolve4('example.com')).toThrow(NetworkGuardError);
  });

  it('refuses a dgram send and connect to a non-loopback address', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    expect(() => modules.dgram.Socket.prototype.send('payload', 9, '192.0.2.1')).toThrow(NetworkGuardError);
    expect(() => modules.dgram.Socket.prototype.connect(9, '192.0.2.1')).toThrow(NetworkGuardError);
  });

  it('is idempotent: installing twice wraps only once', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    const wrappedOnce = modules.net.Socket.prototype.connect;
    installNetworkGuard(modules);
    expect(modules.net.Socket.prototype.connect).toBe(wrappedOnce);
  });

  it('never lets a planted unit case reach a real connection (fakes only record calls)', () => {
    const modules = fakeModules();
    installNetworkGuard(modules);
    modules.net.Socket.prototype.connect({ host: '127.0.0.1', port: 9 });
    expect(modules.calls.connect).toHaveLength(1);
  });
});

describe('planted failures (AC-4): the same assertion run against a no-op fails', () => {
  it('a no-op credential strip leaves the credentials in place', () => {
    expect(() => expectCredentialsStripped(() => {})).toThrow();
  });

  it('a no-op network guard never refuses the connection', () => {
    expect(() => expectConnectRefused(() => {})).toThrow();
  });
});
