import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, relative, resolve, sep } from 'node:path';

// The two Workers asset settings this server reproduces. Any other value in wrangler.jsonc is
// refused, so the preview can never quietly serve under rules the deployed site does not use.
const IMPLEMENTED_ASSET_SETTINGS = Object.freeze({
  html_handling: 'auto-trailing-slash',
  not_found_handling: '404-page',
});

const BIND_ADDRESS = '127.0.0.1';
const HEADERS_FILE = '_headers';
const NOT_FOUND_PAGE = '404.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export type PreviewRefusal = 'config' | 'dist' | 'headers' | 'bind';

export class PreviewServerError extends Error {
  readonly code: PreviewRefusal;

  constructor(code: PreviewRefusal, message: string) {
    super(message);
    this.name = 'PreviewServerError';
    this.code = code;
  }
}

export interface PreviewServerOptions {
  readonly distDir: string;
  readonly wranglerConfigPath: string;
}

export interface PreviewServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

type Header = readonly [name: string, value: string];

type Answer =
  | { readonly kind: 'file'; readonly path: string; readonly status: 200 | 404 }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'text'; readonly status: 400 | 404 | 405; readonly body: string };

function readAssetSettings(configPath: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new PreviewServerError('config', `${configPath}: not readable as JSON (${(error as Error).message})`);
  }
  const assets = typeof parsed === 'object' && parsed !== null && 'assets' in parsed ? parsed.assets : undefined;
  for (const [key, expected] of Object.entries(IMPLEMENTED_ASSET_SETTINGS)) {
    const value = typeof assets === 'object' && assets !== null && key in assets ? (assets as Record<string, unknown>)[key] : undefined;
    if (value !== expected) {
      throw new PreviewServerError('config', `${configPath}: assets.${key} is ${JSON.stringify(value)}; this preview server implements only "${expected}"`);
    }
  }
}

// One `/*` block of indented `Name: value` lines is all the site's _headers holds (D-149). Any other
// URL pattern would need Cloudflare's matching engine, so it is refused rather than half-applied.
function parseHeadersFile(text: string): Header[] {
  const headers: Header[] = [];
  let pattern: string | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const where = `_headers line ${index + 1}`;
    if (!/^\s/.test(line)) {
      pattern = line.trim();
      if (pattern !== '/*') throw new PreviewServerError('headers', `${where}: URL pattern "${pattern}" is not supported; this preview server applies one "/*" rule`);
      continue;
    }
    const colon = line.indexOf(':');
    if (pattern === undefined || colon <= 0) throw new PreviewServerError('headers', `${where}: expected an indented "Name: value" line under "/*"`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name === '' || name.startsWith('!')) throw new PreviewServerError('headers', `${where}: expected an indented "Name: value" line under "/*"`);
    headers.push([name, value]);
  }
  return headers;
}

