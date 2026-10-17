import { afterAll, describe, expect, it } from 'vitest';
import { page, plantDist, REPO_ROOT, type PlantedDist } from '../test/planted-dist.js';
import { loadCheckContext } from '../harness/gates.js';
import { loadBuiltSite, NOT_FOUND_ROUTE, NoBuiltPagesError } from './built-site.js';
import { dashRule, RULE_IDS, runBuiltChecks } from './rules.js';

const planted: PlantedDist[] = [];
function plant(files: Readonly<Record<string, string>>): PlantedDist {
  const tree = plantDist(files);
  planted.push(tree);
  return tree;
}

afterAll(() => {
  for (const tree of planted) tree.remove();
});

const context = loadCheckContext(REPO_ROOT);

describe('loadBuiltSite (D-150)', () => {
  const site = loadBuiltSite(plant({
    'index.html': page('<main><h1>Home</h1><p>a&nbsp;&amp;&nbsp;b\n   c</p><script>var hidden = "script text";</script><style>p { color: red }</style><template><p>template text</p></template></main>'),
    'replay/index.html': page('<p data-lede>The lede line</p><p data-provenance="generated">42</p><svg><text>drawn label</text></svg>'),
    'privacy.html': page(
      '<form action="/x"><input type="text" name="q"></form><script src="/_astro/app.js"></script><img src="/a.png" srcset="/a.png 1x, /b.png 2x">',
      '<title>p</title><meta name="description" content="d"><link rel="stylesheet" href="/tokens.css">',
    ),
    '404.html': page('<p>No sheet</p><noscript><p data-provenance="doc-derived">no script reading</p></noscript>'),
    'tokens.css': ':root { color-scheme: light; }',
  }).dist);
  const byRoute = new Map(site.pages.map((built) => [built.route, built]));

  it('returns one page per HTML file, routed the way Workers serves it', () => {
    expect(site.pages.map((built) => built.route).sort()).toEqual(['/', '/privacy', '/replay/', NOT_FOUND_ROUTE].sort());
    expect(byRoute.get('/replay/')?.file).toBe('replay/index.html');
  });

  it('gives the rendered text with entities decoded and whitespace, non-breaking spaces included, collapsed', () => {
    const home = byRoute.get('/')?.text ?? '';
    expect(home).toContain('Home a & b c');
    expect(home).not.toContain(' ');
  });

  it('leaves script, style and template content out of the rendered text', () => {
    const home = byRoute.get('/')?.text ?? '';
    expect(home).not.toMatch(/script text|color: red|template text/);
  });

  it('keeps SVG text in the rendered text and leaves it out of the text outside SVG', () => {
    const replay = byRoute.get('/replay/');
    expect(replay?.text).toContain('drawn label');
    expect(replay?.textOutsideSvg).not.toContain('drawn label');
    expect(replay?.textOutsideSvg).toContain('The lede line');
  });

  it('finds elements by their data- marker', () => {
    const replay = byRoute.get('/replay/');
    expect(replay?.markers.get('data-lede')?.map((element) => element.tag)).toEqual(['p']);
    expect(replay?.markers.get('data-provenance')?.[0]?.attrs['data-provenance']).toBe('generated');
  });

  it('reads a noscript child as elements, not as text', () => {
    expect(byRoute.get(NOT_FOUND_ROUTE)?.markers.get('data-provenance')?.[0]?.attrs['data-provenance']).toBe('doc-derived');
  });

  it('collects the raw script, link, meta, form, input and resource data', () => {
    const privacy = byRoute.get('/privacy');
    expect(privacy?.scripts).toEqual([{ src: '/_astro/app.js', text: '' }]);
    expect(privacy?.links).toEqual([{ rel: 'stylesheet', href: '/tokens.css' }]);
    expect(privacy?.metas).toContainEqual({ name: 'description', content: 'd' });
    expect(privacy?.forms).toEqual([{ action: '/x' }]);
    expect(privacy?.inputs).toEqual([{ type: 'text', name: 'q' }]);
    expect(privacy?.references).toContainEqual({ tag: 'img', attr: 'srcset', value: '/a.png 1x, /b.png 2x', rel: null });
  });

  it('lists the built CSS files with their text', () => {
    expect(site.css).toEqual([{ file: 'tokens.css', text: ':root { color-scheme: light; }' }]);
  });

  it('throws by name when the folder holds no HTML file', () => {
    const empty = plant({ 'tokens.css': ':root {}' });
    expect(() => loadBuiltSite(empty.dist)).toThrow(NoBuiltPagesError);
  });
});

describe('the dash rule (AC-54, AC-E40)', () => {
  const site = loadBuiltSite(plant({
    'index.html': page('<p>closed — one lane</p>'),
    'a/index.html': page('<p>closed &mdash; one lane</p>'),
    'b/index.html': page('<p>figure ‒ dash</p>'),
    'c/index.html': page('<p>range &#8211; dash</p>'),
  }).dist);

  it('fails a page holding U+2014, its entity, U+2012 and the numeric entity of U+2013, naming route and text', () => {
    const findings = dashRule(site, context);
    expect(findings.map((finding) => [finding.rule, finding.route])).toEqual([
      ['dash', '/'],
      ['dash', '/a/'],
      ['dash', '/b/'],
      ['dash', '/c/'],
    ]);
    expect(findings[0]?.text).toContain('closed — one lane');
    expect(findings[3]?.text).toContain('range – dash');
  });

  it('passes a clean twin holding only the hyphen-minus', () => {
    const clean = loadBuiltSite(plant({ 'index.html': page('<p>closed - one lane, re-read</p>') }).dist);
    expect(dashRule(clean, context)).toEqual([]);
  });
});

describe('runBuiltChecks', () => {
  it('registers every rule by a stable id and reports every hit, not the first', () => {
    expect(RULE_IDS).toContain('dash');
    const site = loadBuiltSite(plant({ 'index.html': page('<p>one — two</p><p>three ― four</p>') }).dist);
    expect(runBuiltChecks(site, context).filter((finding) => finding.rule === 'dash')).toHaveLength(2);
  });
});
