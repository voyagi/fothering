import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreviewServerError, startPreviewServer, type PreviewServer } from './preview-server.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CACHE = join(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const PLANT = mkdtempSync(join(CACHE, 'fothering-preview-'));

const OUTSIDE_MARKER = 'planted-outside-file';
const SIBLING_MARKER = 'planted-sibling-secret';
const HEADERS = '# the one rule\n/*\n  X-Content-Type-Options: nosniff\n  X-Planted: one\n';
const WORKERS_CONFIG = JSON.stringify({ name: 'site', assets: { directory: './dist', html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } });

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function plantSite(name: string, files: Record<string, string>, config = WORKERS_CONFIG): { dist: string; config: string } {
  const root = join(PLANT, name);
  for (const [file, text] of Object.entries(files)) write(join(root, 'dist', file), text);
  write(join(root, 'wrangler.jsonc'), config);
  return { dist: join(root, 'dist'), config: join(root, 'wrangler.jsonc') };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

// node:http, not fetch: fetch normalizes `..` segments before sending, and these cases need the
// raw path to reach the server.
function get(server: PreviewServer, path: string, method = 'GET'): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', rejectReply);
    req.end();
  });
}

let server: PreviewServer;
const replies: Reply[] = [];

async function fetchPath(path: string, method = 'GET'): Promise<Reply> {
  const reply = await get(server, path, method);
  replies.push(reply);
  return reply;
}

beforeAll(async () => {
  const site = plantSite('main', {
    'index.html': '<p>home</p>',
    'x/index.html': '<p>x page</p>',
    'x/404.html': '<p>x not found</p>',
    '404.html': '<p>not found</p>',
    '_headers': HEADERS,
    'about.html': '<p>about</p>',
    'styles/site.css': 'body{}',
    'tokens.json': '{}',
  });
  write(join(PLANT, 'main', 'package.json'), OUTSIDE_MARKER);
  write(join(PLANT, 'main', 'dist-evil', 'secret.txt'), SIBLING_MARKER);
  server = await startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config });
});