function readHeaders(dist: string): Header[] {
  let text: string;
  try {
    text = readFileSync(join(dist, HEADERS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseHeadersFile(text);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Windows opens `name.`, `name ` and `name::$DATA` as `name`, which would let `/_headers.` or a
// stream suffix reach a file the separator check below believes is something else.
function hasUnsafeSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    if (segment.includes(':') || segment.includes('\\')) return true;
    return segment !== '.' && segment !== '..' && /[. ]$/.test(segment);
  });
}

class SiteFiles {
  constructor(private readonly dist: string) {}

  // Separator-bounded, so a sibling folder such as dist-evil never counts as inside dist.
  inside(urlPath: string): string | undefined {
    const candidate = resolve(this.dist, `.${urlPath}`);
    if (candidate !== this.dist && !candidate.startsWith(this.dist + sep)) return undefined;
    const fromDist = relative(this.dist, candidate).split(sep).join('/');
    if (fromDist.toLowerCase() === HEADERS_FILE) return undefined;
    return candidate;
  }

  fileAt(urlPath: string): string | undefined {
    const candidate = this.inside(urlPath);
    return candidate !== undefined && isFile(candidate) ? candidate : undefined;
  }

  // The nearest 404.html walking up from the requested folder, as Workers' 404-page handling does.
  notFound(urlPath: string): Answer {
    const folders = urlPath.split('/').slice(1, -1);
    for (let depth = folders.length; depth >= 0; depth -= 1) {
      const page = this.fileAt(`/${folders.slice(0, depth).map((f) => `${f}/`).join('')}${NOT_FOUND_PAGE}`);
      if (page !== undefined) return { kind: 'file', path: page, status: 404 };
    }
    return { kind: 'text', status: 404, body: 'Not found' };
  }
}

function decodePath(rawUrl: string): string | undefined {
  const rawPath = rawUrl.split(/[?#]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
}

// The html_handling "auto-trailing-slash" rows from Cloudflare's table that this site produces;
// nothing beyond them is claimed.
// A path that starts with // is refused before any redirect is built: its Location would be
// protocol-relative and send a browser to the host named after the slashes.
function answerFor(files: SiteFiles, rawUrl: string): Answer {
  const path = decodePath(rawUrl);
  if (path === undefined || !path.startsWith('/') || path.startsWith('//') || path.includes('\0')) return { kind: 'text', status: 400, body: 'Bad request' };
  const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
  if (hasUnsafeSegment(path)) return files.notFound('/');
  const redirect = (location: string): Answer => ({ kind: 'redirect', location: `${encodeURI(location)}${search}` });

  if (path.endsWith('/index.html')) {
    const folder = path.slice(0, -'index.html'.length);
    return files.fileAt(path) === undefined ? files.notFound(path) : redirect(folder);
  }
  if (path.endsWith('/index')) {
    const folder = path.slice(0, -'index'.length);
    return files.fileAt(`${folder}index.html`) === undefined ? files.notFound(path) : redirect(folder);
  }
  if (path.endsWith('/')) {
    const page = files.fileAt(`${path}index.html`);
    if (page !== undefined) return { kind: 'file', path: page, status: 200 };
    return path !== '/' && files.fileAt(`${path.slice(0, -1)}.html`) !== undefined ? redirect(path.slice(0, -1)) : files.notFound(path);
  }
  if (path.endsWith('.html')) {
    return files.fileAt(path) === undefined ? files.notFound(path) : redirect(path.slice(0, -'.html'.length));
  }
  const exact = files.fileAt(path);
  if (exact !== undefined) return { kind: 'file', path: exact, status: 200 };
  const page = files.fileAt(`${path}.html`);
  if (page !== undefined) return { kind: 'file', path: page, status: 200 };
  if (files.fileAt(`${path}/index.html`) !== undefined) return redirect(`${path}/`);
  return files.notFound(path);
}

async function respond(files: SiteFiles, headers: readonly Header[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  for (const [name, value] of headers) response.appendHeader(name, value);
  response.setHeader('Connection', 'close');
  const method = request.method ?? 'GET';
  const answer: Answer = method === 'GET' || method === 'HEAD'
    ? answerFor(files, request.url ?? '/')
    : { kind: 'text', status: 405, body: 'Method not allowed' };
  if (answer.kind === 'redirect') {
    response.writeHead(307, { Location: answer.location });
    response.end();
    return;
  }
  const body = answer.kind === 'file' ? await readFile(answer.path) : Buffer.from(answer.body, 'utf8');
  const type = answer.kind === 'file' ? CONTENT_TYPES[extname(answer.path).toLowerCase()] ?? 'application/octet-stream' : 'text/plain; charset=utf-8';
  if (answer.kind === 'text' && answer.status === 405) response.setHeader('Allow', 'GET, HEAD');
  response.writeHead(answer.status, { 'Content-Type': type, 'Content-Length': body.length });
  response.end(method === 'HEAD' ? undefined : body);
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  readAssetSettings(options.wranglerConfigPath);
  const dist = resolve(options.distDir);
  let distIsFolder = false;
  try {
    distIsFolder = statSync(dist).isDirectory();
  } catch {
    distIsFolder = false;
  }
  if (!distIsFolder) throw new PreviewServerError('dist', `${dist}: no built site folder; run npm run build first`);
  const headers = readHeaders(dist);
  const files = new SiteFiles(dist);

  const server = createServer((request, response) => {
    respond(files, headers, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Preview server error: ${(error as Error).message}`);
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, BIND_ADDRESS, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const close = (): Promise<void> => new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || address.address !== BIND_ADDRESS) {
    await close();
    throw new PreviewServerError('bind', `the preview server bound ${JSON.stringify(address)}, not ${BIND_ADDRESS}`);
  }
  return { url: `http://${BIND_ADDRESS}:${address.port}`, port: address.port, close };
}
