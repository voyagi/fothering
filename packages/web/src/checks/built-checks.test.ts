import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { completeSite, HEADERS_TEXT, page, plantDist, REPO_ROOT, SHEET_HEAD_ITEMS, THEME_HEAD, type PlantedDist } from '../test/planted-dist.js';
import { loadCheckContext } from '../harness/gates.js';
import { HEAD_SCRIPT, headScriptHash, renderTokensCss } from '../theme/head-script.js';
import { BANNED_NAMES, CONSOLE_DELETE_PHRASES, REPLY_PROMISE_PHRASES } from '../site/content.js';
import { renderRobots, renderSitemap, SITE_ORIGIN } from '../site/route-list.js';
import { filesIn, loadBuiltSite, NOT_FOUND_ROUTE, NoBuiltPagesError, type BuiltSite } from './built-site.js';
import {
  bannedNameRule,
  checkFileBudget,
  consoleDeleteRule,
  dashRule,
  exactThirtyDaysRule,
  formsCookiesAnalyticsRule,
  headScriptOrderRule,
  noInlineStyleRule,
  pageMetadataRule,
  preR6WordsRule,
  regionClaimRule,
  replyPromiseRule,
  robotsRule,
  RULE_IDS,
  runBuiltChecks,
  scriptHashRule,
  sesPercentageLinkRule,
  sesRateWordingRule,
  sitemapRule,
  themeTokenBlocksRule,
  thirdPartyReferenceRule,
  typeTokenDeclaredRule,
  unitFigureRule,
  type Finding,
} from './rules.js';

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
    expect(home).not.toContain('\u00a0');
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
    'index.html': page('<p>closed \u2014 one lane</p>'),
    'a/index.html': page('<p>closed &mdash; one lane</p>'),
    'b/index.html': page('<p>figure \u2012 dash</p>'),
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
    expect(findings[0]?.text).toContain('closed \u2014 one lane');
    expect(findings[3]?.text).toContain('range \u2013 dash');
  });

  it('passes a clean twin holding only the hyphen-minus', () => {
    const clean = loadBuiltSite(plant({ 'index.html': page('<p>closed - one lane, re-read</p>') }).dist);
    expect(dashRule(clean, context)).toEqual([]);
  });
});

describe('runBuiltChecks', () => {
  it('registers every rule by a stable id and reports every hit, not the first', () => {
    expect(RULE_IDS).toContain('dash');
    const site = loadBuiltSite(plant({ 'index.html': page('<p>one \u2014 two</p><p>three \u2015 four</p>') }).dist);
    expect(runBuiltChecks(site, context).filter((finding) => finding.rule === 'dash')).toHaveLength(2);
  });

  it('runs the page metadata, sitemap and robots rules over a build that has none of them', () => {
    const site = loadBuiltSite(plant({ 'index.html': page('<p>bare</p>', '') }).dist);
    const rules = new Set(runBuiltChecks(site, context).map((finding) => finding.rule));
    expect([...rules].filter((rule) => ['page-metadata', 'sitemap', 'robots'].includes(rule)).sort()).toEqual(['page-metadata', 'robots', 'sitemap']);
  });

  it('holds exactly the twenty rule ids the plans name', () => {
    expect([...RULE_IDS].sort()).toEqual([
      'banned-name', 'console-delete', 'dash', 'exact-30-days', 'forms-cookies-analytics', 'head-script-order', 'no-inline-style', 'page-metadata',
      'pre-r6-words', 'region-claim', 'reply-promise', 'robots', 'script-hash', 'ses-percentage-link', 'ses-rate-wording', 'sitemap',
      'theme-token-blocks', 'third-party-reference', 'type-token-declared', 'unit-figure',
    ]);
  });

  it('passes a complete planted site under every rule', () => {
    expect(runBuiltChecks(siteOf(completeSite({ 'index.html': '<p>landing</p>', '404.html': '<p>none</p>' })), context)).toEqual([]);
  });
});

const REPUTATION = 'https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html';
type RuleFunction = (site: BuiltSite, ruleContext: typeof context) => Finding[];

function siteOf(files: Readonly<Record<string, string>>): BuiltSite {
  return loadBuiltSite(plant(files).dist);
}

// One planted page per case at /case-<n>/, so a finding names the case that raised it.
function casesSite(bodies: readonly string[]): BuiltSite {
  return siteOf(Object.fromEntries(bodies.map((body, index) => [`case-${index}/index.html`, page(body)])));
}

