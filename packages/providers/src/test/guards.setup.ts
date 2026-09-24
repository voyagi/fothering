import * as dgram from 'node:dgram';
import * as dns from 'node:dns';
import * as net from 'node:net';
import { installNetworkGuard, stripAwsCredentials } from './guards.js';

// Runs as a vitest setupFile: every worker imports this before any test module's own top-level
// code, which is what makes AC-E6 (a module-scope connection attempt) provable.
stripAwsCredentials(process.env);
installNetworkGuard({ net, dns, dgram });
