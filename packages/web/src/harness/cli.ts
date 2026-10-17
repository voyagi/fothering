import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { A11Y_MESSAGES, runA11yLive } from './gates.js';
import { startPreviewServer, type PreviewServer } from './preview-server.js';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly homeDir: string;
  // Resolves when the preview should stop; the process entry waits for Ctrl+C, a test resolves it.
  readonly waitForStop: (server: PreviewServer) => Promise<void>;
}

const VALUE_OPTIONS = new Set(['--repo-root', '--global-modules', '--dist']);

function waitForSignal(): Promise<void> {
  return new Promise((resolveStop) => {
    process.once('SIGINT', () => resolveStop());
    process.once('SIGTERM', () => resolveStop());
  });
}

const processIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  homeDir: homedir(),
  waitForStop: waitForSignal,
};

function parseOptions(args: readonly string[]): Map<string, string> | string {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? '';
    const value = args[index + 1];
    if (!VALUE_OPTIONS.has(name) || value === undefined) return A11Y_MESSAGES.usage();
    options.set(name, value);
  }
  return options;
}

async function preview(options: Map<string, string>, repoRoot: string, io: CliIo): Promise<number> {
  let server: PreviewServer;
  try {
    server = await startPreviewServer({
      distDir: options.get('--dist') ?? join(repoRoot, 'packages', 'web', 'dist'),
      wranglerConfigPath: join(repoRoot, 'packages', 'web', 'wrangler.jsonc'),
    });
  } catch (error) {
    io.err(A11Y_MESSAGES.previewFailed((error as Error).message));
    return 1;
  }
  io.out(A11Y_MESSAGES.previewListening(server.url));
  await io.waitForStop(server);
  await server.close();
  return 0;
}

export async function main(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const [subcommand, ...rest] = argv;
  const options = parseOptions(rest);
  if (typeof options === 'string') {
    io.err(options);
    return 1;
  }
  const repoRoot = options.get('--repo-root');
  if (repoRoot === undefined) {
    io.err(A11Y_MESSAGES.missingOption('--repo-root'));
    return 1;
  }
  if (subcommand === 'preview') return preview(options, repoRoot, io);
  if (subcommand !== 'a11y') {
    io.err(A11Y_MESSAGES.unknownSubcommand(subcommand ?? ''));
    return 1;
  }
  const globalModules = options.get('--global-modules');
  if (globalModules === undefined) {
    io.err(A11Y_MESSAGES.missingOption('--global-modules'));
    return 1;
  }
  return runA11yLive({ repoRoot, globalModules, homeDir: io.homeDir, print: io.out });
}

// Bundled into dist/tools/site-cli.mjs and run by scripts/site-tool.mjs; a test imports this file
// without running anything, because its own URL is not the process entry then.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(await main(process.argv.slice(2)));
}