function caseFindings(rule: RuleFunction, id: string, bodies: readonly string[]): Finding[] {
  const findings = rule(casesSite(bodies), context);
  expect(findings.every((finding) => finding.rule === id)).toBe(true);
  expect([...new Set(findings.map((finding) => finding.route))].sort()).toEqual(bodies.map((_, index) => `/case-${index}/`).sort());
  for (const finding of findings) expect(finding.text.length).toBeGreaterThan(0);
  return findings;
}

describe('the SES rate wording rule (AC-54, AC-E41, AC-P5)', () => {
  it('fails all four phrasings in any case, across a non-breaking space, a line break and an inline element', () => {
    const findings = caseFindings(sesRateWordingRule, 'ses-rate-wording', [
      '<p>Your SES bounce rate went up.</p>',
      '<p>your ses COMPLAINT rate went up.</p>',
      '<p>Your&nbsp;bounce&nbsp;rate went up.</p>',
      '<p>your\n complaint\n rate went up.</p>',
      '<p>your <b>SES</b> bounce rate went up.</p>',
    ]);
    expect(findings[4]?.text).toContain('your SES bounce rate');
  });

  it('passes the lane ratio wording', () => {
    expect(sesRateWordingRule(casesSite(['<p>The hard-bounce ratio on the bulk lane is 9 of 40 sends.</p>']), context)).toEqual([]);
  });
});

describe('the SES percentage link rule (AC-54, AC-E44, AC-P18)', () => {
  it('fails an SES sentence with 5%, 5 %, 5.0% or 0.1 percent and no reputation link in the same element', () => {
    expect(caseFindings(sesPercentageLinkRule, 'ses-percentage-link', [
      '<p>SES reviews an account at a bounce rate of 5%.</p>',
      '<li>SES reviews an account at 5 % bounces.</li>',
      '<table><tr><td>SES review threshold 5.0%</td></tr></table>',
      `<p>SES may pause at 0.1 percent complaints.</p><p><a href="${REPUTATION}">reputation page</a></p>`,
    ])).not.toEqual([]);
  });

  it('passes the same sentence with the reputation link inside the element', () => {
    expect(sesPercentageLinkRule(casesSite([`<p>SES reviews an account at a bounce rate of 5%, per <a href="${REPUTATION}">the reputation page</a>.</p>`]), context)).toEqual([]);
  });
});

describe('the reply-promise and console-delete rules (AC-55, AC-P6, AC-P7)', () => {
  it('fails every committed reply-promise phrase', () => {
    expect(REPLY_PROMISE_PHRASES.length).toBeGreaterThanOrEqual(8);
    expect(caseFindings(replyPromiseRule, 'reply-promise', REPLY_PROMISE_PHRASES.map((phrase) => `<p>You can ${phrase.toUpperCase()} the lane.</p>`))).not.toEqual([]);
  });

  it('fails every committed console-delete phrase', () => {
    expect(CONSOLE_DELETE_PHRASES.length).toBeGreaterThanOrEqual(6);
    expect(caseFindings(consoleDeleteRule, 'console-delete', CONSOLE_DELETE_PHRASES.map((phrase) => `<p>Use the ${phrase} control.</p>`))).not.toEqual([]);
  });

  it('passes the reopen command and the documented delete command', () => {
    const clean = casesSite(['<p>The operator email names the reopen command; a lane reopens only by that command.</p><p>Deletion is the documented delete-one-recipient command.</p>']);
    expect([...replyPromiseRule(clean, context), ...consoleDeleteRule(clean, context)]).toEqual([]);
  });
});

describe('the unit figure rule (AC-E4, AC-P3)', () => {
  it('fails a figure with each listed unit and with a currency sign', () => {
    expect(caseFindings(unitFigureRule, 'unit-figure', [
      '<p>Closed in 40%.</p>', '<p>Closed in 120 ms.</p>', '<p>Closed in 8 s.</p>', '<p>Closed in 8 sec.</p>',
      '<p>Closed in 8 seconds.</p>', '<p>Closed in 2 min.</p>', '<p>Closed in 2 minutes.</p>', '<p>It cost 3 USD.</p>',
      '<p>It cost 3 EUR.</p>', '<p>It cost $3.</p>', '<p>It cost &euro;3.</p>',
    ])).not.toEqual([]);
  });

  it('passes the same figure under a provenance label and an SES threshold beside its link', () => {
    const clean = casesSite([
      '<p data-provenance="generated">Closed in 120 ms.</p>',
      `<p>SES reviews an account at a bounce rate of 5%, per <a href="${REPUTATION}">the reputation page</a>.</p>`,
      '<p>Records expire 30 days after the send; 3 steps and 9 of 40 sends.</p>',
    ]);
    expect(unitFigureRule(clean, context)).toEqual([]);
  });
});