afterAll(async () => {
  await server.close();
  rmSync(PLANT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('startPreviewServer on a planted dist (D-130)', () => {
  it('binds 127.0.0.1 on a free port', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
  });

  it('serves / and /x/ with 200 and the folder index.html', async () => {
    const home = await fetchPath('/');
    expect([home.status, home.body, home.headers['content-type']]).toEqual([200, '<p>home</p>', 'text/html; charset=utf-8']);
    const folder = await fetchPath('/x/');
    expect([folder.status, folder.body]).toEqual([200, '<p>x page</p>']);
  });

  it('answers /x, /x/index and /x/index.html with 307 to /x/', async () => {
    for (const path of ['/x', '/x/index', '/x/index.html']) {
      const reply = await fetchPath(path);
      expect([reply.status, reply.headers.location], path).toEqual([307, '/x/']);
    }
  });

  it('answers /index.html with 307 to /, keeping the query', async () => {
    const reply = await fetchPath('/index.html');
    expect([reply.status, reply.headers.location]).toEqual([307, '/']);
    const withQuery = await fetchPath('/x?a=1');
    expect(withQuery.headers.location).toBe('/x/?a=1');
  });

  it('answers an unknown path with the nearest 404.html and status 404', async () => {
    const root = await fetchPath('/nope');
    expect([root.status, root.body]).toEqual([404, '<p>not found</p>']);
    const nested = await fetchPath('/x/nope');
    expect([nested.status, nested.body]).toEqual([404, '<p>x not found</p>']);
  });

  it('never serves _headers', async () => {
    for (const path of ['/_headers', '/_HEADERS', '/_headers.', '/x/../_headers']) {
      const reply = await fetchPath(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain('X-Planted');
    }
  });

  it('never returns a file outside dist through encoded traversal', async () => {
    for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/../package.json', '/%2e%2e%5cpackage.json', '/x/%2e%2e/%2e%2e/package.json']) {
      const reply = await fetchPath(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain(OUTSIDE_MARKER);
    }
  });

  it('never serves a sibling folder named like dist', async () => {
    for (const path of ['/../dist-evil/secret.txt', '/%2e%2e/dist-evil/secret.txt']) {
      const reply = await fetchPath(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain(SIBLING_MARKER);
    }
  });

  it('answers a malformed percent-encoding with 400', async () => {
    const reply = await fetchPath('/%E0%A4%A');
    expect(reply.status).toBe(400);
  });

  it('serves a page.html at /page after a 307 from /page.html, and other assets at their path', async () => {
    const redirect = await fetchPath('/about.html');
    expect([redirect.status, redirect.headers.location]).toEqual([307, '/about']);
    const page = await fetchPath('/about');
    expect([page.status, page.body]).toEqual([200, '<p>about</p>']);
    const css = await fetchPath('/styles/site.css');
    expect([css.status, css.headers['content-type']]).toEqual([200, 'text/css; charset=utf-8']);
    const json = await fetchPath('/tokens.json');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('answers HEAD without a body and other methods with 405', async () => {
    const head = await fetchPath('/', 'HEAD');
    expect([head.status, head.body]).toEqual([200, '']);
    const post = await fetchPath('/', 'POST');
    expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD']);
  });

  it('carries the _headers values and Connection: close on every response', () => {
    expect(replies.length).toBeGreaterThan(20);
    for (const reply of replies) {
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['x-planted']).toBe('one');
      expect(reply.headers.connection).toBe('close');
    }
  });
});

describe('startPreviewServer refuses what it does not implement', () => {
  it('rejects a _headers file with a second URL pattern by name', async () => {
    const site = plantSite('two-rules', { 'index.html': 'x', '_headers': `${HEADERS}/replay/*\n  X-Other: two\n` });
    const refusal = startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config });
    await expect(refusal).rejects.toBeInstanceOf(PreviewServerError);
    await expect(refusal).rejects.toThrow(/URL pattern "\/replay\/\*" is not supported/);
  });

  it('rejects a malformed _headers line by name', async () => {
    const cases: readonly (readonly [string, string])[] = [['orphan', '  X-A: b\n'], ['no-colon', '/*\n  X-A b\n'], ['detach', '/*\n  ! X-A\n']];
    for (const [name, text] of cases) {
      const site = plantSite(`headers-${name}`, { 'index.html': 'x', '_headers': text });
      await expect(startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config }), name).rejects.toThrow(/expected an indented "Name: value" line/);
    }
  });

  it('rejects a _headers read failure other than a missing file', async () => {
    const site = plantSite('headers-folder', { 'index.html': 'x', '_headers/inner.txt': 'y' });
    await expect(startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config })).rejects.toThrow(/EISDIR/);
  });

  it('rejects a wrangler.jsonc with html_handling none by name', async () => {
    const config = JSON.stringify({ assets: { html_handling: 'none', not_found_handling: '404-page' } });
    const site = plantSite('html-none', { 'index.html': 'x' }, config);
    await expect(startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config })).rejects.toThrow(/assets\.html_handling is "none"; this preview server implements only "auto-trailing-slash"/);
  });

  it('rejects an unreadable config, a config with no assets and a missing dist', async () => {
    const commented = plantSite('commented', { 'index.html': 'x' }, `// comment\n${WORKERS_CONFIG}`);
    await expect(startPreviewServer({ distDir: commented.dist, wranglerConfigPath: commented.config })).rejects.toThrow(/not readable as JSON/);
    const bare = plantSite('bare', { 'index.html': 'x' }, '{}');
    await expect(startPreviewServer({ distDir: bare.dist, wranglerConfigPath: bare.config })).rejects.toThrow(/assets\.html_handling is undefined/);
    const site = plantSite('no-dist', { 'index.html': 'x' });
    await expect(startPreviewServer({ distDir: join(site.dist, 'missing'), wranglerConfigPath: site.config })).rejects.toThrow(/no built site folder/);
  });

  // A Location that starts with // is protocol-relative: a browser would leave for the host named
  // after the slashes. Each planted file makes its path reach a redirect branch without the refusal.
  it('refuses a path that starts with // with 400 and never answers a protocol-relative Location', async () => {
    const folders = plantSite('double-slash', { 'index.html': 'x', 'replay/index.html': 'r', 'deploy.html': 'd' });
    const flat = plantSite('double-slash-flat', { 'replay.html': 'r' });
    const cases: readonly (readonly [{ dist: string; config: string }, string])[] = [
      [folders, '//replay'], [folders, '//index.html'], [flat, '//replay.html'], [folders, '//deploy/'],
    ];
    for (const [site, path] of cases) {
      const running = await startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config });
      try {
        const reply = await get(running, path);
        expect(String(reply.headers.location ?? ''), path).not.toMatch(/^\/\//);
        expect(reply.status, path).toBe(400);
      } finally {
        await running.close();
      }
    }
  });

  it('answers plain Not found with 404 when dist holds no 404.html, and serves with no _headers', async () => {
    const site = plantSite('bare-dist', { 'index.html': '<p>only</p>', 'page/index.html': 'p' });
    const bare = await startPreviewServer({ distDir: site.dist, wranglerConfigPath: site.config });
    try {
      const missing = await get(bare, '/nope/');
      expect([missing.status, missing.body, missing.headers['x-planted']]).toEqual([404, 'Not found', undefined]);
      const noFolderPage = await get(bare, '/about/');
      expect(noFolderPage.status).toBe(404);
      const folder = await get(bare, '/page');
      expect([folder.status, folder.headers.location]).toEqual([307, '/page/']);
    } finally {
      await bare.close();
    }
  });
});
