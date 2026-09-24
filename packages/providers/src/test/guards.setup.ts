import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { installNetworkGuard, stripAwsCredentials } from './guards.js';

// Default imports, not `import * as`: a namespace import's named bindings are read-only getters,
// which throws "Cannot redefine property" the moment installNetworkGuard tries to wrap
// dns.lookup. The default import is the real, mutable CommonJS exports object these built-ins
// still are under the hood.

// Runs as a vitest setupFile: every worker imports this before any test module's own top-level
// code, which is what makes AC-E6 (a module-scope connection attempt) provable.
stripAwsCredentials(process.env);
installNetworkGuard({ net, dns, dgram });