describe('the banned name rule (AC-1, AC-P15)', () => {
  it('fails each banned name', () => {
    expect(caseFindings(bannedNameRule, 'banned-name', BANNED_NAMES.map((name) => `<p>Compare with the ${name.toLowerCase()} recipe.</p>`))).not.toEqual([]);
  });

  it('passes a page naming only SES and Amazon Bedrock AgentCore', () => {
    expect(bannedNameRule(casesSite(['<p>The agent runs on Amazon Bedrock AgentCore and reads Amazon SES events.</p>']), context)).toEqual([]);
  });
});

describe('the region claim and exact-30-days rules (AC-E14, AC-P12)', () => {
  it('fails an all-data-in-eu-central-1 sentence and an everything-stays-in-Frankfurt sentence', () => {
    expect(caseFindings(regionClaimRule, 'region-claim', ['<p>All data stays in eu-central-1.</p>', '<p>Everything stays in Frankfurt.</p>'])).not.toEqual([]);
  });

  it('passes the separate event-record and model-request sentences', () => {
    const clean = casesSite(['<p>Event records are stored in eu-central-1.</p><p>Model requests go through the EU inference profile in EU Regions.</p>']);
    expect(regionClaimRule(clean, context)).toEqual([]);
  });

  it('fails a deleted-exactly-30-days sentence', () => {
    expect(caseFindings(exactThirtyDaysRule, 'exact-30-days', ['<p>Records are deleted exactly 30 days after the send.</p>', '<p>Records are deleted 30 days after the send.</p>'])).not.toEqual([]);
  });

  it('passes expiry at 30 days with deletion within a few days after it', () => {
    expect(exactThirtyDaysRule(casesSite(['<p>Records expire 30 days after the send and are deleted within a few days after that.</p>']), context)).toEqual([]);
  });
});

describe('the pre-R6 words rule (AC-31, D-146)', () => {
  it('fails APPLIES, DOES NOT APPLY, falls on, SendingPausedException and docs/reopen-a-lane.md', () => {
    expect(caseFindings(preR6WordsRule, 'pre-r6-words', [
      '<p>Article 50(1) APPLIES.</p>',
      '<p>Article 50(2) DOES NOT APPLY.</p>',
      '<p>The duty falls on the deployer.</p>',
      '<p>A send fails with SendingPausedException.</p>',
      '<p>See <a href="/docs/reopen-a-lane.md">the reopen page</a>.</p>',
    ])).not.toEqual([]);
  });

  it('passes ordinary lower-case wording', () => {
    expect(preR6WordsRule(casesSite(['<p>The cap applies to every lane, and the lane falls quiet.</p>']), context)).toEqual([]);
  });
});

describe('the forms, cookies and analytics rule (AC-58, AC-P11)', () => {
  it('fails a form, a text input, a fourth radio, a cookie write, a Set-Cookie header and a tag manager script', () => {
    const radio = '<input type="radio" name="theme">';
    const findings = formsCookiesAnalyticsRule(siteOf({
      'form/index.html': page('<form><button>go</button></form>'),
      'input/index.html': page('<input type="text" name="q">'),
      'radio/index.html': page(radio.repeat(4)),
      'cookie/index.html': page('<script>document.cookie = "a=1";</script>'),
      'tag/index.html': page('<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'),
      '_headers': '/*\n  Set-Cookie: a=1\n',
    }), context);
    expect(findings.every((finding) => finding.rule === 'forms-cookies-analytics')).toBe(true);
    expect(findings.map((finding) => finding.route).sort()).toEqual(['/cookie/', '/form/', '/input/', '/radio/', '/tag/', 'file:_headers'].sort());
  });

  it('fails a built script file that writes document.cookie', () => {
    const findings = formsCookiesAnalyticsRule(siteOf({ 'index.html': page('<p>clean</p>'), '_astro/app.js': 'document.cookie="x=1"' }), context);
    expect(findings.map((finding) => finding.route)).toEqual(['file:_astro/app.js']);
  });

  it('passes the three theme radios, a same-origin script and plain headers', () => {
    const clean = siteOf({
      'index.html': page('<fieldset><legend>Colour theme</legend><input type="radio" name="theme"><input type="radio" name="theme"><input type="radio" name="theme"></fieldset><script src="/_astro/app.js"></script>'),
      '_astro/app.js': 'const theme = localStorage.getItem("fothering-theme");',
      '_headers': '/*\n  X-Content-Type-Options: nosniff\n',
    });
    expect(formsCookiesAnalyticsRule(clean, context)).toEqual([]);
  });
});

describe('the third-party reference rule (AC-59 static half, AC-E49)', () => {
  it('fails a stylesheet link, a font url() in built CSS, an @import to another host and a protocol-relative src', () => {
    const findings = thirdPartyReferenceRule(siteOf({
      'link/index.html': page('<p>x</p>', '<title>t</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Text">'),
      'src/index.html': page('<img src="//cdn.example.net/a.png" alt="">'),
      'fonts.css': '@font-face { font-family: "Red Hat Text"; src: url("https://fonts.gstatic.com/a.woff2") format("woff2"); }',
      'import.css': '@import "https://cdn.example.net/reset.css";',
    }), context);
    expect(findings.every((finding) => finding.rule === 'third-party-reference')).toBe(true);
    expect(findings.map((finding) => finding.route).sort()).toEqual(['/link/', '/src/', 'file:fonts.css', 'file:import.css'].sort());
  });

  it('passes a same-origin path, a data: URI, a canonical link and an anchor to another origin', () => {
    const clean = siteOf({
      'index.html': page(
        '<a href="https://docs.aws.amazon.com/ses/">SES docs</a><img src="/_astro/a.png" srcset="/_astro/a.png 1x, data:image/png;base64,AAAA 2x" alt="">',
        '<title>t</title><link rel="canonical" href="https://fothering.site/"><link rel="stylesheet" href="/tokens.css">',
      ),
      'tokens.css': '@font-face { src: url("/_astro/red-hat-text.woff2"); } .x { background: url(data:image/png;base64,AAAA); }',
    });
    expect(thirdPartyReferenceRule(clean, context)).toEqual([]);
  });
});

describe('the rules over the less common shapes', () => {
  it('fails a third-party url() in an inline style element and in a style attribute, and a preload link to another host', () => {
    const findings = thirdPartyReferenceRule(siteOf({
      'style/index.html': page('<style>.a { background: url("https://cdn.example.net/a.png"); }</style><p>x</p>'),
      'attr/index.html': page('<p style="background: url(//cdn.example.net/b.png)">x</p>'),
      'preload/index.html': page('<p>x</p>', '<title>t</title><link rel="preload" as="font" href="https://fonts.gstatic.com/a.woff2">'),
    }), context);
    expect(findings.map((finding) => finding.route).sort()).toEqual(['/attr/', '/preload/', '/style/']);
  });

  it('fails an input with no type, an inline gtag call, a link to an analytics host and a built script naming a tag manager', () => {
    const findings = formsCookiesAnalyticsRule(siteOf({
      'untyped/index.html': page('<input name="q">'),
      'inline/index.html': page('<script>gtag("config", "G-1");</script>'),
      'link/index.html': page('<p>x</p>', '<title>t</title><link rel="preconnect" href="https://plausible.io">'),
      '_astro/tag.js': 'const s = "https://www.googletagmanager.com/gtm.js";',
    }), context);
    expect(findings.map((finding) => finding.route).sort()).toEqual(['/inline/', '/link/', '/untyped/', 'file:_astro/tag.js']);
    expect(findings.find((finding) => finding.route === '/untyped/')?.text).toBe('an input of type text');
  });

  it('reports a hit deep in a long page as an excerpt marked at both ends, and clips a long element', () => {
    const filler = 'the lane stays open while the guard reads its events. '.repeat(4);
    const site = casesSite([`<p>${filler}Your SES bounce rate went up. ${filler}</p>`, `<p>${filler}SES reviews an account at 5% bounces. ${filler}</p>`]);
    const wording = sesRateWordingRule(site, context)[0]?.text ?? '';
    expect(wording.startsWith('...') && wording.endsWith('...')).toBe(true);
    expect(sesPercentageLinkRule(site, context)[0]?.text.endsWith('...')).toBe(true);
  });

  it('reports a list item holding a quoting paragraph once, at the paragraph', () => {
    const findings = sesPercentageLinkRule(casesSite(['<ul><li><p>SES reviews an account at 5% bounces.</p></li></ul>']), context);
    expect(findings).toHaveLength(1);
  });
});

const TWO_SHEETS = { 'index.html': '<p>landing</p>', 'replay/index.html': '<p>replay</p>' };

describe('the page metadata rule (AC-49, AC-E37)', () => {
  it('passes a site whose every route, the 404 page included, carries the six items with its own title and description', () => {
    expect(pageMetadataRule(siteOf(completeSite({ ...TWO_SHEETS, '404.html': '<p>none</p>' })), context)).toEqual([]);
  });

  for (const item of SHEET_HEAD_ITEMS) {
    it(`fails a route without ${item}, naming the route and the item`, () => {
      const findings = pageMetadataRule(siteOf(completeSite(TWO_SHEETS, { 'replay/index.html': { omit: [item] } })), context);
      expect(findings.map((finding) => [finding.rule, finding.route])).toEqual([['page-metadata', '/replay/']]);
      expect(findings[0]?.text).toContain(item);
    });
  }

  it('fails a description whose content is blank', () => {
    const findings = pageMetadataRule(siteOf(completeSite(TWO_SHEETS, { 'replay/index.html': { description: '  ' } })), context);
    expect(findings.map((finding) => finding.text)).toContain('the page has no meta name="description" with content');
  });

  it('reads the head title, never an SVG title inside a drawing', () => {
    const findings = pageMetadataRule(siteOf(completeSite({ 'index.html': '<svg><title>Lane drawing</title></svg>' }, { 'index.html': { omit: ['title'] } })), context);
    expect(findings.map((finding) => finding.text)).toEqual(['the page has no title']);
  });

  it('fails two routes sharing a title, naming the second and the first', () => {
    const findings = pageMetadataRule(siteOf(completeSite(TWO_SHEETS, { 'replay/index.html': { title: 'Planted sheet /' } })), context);
    expect(findings.map((finding) => [finding.route, finding.text])).toEqual([['/replay/', 'the title "Planted sheet /" is also the title of /']]);
  });

  it('fails two routes sharing a description, naming the second and the first', () => {
    const findings = pageMetadataRule(siteOf(completeSite(TWO_SHEETS, { 'replay/index.html': { description: 'What the planted sheet at / holds.' } })), context);
    expect(findings.map((finding) => [finding.route, finding.text])).toEqual([['/replay/', 'the description "What the planted sheet at / holds." is also the description of /']]);
  });
});

const sitemapOf = (paths: readonly string[]): string => renderSitemap(paths.map((path) => ({ path, indexable: true })));
const without = (files: Readonly<Record<string, string>>, name: string): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([file]) => file !== name));
const sitemapFindings = (sitemap: string | null): Finding[] => {
  const rest = without(completeSite(TWO_SHEETS), 'sitemap.xml');
  return sitemapRule(siteOf(sitemap === null ? rest : { ...rest, 'sitemap.xml': sitemap }), context);
};

describe('the sitemap rule (AC-50, AC-E38, AC-E39)', () => {
  it('passes a sitemap listing every built route once, from the same build, with the 404 page left out', () => {
    expect(sitemapRule(siteOf(completeSite({ ...TWO_SHEETS, '404.html': '<p>none</p>' })), context)).toEqual([]);
  });

  it('fails a build with no sitemap', () => {
    expect(sitemapFindings(null)).toEqual([{ rule: 'sitemap', route: 'file:sitemap.xml', text: 'dist/sitemap.xml is missing' }]);
  });

  it('fails a sitemap listing zero URLs', () => {
    expect(sitemapFindings('<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>')).toEqual([{ rule: 'sitemap', route: 'file:sitemap.xml', text: 'the sitemap lists zero URLs' }]);
  });

  it('fails a sitemap listing a route the build lacks', () => {
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/ghost/'])).map((finding) => finding.text)).toEqual(['the sitemap lists /ghost/, which the build lacks']);
  });

  it('fails a sitemap listing a built route twice', () => {
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/'])).map((finding) => finding.text)).toEqual(['the sitemap lists / 2 times']);
  });

  it('fails a sitemap listing the 404 page', () => {
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/404.html'])).map((finding) => finding.text)).toEqual(['the sitemap lists the 404 page at /404.html']);
  });

  it('fails a built route missing from the sitemap, at that route', () => {
    expect(sitemapFindings(sitemapOf(['/']))).toEqual([{ rule: 'sitemap', route: '/replay/', text: '/replay/ is a built route missing from the sitemap' }]);
  });

  it('fails a relative URL and a URL on another origin', () => {
    const xml = `<urlset><url><loc>/</loc></url><url><loc>https://elsewhere.example/replay/</loc></url><url><loc>${SITE_ORIGIN}/</loc></url><url><loc>${SITE_ORIGIN}/replay/</loc></url></urlset>`;
    expect(sitemapFindings(xml).map((finding) => finding.text)).toEqual([
      `/ is not an absolute URL on ${SITE_ORIGIN}`,
      `https://elsewhere.example/replay/ is not an absolute URL on ${SITE_ORIGIN}`,
    ]);
  });

  it('leaves out a built route the route list marks not indexable', () => {
    const site = siteOf({ ...completeSite(TWO_SHEETS), 'sitemap.xml': sitemapOf(['/']) });
    const draft = { path: '/replay/', sheet: 'FTH-002', label: 'Replay', title: 't', description: 'd', indexable: false };
    expect(sitemapRule(site, { ...context, routes: [draft] })).toEqual([]);
  });
});

describe('the robots rule (AC-51)', () => {
  const robotsFindings = (robots: string | null): Finding[] => {
    const rest = without(completeSite(TWO_SHEETS), 'robots.txt');
    return robotsRule(siteOf(robots === null ? rest : { ...rest, 'robots.txt': robots }), context);
  };

  it('passes the rendered robots.txt', () => {
    expect(robotsFindings(renderRobots())).toEqual([]);
  });

  it('fails a build with no robots.txt', () => {
    expect(robotsFindings(null)).toEqual([{ rule: 'robots', route: 'file:robots.txt', text: 'dist/robots.txt is missing' }]);
  });

  it('fails robots.txt without Allow: /', () => {
    expect(robotsFindings(renderRobots().replace('Allow: /\n', '')).map((finding) => finding.text)).toEqual(['robots.txt has no "Allow: /" line']);
  });

  it('fails robots.txt without User-agent: *', () => {
    expect(robotsFindings(renderRobots().replace('User-agent: *\n', '')).map((finding) => finding.text)).toEqual(['robots.txt has no "User-agent: *" line']);
  });

  it('fails robots.txt that names no sitemap or the sitemap on another origin', () => {
    const expected = [`robots.txt does not name the sitemap at ${SITE_ORIGIN}/sitemap.xml`];
    expect(robotsFindings('User-agent: *\nAllow: /\n').map((finding) => finding.text)).toEqual(expected);
    expect(robotsFindings('User-agent: *\nAllow: /\nSitemap: https://elsewhere.example/sitemap.xml\n').map((finding) => finding.text)).toEqual(expected);
  });
});

const ONE_SHEET = { 'index.html': '<p>landing</p>' };
const withFile = (name: string, text: string | null): Record<string, string> => {
  const rest = without(completeSite(ONE_SHEET), name);
  return text === null ? rest : { ...rest, [name]: text };
};
const sheetWithHead = (theme: string): Record<string, string> => completeSite(ONE_SHEET, { 'index.html': { theme } });
const texts = (findings: readonly Finding[]): string[] => findings.map((finding) => finding.text);
const DARK_MEDIA = '@media (prefers-color-scheme: dark) {';

describe('the theme token blocks rule (AC-39, D-140)', () => {
  it('passes the rendered tokens.css', () => {
    expect(themeTokenBlocksRule(siteOf(completeSite(ONE_SHEET)), context)).toEqual([]);
  });

  it('fails a build with no tokens.css', () => {
    expect(themeTokenBlocksRule(siteOf(withFile('tokens.css', null)), context)).toEqual([{ rule: 'theme-token-blocks', route: 'file:tokens.css', text: 'dist/tokens.css is missing' }]);
  });

  it('fails dark blocks whose declarations differ', () => {
    const css = renderTokensCss().replace(`:root[data-theme="dark"] {\n  color-scheme: dark;\n  --ground: #0F1316;`, `:root[data-theme="dark"] {\n  color-scheme: dark;\n  --ground: #000000;`);
    expect(css).not.toBe(renderTokensCss());
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', css)), context))).toEqual(['the dark blocks under the media query and under :root[data-theme="dark"] differ']);
  });

  it('fails a missing media block, a missing pinned block and a light block without color-scheme light', () => {
    const noMedia = renderTokensCss().replace(DARK_MEDIA, '@media (min-width: 1px) {');
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', noMedia)), context))).toEqual(['tokens.css has no :root:not([data-theme="light"]) block under @media (prefers-color-scheme: dark)']);
    const noPinned = renderTokensCss().replace(':root[data-theme="dark"]', ':root[data-theme="night"]');
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', noPinned)), context))).toEqual(['tokens.css has no :root[data-theme="dark"] block']);
    const noLight = renderTokensCss().replace('color-scheme: light', 'color-scheme: normal');
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', noLight)), context))).toEqual(['the :root block does not declare color-scheme: light']);
  });

  it('fails dark blocks without color-scheme dark, and a dark token the light block never declares', () => {
    const noScheme = renderTokensCss().replaceAll('color-scheme: dark;', 'color-scheme: only dark;');
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', noScheme)), context))).toEqual(['the dark blocks do not declare color-scheme: dark']);
    const stray = renderTokensCss().replaceAll('color-scheme: dark;', 'color-scheme: dark;\n  --stray: #000000;');
    expect(texts(themeTokenBlocksRule(siteOf(withFile('tokens.css', stray)), context))).toEqual(['the dark blocks declare --stray, which the :root block does not']);
  });
});

describe('the type token rule (AC-63 declaration half)', () => {
  it('passes the rendered tokens.css', () => {
    expect(typeTokenDeclaredRule(siteOf(completeSite(ONE_SHEET)), context)).toEqual([]);
  });

  it('fails a build with no tokens.css', () => {
    expect(texts(typeTokenDeclaredRule(siteOf(withFile('tokens.css', null)), context))).toEqual(['dist/tokens.css is missing']);
  });

  it.each(['--text-lede', '--text-intro', '--text-narrative-headline', '--text-small', '--text-mono-value', '--text-schedule-compact'])('fails a tokens.css without %s on :root', (name) => {
    const css = renderTokensCss().replace(new RegExp(`\\n  ${name}: [^;]*;`), '');
    expect(css).not.toBe(renderTokensCss());
    expect(texts(typeTokenDeclaredRule(siteOf(withFile('tokens.css', css)), context))).toEqual([`tokens.css declares no ${name} on :root`]);
  });

  it('fails --text-small and --text-mono-value at any size but 0.9375rem and 0.8125rem', () => {
    const css = renderTokensCss().replace('--text-small: 0.9375rem', '--text-small: 15px').replace('--text-mono-value: 0.8125rem', '--text-mono-value: 0.8rem');
    expect(texts(typeTokenDeclaredRule(siteOf(withFile('tokens.css', css)), context))).toEqual([
      '--text-small is 15px, 0.9375rem expected',
      '--text-mono-value is 0.8rem, 0.8125rem expected',
    ]);
  });
});

describe('the head script order rule (AC-40, Pitfall 4)', () => {
  it('passes the layout head on every page', () => {
    expect(headScriptOrderRule(siteOf(completeSite({ ...ONE_SHEET, '404.html': '<p>none</p>' })), context)).toEqual([]);
  });

  it('fails a theme script that follows a stylesheet link', () => {
    const head = `<link rel="stylesheet" href="/tokens.css"><script>${HEAD_SCRIPT}</script>`;
    expect(texts(headScriptOrderRule(siteOf(sheetWithHead(head)), context))).toEqual(['the theme script follows a stylesheet link']);
  });

  it.each(['defer', 'async', 'type="module"'])('fails a theme script carrying %s', (attribute) => {
    const head = `<script ${attribute}>${HEAD_SCRIPT}</script><link rel="stylesheet" href="/tokens.css">`;
    expect(texts(headScriptOrderRule(siteOf(sheetWithHead(head)), context))).toEqual([`the theme script carries ${attribute}`]);
  });

  it('fails a head with no inline script and one whose inline script is not HEAD_SCRIPT', () => {
    expect(texts(headScriptOrderRule(siteOf(sheetWithHead('<link rel="stylesheet" href="/tokens.css">')), context))).toEqual(['the head holds no inline theme script']);
    const altered = `<script>${HEAD_SCRIPT.replace('fothering-theme', 'other-theme')}</script><link rel="stylesheet" href="/tokens.css">`;
    expect(texts(headScriptOrderRule(siteOf(sheetWithHead(altered)), context))).toEqual(['the inline head script is not the HEAD_SCRIPT text']);
  });

  it('reads only the head: an inline script in the body is not the theme script', () => {
    const site = siteOf(completeSite({ 'index.html': `<script>${HEAD_SCRIPT}</script>` }, { 'index.html': { theme: '<link rel="stylesheet" href="/tokens.css">' } }));
    expect(texts(headScriptOrderRule(site, context))).toEqual(['the head holds no inline theme script']);
  });
});

describe('the script hash rule (D-149, C6, T-05-21, T-05-24)', () => {
  it('passes inline scripts whose hashes equal the set in _headers', () => {
    expect(scriptHashRule(siteOf(completeSite({ ...ONE_SHEET, '404.html': '<p>none</p>' })), context)).toEqual([]);
  });

  it('fails an inline script whose hash _headers lacks, at its route', () => {
    const findings = scriptHashRule(siteOf(completeSite({ 'index.html': '<script>window.planted = 1;</script>' })), context);
    expect(findings.map((finding) => finding.route)).toEqual(['/']);
    expect(findings[0]?.text).toMatch(/^an inline script hashes to sha256-[A-Za-z0-9+/=]+, which _headers does not list$/);
  });

  it('fails a hash in _headers that no inline script has', () => {
    const headers = HEADERS_TEXT.replace(`'sha256-${headScriptHash()}'`, `'sha256-${headScriptHash()}' 'sha256-AAAA'`);
    expect(scriptHashRule(siteOf(withFile('_headers', headers)), context)).toEqual([{ rule: 'script-hash', route: 'file:_headers', text: '_headers lists sha256-AAAA, which no inline script has' }]);
  });

  it('fails a build with no _headers and one whose _headers has no script-src', () => {
    expect(texts(scriptHashRule(siteOf(withFile('_headers', null)), context))).toEqual(['dist/_headers is missing']);
    const findings = scriptHashRule(siteOf(withFile('_headers', '/*\n  X-Frame-Options: DENY\n')), context);
    expect(findings.map((finding) => finding.route)).toEqual(['/']);
  });
});

describe('the inline style rule (C6)', () => {
  it('passes a site with no style attribute, style element or data: URL', () => {
    expect(noInlineStyleRule(siteOf(completeSite({ 'index.html': '<p>plain</p><img src="/a.png" alt="a">' })), context)).toEqual([]);
  });

  it('fails a style attribute, also inside SVG, and a style element, at the route', () => {
    const site = siteOf(completeSite({ 'index.html': '<p style="color: red">x</p><svg><rect style="fill: red"/></svg><style>p { color: red }</style>' }));
    expect(texts(noInlineStyleRule(site, context))).toEqual(['a style attribute on <p>', 'a style attribute on <rect>', 'a style element']);
  });

  it('fails a data: URL in an attribute and in built CSS', () => {
    const site = siteOf({ ...completeSite({ 'index.html': '<img src="data:image/png;base64,AAAA" alt="a"><img srcset="/a.png 1x, DATA:image/png;base64,AAAA 2x" alt="b">' }), '_astro/site.css': 'p { background: url("data:image/png;base64,AAAA") }' });
    expect(noInlineStyleRule(site, context).map((finding) => [finding.route, finding.text])).toEqual([
      ['/', 'img src holds a data: URL'],
      ['/', 'img srcset holds a data: URL'],
      ['file:_astro/site.css', 'a CSS url() holds a data: URL'],
    ]);
  });
});

describe('the built layout head (05-08 wiring)', () => {
  it('a planted sheet carries the theme head before its metadata', () => {
    expect(completeSite(ONE_SHEET)['index.html']).toContain(`<head><meta charset="utf-8">${THEME_HEAD}<title>`);
  });
});

describe('the guard is read-only and repeatable (AC-E45, AC-E47)', () => {
  const files = { 'index.html': page('<p>closed &mdash; one lane, your bounce rate, 40%</p>'), 'tokens.css': ':root {}' };

  it('gives equal findings on a second run and leaves the planted bytes unchanged', () => {
    const tree = plant(files);
    const before = filesIn(tree.dist).map((file) => readFileSync(join(tree.dist, file)));
    const first = runBuiltChecks(loadBuiltSite(tree.dist), context);
    const second = runBuiltChecks(loadBuiltSite(tree.dist), context);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(second).toEqual(first);
    expect(filesIn(tree.dist).map((file) => readFileSync(join(tree.dist, file)))).toEqual(before);
  });

  it('gives equal findings from two runs started together', async () => {
    const tree = plant(files);
    const run = (): Promise<Finding[]> => Promise.resolve().then(() => runBuiltChecks(loadBuiltSite(tree.dist), context));
    const [first, second] = await Promise.all([run(), run()]);
    expect(second).toEqual(first);
  });
});

describe('checkFileBudget (AC-62, AC-E48)', () => {
  const files = (count: number): { path: string; bytes: number }[] => Array.from({ length: count }, (_, index) => ({ path: `f${index}.html`, bytes: 1 }));

  it('passes 19,999 files and fails 20,000', () => {
    expect(checkFileBudget(files(19_999))).toEqual([]);
    expect(checkFileBudget(files(20_000))).toEqual([{ kind: 'count', count: 20_000, limit: 20_000 }]);
  });

  it('passes a file of 26,214,399 bytes and fails one of 26,214,400', () => {
    expect(checkFileBudget([{ path: 'big.js', bytes: 26_214_399 }])).toEqual([]);
    expect(checkFileBudget([{ path: 'big.js', bytes: 26_214_400 }])).toEqual([{ kind: 'size', path: 'big.js', bytes: 26_214_400, limit: 26_214_400 }]);
  });
});
