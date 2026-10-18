import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accessibilityBody,
  commandBlock,
  completeSite,
  handCheckRow,
  DEPLOY_FACTS,
  deployBody,
  HEADERS_TEXT,
  landingBody,
  forgetSentence,
  LIMITS_ROWS,
  limitsRow,
  limitsSection,
  modelRoleList,
  page,
  permissionRow,
  plantDist,
  privacyBody,
  rightsSentence,
  statementParagraph,
  storedFieldRow,
  REPLAY_LIMITS_STATE,
  REPLAY_VIEW,
  replayBody,
  replayPanels,
  replaySummary,
  REPO_ROOT,
  resourceRow,
  resourceTable,
  roleSections,
  SHEET_HEAD_ITEMS,
  THEME_HEAD,
  THEME_SWITCH,
  TYPE_TOKEN_CSS,
  type PlantedDist,
} from '../test/planted-dist.js';
import type { ReplayView } from '../site/replay-view.js';
import { loadCheckContext } from '../harness/gates.js';
import { HEAD_SCRIPT, headScriptHash, renderTokensCss } from '../theme/head-script.js';
import {
  accessibilityStatements,
  BANNED_NAMES,
  CONSOLE_DELETE_PHRASES,
  HAND_CHECK_CRITERIA,
  HAND_CHECK_RESULT_LABELS,
  LANDING_SECTIONS,
  LEDE_TERMS,
  LIMITS_FIXED_ROWS,
  REPLY_PROMISE_PHRASES,
  type Statement,
} from '../site/content.js';
import { PROVENANCE_LABELS } from '../site/labels.js';
import { PERMISSION_REASONS, permissionKey, permissionSchedules } from '../site/permissions-view.js';
import { removedByText } from '../site/repo-facts.js';
import { resourceRows } from '../site/resources-view.js';
import { renderRobots, renderSitemap, SITE_ORIGIN } from '../site/route-list.js';
import { filesIn, loadBuiltSite, NOT_FOUND_ROUTE, NoBuiltPagesError, type BuiltSite } from './built-site.js';
import {
  ACCESSIBILITY_ROUTE,
  accessibilityPageRule,
  accessibilityStatementRule,
  bannedNameRule,
  checkFileBudget,
  consoleDeleteRule,
  countReplayWords,
  countWords,
  dashRule,
  DEPLOY_ROUTE,
  deployCommandsRule,
  deployDenyRule,
  deployNoticeRule,
  deployPageRule,
  deployPermissionsRule,
  deployResourcesRule,
  exactThirtyDaysRule,
  forgetCommandRule,
  formsCookiesAnalyticsRule,
  headScriptOrderRule,
  identifierBreakRule,
  landingSectionsRule,
  ledeRule,
  limitsRule,
  modelIdRule,
  modelRoleForbiddenRule,
  modelRolePresentRule,
  modelRoleRequiredRule,
  noDeleteControlRule,
  noEllipsisRule,
  noInlineStyleRule,
  oneCallerRule,
  pageMetadataRule,
  preR6WordsRule,
  PRIVACY_ROUTE,
  privacyPageRule,
  privacyStatementsRule,
  provenanceWordingRule,
  providerLabelRule,
  regionClaimRule,
  REPLAY_ROUTE,
  replayLanesRule,
  replayPageRule,
  replayPanelsRule,
  replaySummaryRule,
  replayWordCountRule,
  replyPromiseRule,
  robotsRule,
  RULE_IDS,
  runBuiltChecks,
  scriptHashRule,
  sesPercentageLinkRule,
  sesRateWordingRule,
  sitemapRule,
  sixRightsRule,
  storedFieldRowsRule,
  switchMarkupRule,
  themeTokenBlocksRule,
  thirdPartyReferenceRule,
  typeTokenDeclaredRule,
  typeTokenUseRule,
  unitFigureRule,
  websiteFactsRule,
  type DeployFacts,
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

  it('holds exactly the fifty-five rule ids the plans name', () => {
    expect([...RULE_IDS].sort()).toEqual([
      'accessibility-page', 'accessibility-statement', 'banned-name', 'command-pair', 'console-delete', 'dash', 'deploy-commands', 'deploy-deny', 'deploy-notice', 'deploy-page', 'deploy-permissions', 'deploy-resources',
      'exact-30-days', 'forget-command', 'forms-cookies-analytics', 'head-script-order', 'identifier-break', 'landing-sections', 'lede', 'limits',
      'model-id', 'model-role-forbidden', 'model-role-present', 'model-role-required',
      'no-delete-control', 'no-ellipsis', 'no-inline-style', 'one-caller', 'page-metadata', 'pre-r6-words', 'privacy-page', 'privacy-statements', 'provenance-wording', 'provider-label', 'region-claim', 'replay-lanes',
      'replay-page', 'replay-panels', 'replay-summary', 'replay-word-count', 'reply-promise', 'robots', 'script-hash',
      'ses-percentage-link', 'ses-rate-wording', 'sitemap', 'six-rights', 'stored-field-rows', 'switch-markup', 'theme-token-blocks', 'third-party-reference', 'type-token-declared',
      'type-token-use', 'unit-figure', 'website-facts',
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

// An API operation name in word mode, and the replay log row and Detail cell that may hold it.
const WORD_MODE = '<code class="identifier" data-identifier data-identifier-words><span>Put</span><wbr><span>Configuration</span><wbr><span>Set</span></code>';
const logCell = (inner: string, column = 'Detail', step = ' data-log-step="3"'): string => `<table><tbody><tr${step}><td data-col="${column}">${inner}</td></tr></tbody></table>`;

describe('the identifier break rule (AC-65, AC-E55, UI-SPEC line 208)', () => {
  it('passes a word-boundary break inside a replay log Detail cell, and a break after a dot anywhere', () => {
    const dotted = '<p><code class="identifier" data-identifier><span>SendingOptions.</span><wbr><span>SendingEnabled</span></code></p>';
    expect(identifierBreakRule(casesSite([logCell(WORD_MODE), dotted]), context)).toEqual([]);
  });

  // Each finding as one line, so a failing case reads as one string.
  const named = (findings: readonly Finding[]): string => findings.map((finding) => `${finding.route} ${finding.text}`).join(' | ');
  const OUTSIDE = 'the identifier PutConfigurationSet may break after "Put", and outside a replay log Detail cell only a dot may end an identifier\'s line';

  it('fails the same word-boundary break outside a replay log Detail cell', () => {
    const findings = identifierBreakRule(casesSite([`<p>${WORD_MODE}</p>`, logCell(WORD_MODE, 'Lane'), logCell(WORD_MODE, 'Detail', '')]), context);
    expect(named(findings.filter((finding) => finding.text.includes('"Put"')))).toBe(['/case-0/', '/case-1/', '/case-2/'].map((route) => `${route} ${OUTSIDE}`).join(' | '));
    expect(findings.every((finding) => finding.rule === 'identifier-break')).toBe(true);
  });

  it('fails a break after a part with no dot in an identifier not in word mode, even in a log Detail cell', () => {
    const plain = '<code class="identifier" data-identifier><span>Put</span><wbr><span>Configuration</span></code>';
    expect(named(identifierBreakRule(casesSite([logCell(plain)]), context))).toBe('/case-0/ the identifier PutConfiguration may break after "Put", and only a dot may end an identifier\'s line');
  });
});

// A command block as the CommandBlock component renders it: each unit a span directly in the code
// element, a flag and its value one span holding the two token spans.
const unitSpan = (unit: string): string => (unit.includes(' ') ? `<span>${unit.split(' ').map((token) => `<span>${token}</span>`).join(' ')}</span>` : `<span>${unit}</span>`);
const commandMarkup = (lines: readonly (readonly string[])[]): string => `<pre class="command"><code>${lines.map((units) => units.map(unitSpan).join(' ')).join('\n')}</code></pre>`;
const commandPairFindings = (bodies: readonly string[]): string[] => runBuiltChecks(casesSite(bodies), context)
  .filter((finding) => String(finding.rule) === 'command-pair').map((finding) => `${finding.route} ${finding.text}`);

describe('the command pair rule (UI-SPEC line 209, the 05-12 finish review)', () => {
  it('passes a flag and its value in one unit, a flag before a flag, and a flag that ends a line', () => {
    expect(commandPairFindings([
      commandMarkup([['npx', 'cdk', 'deploy', '--all', '-c fothering:live=live']]),
      commandMarkup([['aws', '--configuration-set-name fothering-bulk', '--sending-enabled', '--region eu-central-1']]),
      commandMarkup([['npm', 'run', 'build', '--'], ['fothering']]),
    ])).toEqual([]);
  });

  it('fails a flag and its value in separate units, as the deploy page renders the live switch today', () => {
    expect(commandPairFindings([commandMarkup([['npx', 'cdk', 'deploy', '--all', '-c', 'fothering:live=live']])]))
      .toEqual(['/case-0/ the command block keeps the flag -c apart from its value fothering:live=live, so a line can end between them']);
  });

  it('fails anything but one space or a line break between units or inside a pair, and text outside the code', () => {
    const doubled = '<pre class="command"><code><span>npx</span>  <span>cdk</span></code></pre>';
    const inPair = '<pre class="command"><code><span><span>-c</span>,<span>x</span></span></code></pre>';
    const outside = '<pre class="command"><code><span>npx</span></code>#</pre>';
    expect(commandPairFindings([doubled, inPair, outside])).toEqual([
      '/case-0/ the command block holds "  " between its units, where only one space or a line break belongs, so the copied text is not the command',
      '/case-1/ the command block holds "," between its units, where only one space or a line break belongs, so the copied text is not the command',
      '/case-2/ the command block holds "#" outside its code element, so the copied text is not the command',
    ]);
  });
});

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
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/privacy-and-ai/', '/deploy/', '/accessibility/', '/ghost/'])).map((finding) => finding.text)).toEqual(['the sitemap lists /ghost/, which the build lacks']);
  });

  it('fails a sitemap listing a built route twice', () => {
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/privacy-and-ai/', '/deploy/', '/accessibility/', '/'])).map((finding) => finding.text)).toEqual(['the sitemap lists / 2 times']);
  });

  it('fails a sitemap listing the 404 page', () => {
    expect(sitemapFindings(sitemapOf(['/', '/replay/', '/privacy-and-ai/', '/deploy/', '/accessibility/', '/404.html'])).map((finding) => finding.text)).toEqual(['the sitemap lists the 404 page at /404.html']);
  });

  it('fails a built route missing from the sitemap, at that route', () => {
    expect(sitemapFindings(sitemapOf(['/', '/privacy-and-ai/', '/deploy/', '/accessibility/']))).toEqual([{ rule: 'sitemap', route: '/replay/', text: '/replay/ is a built route missing from the sitemap' }]);
  });

  it('fails a relative URL and a URL on another origin', () => {
    const xml = `<urlset><url><loc>/</loc></url><url><loc>https://elsewhere.example/replay/</loc></url><url><loc>${SITE_ORIGIN}/</loc></url><url><loc>${SITE_ORIGIN}/replay/</loc></url>`
      + `<url><loc>${SITE_ORIGIN}/privacy-and-ai/</loc></url><url><loc>${SITE_ORIGIN}/deploy/</loc></url><url><loc>${SITE_ORIGIN}/accessibility/</loc></url></urlset>`;
    expect(sitemapFindings(xml).map((finding) => finding.text)).toEqual([
      `/ is not an absolute URL on ${SITE_ORIGIN}`,
      `https://elsewhere.example/replay/ is not an absolute URL on ${SITE_ORIGIN}`,
    ]);
  });

  it('leaves out a built route the route list marks not indexable', () => {
    const site = siteOf({ ...completeSite(TWO_SHEETS), 'sitemap.xml': sitemapOf(['/', '/privacy-and-ai/', '/deploy/', '/accessibility/']) });
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
    expect(findings.map((finding) => finding.route)).toEqual(['/', ACCESSIBILITY_ROUTE, DEPLOY_ROUTE, PRIVACY_ROUTE, REPLAY_ROUTE]);
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

const themeRadio = (value: string, label: string, checked = false): string =>
  `<label><input type="radio" name="theme" value="${value}"${checked ? ' checked' : ''}> ${label}</label>`;
const DEVICE_RADIO = themeRadio('device', 'Device', true);
const LIGHT_RADIO = themeRadio('light', 'Light');
const DARK_RADIO = themeRadio('dark', 'Dark');
const themeHeader = (radios: readonly string[], legend = '<legend>Colour theme</legend>'): string => `<header><fieldset>${legend}${radios.join('')}</fieldset></header><p>sheet</p>`;
const switchTexts = (body: string): string[] => texts(switchMarkupRule(siteOf({ 'index.html': page(body) }), context));

describe('the switch markup rule (AC-38, UI-SPEC section 7)', () => {
  it('passes a header holding one fieldset with its legend and Device, Light, Dark, Device checked', () => {
    expect(switchTexts(`${THEME_SWITCH}<p>sheet</p>`)).toEqual([]);
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO]))).toEqual([]);
  });

  it('passes radios labelled through for and id as well as by a wrapping label', () => {
    const radios = [['device', 'Device', ' checked'], ['light', 'Light', ''], ['dark', 'Dark', '']]
      .map(([value, label, checked]) => `<input type="radio" name="theme" value="${value}" id="theme-${value}"${checked}><label for="theme-${value}">${label}</label>`);
    expect(switchTexts(themeHeader(radios))).toEqual([]);
  });

  it('fails a page with no header and a header with no fieldset', () => {
    expect(switchTexts('<p>sheet</p>')).toEqual(['the page has no header element']);
    expect(switchTexts('<header><a href="/">FOTHERING</a></header>')).toEqual(['the header holds no theme fieldset']);
  });

  it('fails a header holding two fieldsets', () => {
    const fieldset = `<fieldset><legend>Colour theme</legend>${DEVICE_RADIO}${LIGHT_RADIO}${DARK_RADIO}</fieldset>`;
    expect(switchTexts(`<header>${fieldset}${fieldset}</header>`)).toEqual(['the header holds 2 fieldsets, 1 expected']);
  });

  it('fails a fieldset with no legend and one whose legend is empty', () => {
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO], ''))).toEqual(['the theme fieldset has no legend']);
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO], '<legend> </legend>'))).toEqual(['the theme fieldset has no legend']);
  });

  it('fails radios out of order', () => {
    expect(switchTexts(themeHeader([LIGHT_RADIO, DEVICE_RADIO, DARK_RADIO]))).toEqual(['the theme radios read Light, Device, Dark; Device, Light, Dark expected']);
  });

  it('fails a fourth radio', () => {
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO, themeRadio('blue', 'Blue')]))).toEqual(['the theme fieldset holds 4 radio inputs, 3 expected']);
  });

  it('fails a Device radio left unchecked, and another radio checked in its place', () => {
    expect(switchTexts(themeHeader([themeRadio('device', 'Device'), LIGHT_RADIO, DARK_RADIO]))).toEqual(['the Device radio is not checked in the markup']);
    expect(switchTexts(themeHeader([themeRadio('device', 'Device'), themeRadio('light', 'Light', true), DARK_RADIO]))).toEqual([
      'the Device radio is not checked in the markup',
      'the Light radio is checked in the markup',
    ]);
  });

  it('fails a radio outside the theme group or with a value its label does not name', () => {
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO.replace('name="theme"', 'name="mode"')]))).toEqual(['the Dark radio is not named theme']);
    expect(switchTexts(themeHeader([DEVICE_RADIO, LIGHT_RADIO, DARK_RADIO.replace('value="dark"', 'value="night"')]))).toEqual(['the Dark radio has the value night, dark expected']);
  });

  it('reports every route that lacks the switch, the 404 page included', () => {
    const site = siteOf({ 'index.html': page('<p>landing</p>'), '404.html': page('<p>none</p>'), 'replay/index.html': page(`${THEME_SWITCH}<p>replay</p>`) });
    expect(switchMarkupRule(site, context).map((finding) => [finding.rule, finding.route])).toEqual([
      ['switch-markup', '/'],
      ['switch-markup', NOT_FOUND_ROUTE],
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

const landingSite = (body: string): BuiltSite => siteOf({ 'index.html': page(body) });
const landingTexts = (rule: RuleFunction, body: string, ruleContext = context): string[] => {
  const findings = rule(landingSite(body), ruleContext);
  expect(findings.every((finding) => finding.route === '/')).toBe(true);
  return texts(findings);
};
const lede = (text: string): string => landingBody({ lede: `<p data-lede>${text}</p>` });
const FULL_LEDE = 'An agent on Amazon Bedrock AgentCore reads what Amazon SES publishes for each configuration set and tells you by email.';

describe('the lede rule (AC-2, AC-E1 to AC-E3)', () => {
  it('passes a lede holding all five terms', () => {
    expect(LEDE_TERMS).toEqual(['agent', 'Amazon Bedrock AgentCore', 'Amazon SES', 'configuration set', 'email']);
    expect(landingTexts(ledeRule, lede(FULL_LEDE))).toEqual([]);
  });

  it('fails a lede naming AgentCore alone', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('Amazon Bedrock AgentCore', 'AgentCore')))).toEqual(['the lede does not name Amazon Bedrock AgentCore as a whole phrase']);
  });

  it('fails a lede naming Amazon Bedrock alone', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('Amazon Bedrock AgentCore', 'Amazon Bedrock')))).toEqual(['the lede does not name Amazon Bedrock AgentCore as a whole phrase']);
  });

  it('fails a lede where agent appears only inside agents or reagent', () => {
    const text = 'Two agents on Amazon Bedrock AgentCore, one reagent, read what Amazon SES publishes for each configuration set and tell you by email.';
    expect(landingTexts(ledeRule, lede(text))).toEqual(['the lede does not name agent as a whole phrase']);
  });

  it('fails a lede missing email', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('by email', 'by mail')))).toEqual(['the lede does not name email as a whole phrase']);
  });

  it('fails a lede missing configuration set', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('each configuration set', 'each lane')))).toEqual(['the lede does not name configuration set as a whole phrase']);
  });

  it('fails an empty lede', () => {
    expect(landingTexts(ledeRule, lede(' &nbsp; ')).join('; ')).toBe('the lede element is empty');
  });

  it('fails a page with no data-lede element', () => {
    expect(landingTexts(ledeRule, landingBody({ lede: `<p>${FULL_LEDE}</p>` }))).toEqual(['the landing has no data-lede element']);
  });

  it('passes Amazon Bedrock AgentCore split by a non-breaking space', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('Amazon Bedrock AgentCore', 'Amazon&nbsp;Bedrock&nbsp;AgentCore')))).toEqual([]);
  });

  it('passes Amazon Bedrock AgentCore split by a line break', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('Amazon Bedrock AgentCore', 'Amazon\nBedrock\n  AgentCore')))).toEqual([]);
  });

  it('passes Amazon Bedrock AgentCore split by an inline span', () => {
    expect(landingTexts(ledeRule, lede(FULL_LEDE.replace('Amazon Bedrock AgentCore', 'Amazon <span>Bedrock</span> AgentCore')))).toEqual([]);
  });

  it('fails a build with no landing page', () => {
    expect(texts(ledeRule(casesSite([`<p data-lede>${FULL_LEDE}</p>`]), context))).toEqual(['the build has no landing page at /']);
  });
});

describe('the landing sections rule (AC-1, AC-P15)', () => {
  it('passes a landing with the four headed sections and only the limits table', () => {
    expect(LANDING_SECTIONS.map((section) => section.heading).slice(1)).toEqual(['How one lane gets closed', 'What it will not do', 'Limits, and what is real today']);
    expect(landingTexts(landingSectionsRule, landingBody())).toEqual([]);
  });

  for (const section of LANDING_SECTIONS) {
    it(`fails a landing missing the ${section.id} section heading`, () => {
      expect(landingTexts(landingSectionsRule, landingBody({ omit: section.id }))).toEqual([`the landing has no ${section.level} reading "${section.heading}"`]);
    });
  }

  it('fails a landing holding a second table besides the limits table', () => {
    const comparison = '<table><tr><th scope="col">Recipe</th><th scope="col">Closes</th></tr></table>';
    expect(landingTexts(landingSectionsRule, landingBody({ extra: comparison }))).toEqual(['the landing holds 1 table besides the limits table']);
  });
});

describe('the limits rule (AC-3, UI-SPEC E11)', () => {
  const [, measured] = LIMITS_ROWS;

  it('passes one row per part with a state, the replay state from the label map, and the no-measured-number sentence', () => {
    expect(REPLAY_LIMITS_STATE).toBe(PROVENANCE_LABELS[context.provenance].limitsState);
    expect(landingTexts(limitsRule, landingBody())).toEqual([]);
  });

  it('fails a limits row whose state cell is empty', () => {
    const rows = LIMITS_ROWS.map((row) => (row === measured ? limitsRow('measured-numbers', 'Measured numbers', ' ') : row));
    expect(landingTexts(limitsRule, landingBody({ limits: limitsSection(rows) }))).toEqual(['the limits row measured-numbers has no state']);
  });

  it('fails a limits row with no state cell', () => {
    const rows = LIMITS_ROWS.map((row) => (row === measured ? limitsRow('measured-numbers', 'Measured numbers', null) : row));
    expect(landingTexts(limitsRule, landingBody({ limits: limitsSection(rows) }))).toEqual(['the limits row measured-numbers has no state']);
  });

  it('fails a replay row whose state differs from the label map for the artifact provenance', () => {
    const rows = [limitsRow('replay', 'Incident replay', 'Simulator'), ...LIMITS_ROWS.slice(1)];
    expect(landingTexts(limitsRule, landingBody({ limits: limitsSection(rows) }))).toEqual([
      `the replay row reads Simulator; the label map gives ${REPLAY_LIMITS_STATE} for a ${context.provenance} artifact`,
    ]);
  });

  it('reads the expected replay state from the provenance in the check context', () => {
    expect(landingTexts(limitsRule, landingBody(), { ...context, provenance: 'live' })).toEqual([
      `the replay row reads ${REPLAY_LIMITS_STATE}; the label map gives Live for a live artifact`,
    ]);
  });

  it('fails a part with no row and a part with two', () => {
    const rows = [...LIMITS_ROWS.filter((row) => row !== measured), LIMITS_ROWS[0] ?? ''];
    expect(landingTexts(limitsRule, landingBody({ limits: limitsSection(rows) }))).toEqual([
      'the limits section has 2 rows for replay, 1 expected',
      'the limits section has no row for measured-numbers',
    ]);
  });

  it('fails a landing with no limits section', () => {
    expect(landingTexts(limitsRule, landingBody({ limits: '' }))).toEqual(['the landing has no limits section (data-limits)']);
  });

  it('fails a limits section without the no-measured-number sentence', () => {
    expect(landingTexts(limitsRule, landingBody({ limits: limitsSection(LIMITS_ROWS, 'Everything on this site is labelled by where it came from.') }))).toEqual([
      'the limits section does not say that this site carries no measured number',
    ]);
  });

  it('holds three fixed rows beside the replay row', () => {
    expect(LIMITS_FIXED_ROWS.map((row) => row.part)).toEqual(['Measured numbers', 'Live run', 'Deploy sheet']);
  });
});

describe('the no-ellipsis rule (UI-SPEC E14)', () => {
  it('fails built CSS holding text-overflow ellipsis, in either value form', () => {
    const site = siteOf({ ...completeSite(ONE_SHEET), '_astro/a.css': '.a{text-overflow:ellipsis}', '_astro/b.css': '.b { text-overflow: clip ellipsis; }' });
    expect(noEllipsisRule(site, context).map((finding) => [finding.route, finding.text])).toEqual([
      ['file:_astro/a.css', 'the CSS truncates text with text-overflow: ellipsis'],
      ['file:_astro/b.css', 'the CSS truncates text with text-overflow: ellipsis'],
    ]);
  });

  it('fails built CSS holding a line clamp, prefixed or not', () => {
    const site = siteOf({ ...completeSite(ONE_SHEET), '_astro/a.css': '.a { -webkit-line-clamp: 3; }', '_astro/b.css': '.b { line-clamp: 2; }' });
    expect(noEllipsisRule(site, context).map((finding) => [finding.route, finding.text])).toEqual([
      ['file:_astro/a.css', 'the CSS truncates text with a line clamp'],
      ['file:_astro/b.css', 'the CSS truncates text with a line clamp'],
    ]);
  });

  it('passes CSS that wraps rather than truncates', () => {
    const site = siteOf({ ...completeSite(ONE_SHEET), '_astro/a.css': '.a { overflow-wrap: anywhere; text-overflow: clip; }' });
    expect(noEllipsisRule(site, context)).toEqual([]);
  });
});

const REPLAY_PAGE_RULES = ['replay-page', 'replay-word-count', 'replay-summary', 'replay-lanes', 'provenance-wording', 'provider-label', 'replay-panels'];
const replaySite = (body: string): BuiltSite => siteOf({ 'replay/index.html': page(body) });
const replayTexts = (rule: RuleFunction, body: string, ruleContext = context): string[] => {
  const findings = rule(replaySite(body), ruleContext);
  expect(findings.every((finding) => finding.route === REPLAY_ROUTE)).toBe(true);
  return texts(findings);
};
const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${String(index)}`).join(' ');
const summaryOf = (items: readonly string[]): string => `<ol data-wordcount="summary">${items.map((item) => `<li>${item}</li>`).join('')}</ol>`;
const [PANEL_1 = '', PANEL_2 = '', PANEL_3 = '', PANEL_4 = ''] = replayPanels();

describe('the replay page rule (D-150 tracer)', () => {
  it('reports a build without /replay/ once, under replay-page, and no other replay rule', () => {
    const findings = runBuiltChecks(siteOf({ 'index.html': page('<p>landing</p>') }), context).filter((finding) => REPLAY_PAGE_RULES.includes(finding.rule));
    expect(findings).toEqual([{ rule: 'replay-page', route: REPLAY_ROUTE, text: 'the build has no replay page at /replay/' }]);
  });

  it('passes a build that holds the replay page', () => {
    expect(replayPageRule(replaySite(replayBody()), context)).toEqual([]);
  });
});

describe('the replay word count rule (AC-11, AC-E9)', () => {
  it('splits on whitespace, so a dotted or hyphenated identifier is one word', () => {
    expect(countWords('SendingOptions.SendingEnabled batch=2026-10-14-b')).toBe(2);
    expect(countWords('  a\n b' + String.fromCharCode(0xa0) + ' c ')).toBe(3);
    expect(countWords('')).toBe(0);
  });

  it('counts the marked elements after tag stripping and entity decoding, SVG text and unmarked text excluded', () => {
    const body = '<p>outside words here</p>'
      + '<p data-wordcount="summary"><code>SendingOptions.<wbr>SendingEnabled</code>&nbsp;and <span>batch=2026-10-14-b</span></p>'
      + '<p data-wordcount="tag">a&amp;b c</p><p data-wordcount="caption">x</p>'
      + '<section data-wordcount="step"><h2>t</h2><svg><text>not counted at all</text></svg><p>u</p></section>';
    const [built] = replaySite(body).pages;
    expect(built === undefined ? -1 : countReplayWords(built)).toBe(8);
  });

  it('passes the planted replay', () => {
    expect(replayTexts(replayWordCountRule, replayBody())).toEqual([]);
  });

  const capped = (stepWords: number): string =>
    `<p data-wordcount="summary">a</p><p data-wordcount="tag">b</p><p data-wordcount="caption">c</p><section data-wordcount="step"><p>${words(stepWords)}</p></section>`;

  it('passes 238 counted words', () => {
    expect(replayTexts(replayWordCountRule, capped(235))).toEqual([]);
  });

  it('fails 239 counted words', () => {
    expect(replayTexts(replayWordCountRule, capped(236))).toEqual(['the replay counts 239 words, 238 at most']);
  });

  it('fails a replay page with no counted element', () => {
    expect(replayTexts(replayWordCountRule, '<main><p>no markers</p></main>')).toEqual(['the replay page has no counted element (data-wordcount)']);
  });

  it('fails a replay page that counts no tag', () => {
    expect(replayTexts(replayWordCountRule, capped(1).replace('data-wordcount="tag"', 'data-other'))).toEqual(['the replay page counts no tag (data-wordcount="tag")']);
  });

  it('fails a counted marker outside the four kinds', () => {
    expect(replayTexts(replayWordCountRule, `${capped(1)}<p data-wordcount="intro">z</p>`)).toEqual(['data-wordcount="intro" is not one of summary, step, tag, caption']);
  });
});

describe('the replay summary rule (AC-5)', () => {
  const items = REPLAY_VIEW.summary.map((item) => `${item.time} ${item.text}`);

  it('passes the planted summary outside every step panel', () => {
    expect(replayTexts(replaySummaryRule, replayBody())).toEqual([]);
  });

  it('fails a summary inside a step panel', () => {
    const panels = [PANEL_1.replace('</section>', `${replaySummary()}</section>`), PANEL_2, PANEL_3, PANEL_4];
    expect(replayTexts(replaySummaryRule, replayBody({ summary: '', panels }))).toEqual(['the summary sits inside a step panel, so it does not show on every step']);
  });

  it('fails a summary that does not name the lane', () => {
    const summary = summaryOf(items.map((item) => item.replaceAll(REPLAY_VIEW.tag.lane, 'another-lane')));
    expect(replayTexts(replaySummaryRule, replayBody({ summary }))).toEqual([`the summary does not name the lane ${REPLAY_VIEW.tag.lane}`]);
  });

  it('fails a summary that does not name the cause', () => {
    const summary = summaryOf(items.filter((_, index) => index !== 1));
    expect(replayTexts(replaySummaryRule, replayBody({ summary }))).toEqual([`the summary does not name the cause ${REPLAY_VIEW.tag.cause}`]);
  });

  it('fails a summary that names the pause without its read-back', () => {
    const summary = summaryOf(items.map((item, index) => (index === 2 ? 'Paused' : item)));
    expect(replayTexts(replaySummaryRule, replayBody({ summary }))).toEqual([`the summary does not name the pause with its read-back: "${REPLAY_VIEW.summary[2]?.text ?? ''}"`]);
  });

  it('fails a summary that names the reopen without its read-back', () => {
    const summary = summaryOf(items.map((item, index) => (index === 3 ? 'Reopened by command' : item)));
    expect(replayTexts(replaySummaryRule, replayBody({ summary }))).toEqual([`the summary does not name the reopen with its read-back: "${REPLAY_VIEW.summary[3]?.text ?? ''}"`]);
  });

  it('fails a replay page with no summary and one with two', () => {
    expect(replayTexts(replaySummaryRule, replayBody({ summary: '' }))).toEqual(['the replay page has no summary (data-wordcount="summary")']);
    expect(replayTexts(replaySummaryRule, replayBody({ summary: `${replaySummary()}${replaySummary()}` }))).toEqual(['the replay page has 2 summaries, 1 expected']);
  });
});

describe('the replay lanes rule (AC-9)', () => {
  const { paused, reopened } = REPLAY_VIEW.lanesLines;
  const [firstOpen = ''] = REPLAY_VIEW.lanesLines.paused.split('Open: ')[1]?.split(', ') ?? [];

  it('passes steps 3 and 4 naming the paused lane and every other lane as open', () => {
    expect(replayTexts(replayLanesRule, replayBody())).toEqual([]);
  });

  it('fails step 3 when it misses an open lane', () => {
    const panels = [PANEL_1, PANEL_2, PANEL_3.replace(paused, paused.replace(`${firstOpen}, `, '')), PANEL_4];
    expect(replayTexts(replayLanesRule, replayBody({ panels }))).toEqual([`step 3 does not read "${paused}" outside the drawing`]);
  });

  it('fails step 4 when it misses the closed lane', () => {
    const panels = [PANEL_1, PANEL_2, PANEL_3, PANEL_4.replace(reopened, reopened.replace(`Reopened: ${REPLAY_VIEW.tag.lane}. `, ''))];
    expect(replayTexts(replayLanesRule, replayBody({ panels }))).toEqual([`step 4 does not read "${reopened}" outside the drawing`]);
  });

  it('fails a lanes line that sits only in SVG text', () => {
    const panels = [PANEL_1, PANEL_2, PANEL_3.replace(`<p>${paused}</p>`, `<svg><text>${paused}</text></svg>`), PANEL_4];
    expect(replayTexts(replayLanesRule, replayBody({ panels }))).toEqual([`step 3 does not read "${paused}" outside the drawing`]);
  });

  it('fails a replay page with no step 3 panel', () => {
    expect(replayTexts(replayLanesRule, replayBody({ panels: [PANEL_1, PANEL_2, PANEL_4] }))).toEqual(['the replay page has no step 3 panel']);
  });
});

describe('the provenance wording rule (AC-16, AC-P1, AC-P4)', () => {
  const caption = (text: string): string => `<p data-wordcount="caption">${text}</p>`;

  it('passes the planted replay of the generated artifact', () => {
    expect(context.provenance).toBe('generated');
    expect(replayTexts(provenanceWordingRule, replayBody())).toEqual([]);
  });

  it.each(['recorded', 'recording', 'captured', 'capture'])('fails a generated replay whose caption says %s', (word) => {
    const found = replayTexts(provenanceWordingRule, replayBody({ caption: caption(`Fixture ${word} in eu-central-1. Times are illustrative.`) }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(word);
  });

  it('fails a doc-derived replay whose control label says captured', () => {
    const found = replayTexts(provenanceWordingRule, replayBody({ extra: '<button aria-label="Replay the captured run">Replay</button>' }), { ...context, provenance: 'doc-derived' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('captured');
  });

  it('leaves the wording of a live replay to its own label', () => {
    expect(replayTexts(provenanceWordingRule, replayBody({ caption: caption('Recorded from a live run in eu-central-1.') }), { ...context, provenance: 'live' })).toEqual([]);
  });

  it('fails a generated replay that never calls its times illustrative', () => {
    const body = replayBody({ intro: '<p>One incident, four steps.</p>', caption: caption('Generated fixture. Not a live account.') });
    expect(replayTexts(provenanceWordingRule, body)).toEqual(['the replay page does not carry the time wording "Times are illustrative."']);
  });
});

describe('the provider label rule (AC-18, AC-P13)', () => {
  const SOURCE = 'https://provider.test/postmaster';
  const sourced: ReplayView = {
    ...REPLAY_VIEW,
    schedule: { ...REPLAY_VIEW.schedule, rows: REPLAY_VIEW.schedule.rows.map((row) => (row.dimension === 'Provider' ? { ...row, unconfirmed: false, sourceUrl: SOURCE } : row)) },
  };

  it('passes a provider row with no confirming source that reads unconfirmed', () => {
    expect(REPLAY_VIEW.schedule.rows.filter((row) => row.dimension === 'Provider' && row.unconfirmed)).toHaveLength(1);
    expect(replayTexts(providerLabelRule, replayBody())).toEqual([]);
  });

  it('fails a provider row with no confirming source and no unconfirmed label', () => {
    const panels = [PANEL_1, PANEL_2.replace(' <span>unconfirmed</span>', ''), PANEL_3, PANEL_4];
    const found = replayTexts(providerLabelRule, replayBody({ panels }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^the provider row ".+" has no confirming source and no unconfirmed label$/);
  });

  it('passes a provider row whose confirming source renders as a link', () => {
    expect(replayTexts(providerLabelRule, replayBody({}, sourced), { ...context, replay: sourced })).toEqual([]);
  });

  it('fails a provider row whose confirming source renders as plain text', () => {
    const [, two = ''] = replayPanels(sourced);
    const plain = two.replace(new RegExp(`<a href="${SOURCE}">(.*?)</a>`), `$1 ${SOURCE}`);
    expect(plain).not.toBe(two);
    const found = replayTexts(providerLabelRule, replayBody({ panels: [PANEL_1, plain, PANEL_3, PANEL_4] }, sourced), { ...context, replay: sourced });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(new RegExp(`^the provider row ".+" shows its confirming source ${SOURCE} as plain text, not a link$`));
  });

  it('fails a page that marks fewer provider rows than the artifact holds', () => {
    const panels = [PANEL_1, PANEL_2.replace(' data-provider-row', ''), PANEL_3, PANEL_4];
    expect(replayTexts(providerLabelRule, replayBody({ panels }))).toEqual(['the replay page marks 0 provider row(s); the artifact has 1']);
  });
});

describe('the replay panels rule (AC-E7, AC-10 static half)', () => {
  it('passes four panels in step order with nothing hiding them', () => {
    expect(replayTexts(replayPanelsRule, replayBody())).toEqual([]);
  });

  it.each(['hidden', 'aria-hidden="true"'])('fails a step panel carrying %s', (attribute) => {
    const panels = [PANEL_1, PANEL_2.replace('data-steps="2"', `data-steps="2" ${attribute}`), PANEL_3, PANEL_4];
    const name = attribute.split('=')[0] ?? '';
    expect(replayTexts(replayPanelsRule, replayBody({ panels }))).toEqual([`step panel 2 is hidden from the accessibility tree by ${name} on <section>`]);
  });

  it('fails step panels inside a hidden wrapper', () => {
    const panels = [`<div hidden>${PANEL_1}`, PANEL_2, PANEL_3, `${PANEL_4}</div>`];
    expect(replayTexts(replayPanelsRule, replayBody({ panels }))).toEqual([1, 2, 3, 4].map((step) => `step panel ${String(step)} is hidden from the accessibility tree by hidden on <div>`));
  });

  it('fails panels out of step order in the HTML', () => {
    expect(replayTexts(replayPanelsRule, replayBody({ panels: [PANEL_1, PANEL_3, PANEL_2, PANEL_4] }))).toEqual(['the step panels read 1, 3, 2, 4 in HTML order; 1, 2, 3, 4 expected']);
  });

  it('fails a replay page with three step panels', () => {
    expect(replayTexts(replayPanelsRule, replayBody({ panels: [PANEL_1, PANEL_2, PANEL_3] }))).toEqual(['the replay page has 3 step panels, 4 expected']);
  });
});

describe('the type token use rule (AC-63 use half)', () => {
  it('passes built CSS that uses all six R14 names through var()', () => {
    expect(typeTokenUseRule(siteOf(completeSite(ONE_SHEET)), context)).toEqual([]);
  });

  // tokens.css itself writes var(--text-small) for the compact alias; a use there is a declaration.
  it.each(['--text-lede', '--text-intro', '--text-narrative-headline', '--text-small', '--text-mono-value', '--text-schedule-compact'])('fails built CSS that declares %s and never uses it', (name) => {
    const css = TYPE_TOKEN_CSS.replace(`var(${name})`, '1rem');
    expect(css).not.toBe(TYPE_TOKEN_CSS);
    expect(texts(typeTokenUseRule(siteOf({ ...completeSite(ONE_SHEET), '_astro/site.css': css }), context))).toEqual([`the built CSS never uses ${name} through var()`]);
  });
});

const DEPLOY_PAGE_RULES = ['deploy-page', 'deploy-commands', 'deploy-permissions', 'deploy-resources', 'deploy-deny', 'deploy-notice', 'one-caller'];
const deploySite = (body: string): BuiltSite => siteOf({ 'deploy/index.html': page(body) });
const deployTexts = (rule: RuleFunction, body: string, ruleContext = context): string[] => {
  const findings = rule(deploySite(body), ruleContext);
  expect(findings.every((finding) => finding.route === DEPLOY_ROUTE)).toBe(true);
  return texts(findings);
};
const withDeploy = (facts: Partial<DeployFacts>): typeof context => ({ ...context, deploy: { ...DEPLOY_FACTS, ...facts } });
interface SnapshotEntry {
  stack: string;
  role: string;
  kind: string;
  effect: string;
  action: string;
  resource: string | null;
  principal: string | null;
  condition: string | null;
}
const [SHIPPED_ENTRY] = DEPLOY_FACTS.permissions as SnapshotEntry[];
const plantedEntry = (overrides: Partial<SnapshotEntry>): SnapshotEntry => ({ ...SHIPPED_ENTRY, ...overrides }) as SnapshotEntry;
const SHIPPED_ROWS = permissionSchedules(DEPLOY_FACTS.permissions).flatMap((schedule) => schedule.rows);
const [FIRST_ROW, SECOND_ROW] = SHIPPED_ROWS;
const FIRST_ROW_HTML = FIRST_ROW === undefined ? '' : permissionRow(FIRST_ROW);
const SECOND_ROW_HTML = SECOND_ROW === undefined ? '' : permissionRow(SECOND_ROW);
const NOT_IN_README = /^the deploy page shows the command "(.+)", which README's Deploy and remove section does not hold and which runs no package\.json script$/;

describe('the deploy page rule (D-150 tracer)', () => {
  it('reports a build without /deploy/ once, under deploy-page, and no other deploy rule', () => {
    const findings = runBuiltChecks(siteOf({ 'index.html': page('<p>landing</p>') }), context).filter((finding) => DEPLOY_PAGE_RULES.includes(finding.rule));
    expect(findings).toEqual([{ rule: 'deploy-page', route: DEPLOY_ROUTE, text: 'the build has no deploy page at /deploy/' }]);
  });

  it('passes a build that holds the deploy page', () => {
    expect(deployPageRule(deploySite(deployBody()), context)).toEqual([]);
  });
});

describe('the deploy commands rule (AC-32)', () => {
  it('passes the planted page, whose block holds every README command line', () => {
    expect(deployTexts(deployCommandsRule, deployBody())).toEqual([]);
  });

  it('passes a block holding only npm run build', () => {
    expect(deployTexts(deployCommandsRule, deployBody({ commands: commandBlock(['npm run build']) }))).toEqual([]);
  });

  it('fails a pre block holding npm run synth, which no script defines', () => {
    const found = deployTexts(deployCommandsRule, deployBody({ commands: commandBlock(['npm run synth']) }));
    expect(found.map((text) => NOT_IN_README.exec(text)?.[1])).toEqual(['npm run synth']);
  });

  it('fails an inline code block holding npx cdk deploy FotheringIngest, a line the README does not hold', () => {
    const found = deployTexts(deployCommandsRule, deployBody({ extra: '<p>Then run <code>npx cdk deploy FotheringIngest</code>.</p>' }));
    expect(found.map((text) => NOT_IN_README.exec(text)?.[1])).toEqual(['npx cdk deploy FotheringIngest']);
  });

  it('fails only the line the README lacks in a block of several', () => {
    const found = deployTexts(deployCommandsRule, deployBody({ commands: commandBlock(['npm run build', 'npx cdk synth', 'npx cdk deploy --all']) }));
    expect(found.map((text) => NOT_IN_README.exec(text)?.[1])).toEqual(['npx cdk synth']);
  });

  it('leaves inline code that runs nothing, such as a file name, to the other rules', () => {
    expect(deployTexts(deployCommandsRule, deployBody({ extra: '<p>Edit <code>lanes.json</code> first.</p>' }))).toEqual([]);
  });
});

describe('the deploy permissions rule (AC-33, AC-34, AC-E24, AC-E26)', () => {
  it('passes the shipped snapshot rendered in a planted page', () => {
    expect(SHIPPED_ROWS.length).toBeGreaterThan(1);
    expect(deployTexts(deployPermissionsRule, deployBody())).toEqual([]);
  });

  it('fails a page missing one snapshot entry', () => {
    const found = deployTexts(deployPermissionsRule, deployBody({ roles: roleSections().replace(FIRST_ROW_HTML, '') }));
    expect(found).toEqual([`the deploy page has no row for ${FIRST_ROW === undefined ? '' : permissionKey(FIRST_ROW)} on ${FIRST_ROW?.resourceOrPrincipal ?? ''}`]);
  });

  it('fails a page holding one entry twice', () => {
    const found = deployTexts(deployPermissionsRule, deployBody({ roles: roleSections().replace(FIRST_ROW_HTML, FIRST_ROW_HTML + FIRST_ROW_HTML) }));
    expect(found).toEqual([expect.stringMatching(/ 2 times, once expected$/)]);
  });

  it('fails a row for no entry in the snapshot', () => {
    const planted = FIRST_ROW === undefined ? '' : permissionRow({ ...FIRST_ROW, action: 'dynamodb:Scan' });
    const found = deployTexts(deployPermissionsRule, deployBody({ roles: roleSections().replace(FIRST_ROW_HTML, FIRST_ROW_HTML + planted) }));
    expect(found).toEqual([expect.stringMatching(/dynamodb:Scan .*matches no entry in packages\/infra\/permissions\.json$/)]);
  });

  it('fails a row whose reason differs from the reasons map', () => {
    const planted = FIRST_ROW === undefined ? '' : permissionRow({ ...FIRST_ROW, reason: 'Because it can.' });
    const found = deployTexts(deployPermissionsRule, deployBody({ roles: roleSections().replace(FIRST_ROW_HTML, planted) }));
    expect(found).toEqual([expect.stringMatching(/reads "Because it can\."; the reasons map gives "/)]);
  });

  it('renders two entries differing only in resource as two rows, and fails a page showing one', () => {
    const twin = plantedEntry({ resource: '{"Ref":"PlantedTable"}' });
    const twinned = { permissions: [...DEPLOY_FACTS.permissions, twin] };
    expect(deployTexts(deployPermissionsRule, deployBody({}, { ...DEPLOY_FACTS, ...twinned }), withDeploy(twinned))).toEqual([]);
    expect(deployTexts(deployPermissionsRule, deployBody(), withDeploy(twinned))).toEqual([expect.stringMatching(/^the deploy page has no row for .* on \{"Ref":"PlantedTable"\}$/)]);
  });

  it('reads a shuffled snapshot as the same table, and fails rows out of the snapshot order', () => {
    const shuffledFacts = { permissions: [...DEPLOY_FACTS.permissions].reverse() };
    expect(deployTexts(deployPermissionsRule, deployBody(), withDeploy(shuffledFacts))).toEqual([]);
    const swapped = roleSections().replace(FIRST_ROW_HTML + SECOND_ROW_HTML, SECOND_ROW_HTML + FIRST_ROW_HTML);
    expect(swapped).not.toBe(roleSections());
    expect(deployTexts(deployPermissionsRule, deployBody({ roles: swapped }))).toEqual(["the permission rows do not follow the snapshot's order"]);
  });

  it('fails a role section whose heading names another role', () => {
    const sections = roleSections();
    const [, name = ''] = /<h3>([^<]+)<\/h3>/.exec(sections) ?? [];
    const found = deployTexts(deployPermissionsRule, deployBody({ roles: sections.replace(`<h3>${name}</h3>`, '<h3>OtherRole</h3>') }));
    expect(found).toEqual([expect.stringMatching(new RegExp(`^the role section .*/${name} is headed "OtherRole"`))]);
  });
});

describe('the deploy resources rule (AC-35)', () => {
  const resources = DEPLOY_FACTS.resources as Record<string, string>[];
  const firstListed = resourceRows(resources)[0];
  const firstHtml = firstListed === undefined ? '' : resourceRow(firstListed, removedByText(DEPLOY_FACTS.commands));
  const retained = { resources: resources.map((entry) => (entry.logicalId === firstListed?.logicalId ? { ...entry, deletionPolicy: 'Retain' } : entry)) };

  it('passes every resources.json entry rendered once with its removal', () => {
    expect(deployTexts(deployResourcesRule, deployBody())).toEqual([]);
  });

  it('fails a page missing one resources.json entry', () => {
    expect(deployTexts(deployResourcesRule, deployBody({ resources: resourceTable().replace(firstHtml, '') }))).toEqual([
      `the deploy page lists no row for ${firstListed?.stack ?? ''}/${firstListed?.logicalId ?? ''}`,
    ]);
  });

  it('fails a page listing a resource the snapshot does not hold', () => {
    const extra = firstListed === undefined ? '' : resourceRow({ ...firstListed, logicalId: 'PlantedBucket0A1B2C3D' }, removedByText(DEPLOY_FACTS.commands));
    expect(deployTexts(deployResourcesRule, deployBody({ resources: resourceTable().replace(firstHtml, firstHtml + extra) }))).toEqual([
      `the deploy page lists ${firstListed?.stack ?? ''}/PlantedBucket0A1B2C3D, which packages/infra/resources.json does not hold`,
    ]);
  });

  it('fails a page saying deleted for a Retain entry, and passes it saying kept', () => {
    expect(deployTexts(deployResourcesRule, deployBody(), withDeploy(retained))).toEqual([expect.stringMatching(/ reads "Deleted by .*" under On removal; "Kept after removal" expected$/)]);
    expect(deployTexts(deployResourcesRule, deployBody({}, { ...DEPLOY_FACTS, ...retained }), withDeploy(retained))).toEqual([]);
  });
});

describe('the deploy Deny rule (AC-37, AC-E27)', () => {
  const denied = plantedEntry({ effect: 'Deny', action: 'ses:UpdateAccountSendingEnabled', resource: '*' });
  const deniedFacts = {
    permissions: [...DEPLOY_FACTS.permissions, denied],
    reasons: { ...PERMISSION_REASONS, [permissionKey(denied)]: 'Stops a pause of the whole account.' },
  };

  it('passes the shipped snapshot, which holds no Deny entry, with no Deny box', () => {
    expect(deployTexts(deployDenyRule, deployBody())).toEqual([]);
  });

  it('fails a Deny box while the snapshot holds no Deny entry', () => {
    expect(deployTexts(deployDenyRule, deployBody({ deny: '<div data-deny><h3>Denied on every role</h3></div>' }))).toEqual([
      'the snapshot holds no Deny entry, and the deploy page shows a Deny box',
    ]);
  });

  it('fails a Deny row while the snapshot holds no Deny entry', () => {
    const planted = FIRST_ROW === undefined ? '' : permissionRow({ ...FIRST_ROW, effect: 'Deny' });
    expect(deployTexts(deployDenyRule, deployBody({ extra: `<table>${planted}</table>` }))).toEqual([expect.stringMatching(/^the snapshot holds no Deny entry, and the deploy page shows the Deny row /)]);
  });

  it('renders a planted Deny entry as a row in the Deny box, and fails a page without it', () => {
    expect(deployTexts(deployDenyRule, deployBody({}, { ...DEPLOY_FACTS, ...deniedFacts }), withDeploy(deniedFacts))).toEqual([]);
    expect(deployTexts(deployDenyRule, deployBody(), withDeploy(deniedFacts))).toEqual(['the snapshot holds 1 Deny entry, and the deploy page has no Deny box']);
  });
});

describe('the deploy notice rule (UI-SPEC Q16)', () => {
  const pause = plantedEntry({ action: 'ses:PutConfigurationSetSendingOptions', resource: '*' });
  const pausing = {
    permissions: [...DEPLOY_FACTS.permissions, pause],
    reasons: { ...PERMISSION_REASONS, [permissionKey(pause)]: 'Pauses the one lane code approved.' },
  };

  it('passes the NOT YET notice while no role may pause a lane', () => {
    expect(deployTexts(deployNoticeRule, deployBody())).toEqual([]);
  });

  it('fails a page without the notice while no role may pause a lane', () => {
    expect(deployTexts(deployNoticeRule, deployBody({ notice: '' }))).toEqual([
      'the template holds no ses:PutConfigurationSetSendingOptions grant, and the deploy page shows no NOT YET notice',
    ]);
  });

  it('fails the notice once a role may pause a lane, and passes the page without it', () => {
    expect(deployTexts(deployNoticeRule, deployBody(), withDeploy(pausing))).toEqual(['the template holds a pause grant, and the deploy page still shows the NOT YET notice']);
    expect(deployTexts(deployNoticeRule, deployBody({}, { ...DEPLOY_FACTS, ...pausing }), withDeploy(pausing))).toEqual([]);
  });
});

describe('the one-caller rule (AC-36)', () => {
  it('passes a deploy page stating the one caller per lane and why', () => {
    expect(deployTexts(oneCallerRule, deployBody())).toEqual([]);
  });

  it('fails a deploy page without the sentence', () => {
    expect(deployTexts(oneCallerRule, deployBody({ oneCaller: 'Each lane sends through its own IAM caller identity.' }))).toEqual([
      'the deploy page does not say that each lane sends through its own IAM caller identity, and why',
    ]);
  });
});

const PRIVACY_SECTION_RULES = ['privacy-page', 'privacy-statements', 'stored-field-rows', 'website-facts', 'six-rights', 'forget-command', 'model-id'];
const privacySite = (body: string): BuiltSite => siteOf({ 'privacy-and-ai/index.html': page(body) });
const privacyTexts = (rule: RuleFunction, body: string, ruleContext = context): string[] => {
  const findings = rule(privacySite(body), ruleContext);
  expect(findings.every((finding) => finding.route === PRIVACY_ROUTE)).toBe(true);
  return texts(findings);
};
const statementById = (statements: readonly Statement[], id: string): Statement => {
  const found = statements.find((statement) => statement.id === id);
  if (found === undefined) throw new Error(`no planted statement ${id}`);
  return found;
};
const omitting = (statements: readonly Statement[], id: string): string => statements.filter((statement) => statement.id !== id).map(statementParagraph).join('');
const { privacy } = context;
const [FIRST_FIELD] = privacy.storedFields;

describe('the privacy page rule (D-150 tracer)', () => {
  it('reports a build without /privacy-and-ai/ once, under privacy-page, and no other privacy section rule', () => {
    const findings = runBuiltChecks(siteOf({ 'index.html': page('<p>landing</p>') }), context).filter((finding) => PRIVACY_SECTION_RULES.includes(finding.rule));
    expect(findings).toEqual([{ rule: 'privacy-page', route: PRIVACY_ROUTE, text: 'the build has no privacy and AI page at /privacy-and-ai/' }]);
  });

  it('passes a build that holds the page with both sections', () => {
    expect(privacyPageRule(privacySite(privacyBody()), context)).toEqual([]);
  });

  it('fails a page with no #ai element, naming the id', () => {
    expect(privacyTexts(privacyPageRule, privacyBody({ ai: '<h2>AI</h2>' }))).toEqual(['the privacy and AI page has no element with id ai']);
  });
});

describe('the privacy statements rule (AC-19, AC-E14)', () => {
  it('passes a privacy section holding every required statement', () => {
    expect(privacyTexts(privacyStatementsRule, privacyBody())).toEqual([]);
  });

  it.each(['event-region', 'model-requests', 'keyed-hash', 'retention', 'dead-letter', 'logs', 'forget', 'forget-reach', 'addresses', 'deployment-controller', 'tag-values'])('fails a section missing the %s statement, naming it', (id) => {
    const missing = statementById(privacy.required, id);
    // The keyed-hash statement is also the stored-field row of the hash, so it goes from the row too.
    const body = privacyBody({ statements: omitting(privacy.required, id) }).replaceAll(missing.text, '');
    expect(privacyTexts(privacyStatementsRule, body)).toEqual([`the privacy section does not say "${missing.text}"`]);
  });

  it('fails the Bedrock sentence without its AWS page link in the same element', () => {
    const bedrock = statementById(privacy.required, 'model-requests');
    const unlinked = privacy.required.map((statement) => (statement.id === 'model-requests' ? `<p>${statement.text}</p>` : statementParagraph(statement))).join('');
    expect(privacyTexts(privacyStatementsRule, privacyBody({ statements: unlinked }))).toEqual([`the privacy section says "${bedrock.text}" with no link to ${bedrock.link ?? ''} in the same element`]);
  });

  it('reads only the privacy part, so a statement placed after #ai does not count', () => {
    const logs = statementById(privacy.required, 'logs');
    const body = privacyBody({ statements: omitting(privacy.required, 'logs'), extra: statementParagraph(logs) });
    expect(privacyTexts(privacyStatementsRule, body)).toEqual([`the privacy section does not say "${logs.text}"`]);
  });
});

describe('the stored-field rows rule (AC-20, UI-SPEC E8)', () => {
  const rows = (fields: readonly (typeof privacy.storedFields)[number][]): string => `<table>${fields.map(storedFieldRow).join('')}</table>`;

  it('passes one row per field the map classes recipient or sender', () => {
    expect(privacy.storedFields.length).toBeGreaterThan(1);
    expect(privacyTexts(storedFieldRowsRule, privacyBody())).toEqual([]);
  });

  it('fails a schedule missing one identifying field', () => {
    expect(privacyTexts(storedFieldRowsRule, privacyBody({ fields: rows(privacy.storedFields.slice(1)) }))).toEqual([`the stored-field schedule has no row for ${FIRST_FIELD?.path ?? ''}`]);
  });

  it('fails a row for a field the map classes as neither', () => {
    const extra = { path: 'messageId', identifies: 'Recipient', row: 'The SES message id.' };
    expect(privacyTexts(storedFieldRowsRule, privacyBody({ fields: rows([...privacy.storedFields, extra]) }))).toEqual([
      'the stored-field schedule has a row for messageId, which the stored-field map does not class as identifying a recipient or a sender',
    ]);
  });

  it('fails a field shown twice, and a row that does not say what its field identifies', () => {
    const first = FIRST_FIELD ?? { path: '', identifies: '', row: '' };
    expect(privacyTexts(storedFieldRowsRule, privacyBody({ fields: rows([first, ...privacy.storedFields]) }))).toEqual([`the stored-field schedule shows ${first.path} 2 times, once expected`]);
    const unnamed = rows(privacy.storedFields).replace(`<td data-col="Identifies">${first.identifies}</td>`, '<td data-col="Identifies"></td>');
    expect(privacyTexts(storedFieldRowsRule, privacyBody({ fields: unnamed }))).toEqual([`the stored-field row ${first.path} does not say that it identifies a ${first.identifies}`]);
  });
});

describe('the website facts and six rights rules (AC-21, AC-E16)', () => {
  it('passes a website part naming every fact', () => {
    expect(privacyTexts(websiteFactsRule, privacyBody())).toEqual([]);
  });

  it.each(['controller', 'contact', 'legal-basis', 'complaint', 'cloudflare-dpa', 'aws-dpa', 'no-cookie', 'no-analytics'])('fails a website part missing the %s fact', (id) => {
    const missing = statementById(privacy.website, id);
    expect(privacyTexts(websiteFactsRule, privacyBody({ website: omitting(privacy.website, id) }))).toEqual([`the website part does not say "${missing.text}"`]);
  });

  it('passes the six rights in any order', () => {
    expect(privacyTexts(sixRightsRule, privacyBody({ rights: rightsSentence([...privacy.rights].reverse()) }))).toEqual([]);
  });

  it('fails one right missing and one right repeated', () => {
    const [first = '', ...rest] = privacy.rights;
    expect(privacyTexts(sixRightsRule, privacyBody({ rights: rightsSentence(rest) }))).toEqual([`the privacy section does not name the right of ${first}`]);
    expect(privacyTexts(sixRightsRule, privacyBody({ rights: rightsSentence([first, ...privacy.rights]) }))).toEqual([`the privacy section names the right of ${first} 2 times, once expected`]);
  });

  it('fails a marked right that is not one of the six', () => {
    expect(privacyTexts(sixRightsRule, privacyBody({ rights: rightsSentence([...privacy.rights, 'appeal']) }))).toEqual(['the privacy section marks "appeal" as a right, which is not one of the six']);
  });
});

describe('the forget command and no-delete-control rules (AC-23, AC-P7)', () => {
  it('passes a privacy section naming the doc, its command and the stack output', () => {
    expect(privacyTexts(forgetCommandRule, privacyBody())).toEqual([]);
  });

  it('fails a privacy section that names neither the doc nor the command', () => {
    const statements = omitting(privacy.required, 'forget');
    expect(privacyTexts(forgetCommandRule, privacyBody({ statements, forget: '<p>Ask the operator.</p>' }))).toEqual([
      'the privacy section does not name docs/forget-one-recipient.md',
      `the privacy section does not name the command ${privacy.forget.command} from docs/forget-one-recipient.md`,
      `the privacy section does not name the stack output ${privacy.forget.output} that names the forget function`,
    ]);
  });

  it('fails a button, a link or a form on any page that deletes or forgets a recipient', () => {
    const findings = caseFindings(noDeleteControlRule, 'no-delete-control', [
      '<button type="button">Delete this recipient</button>',
      '<a href="/forget/">Forget a recipient</a>',
      '<form action="/x"><button>Erase an address</button></form>',
      '<button aria-label="Remove recipient">x</button>',
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it('passes the doc named as text and controls that delete nothing', () => {
    expect(noDeleteControlRule(casesSite([forgetSentence(privacy.forget), '<button type="button">Stop flow</button>']), context)).toEqual([]);
  });
});

describe('the model-role rules (AC-24, AC-25, AC-E18 to AC-E20)', () => {
  it('fails, never passes, a site where no page carries the marker', () => {
    expect(texts(modelRolePresentRule(casesSite(['<p>The agent explains the evidence.</p>']), context))).toEqual([
      'no built page carries a data-model-role element, so what the pages say about the model was not checked',
    ]);
  });

  it('passes the required statements across the marked elements in any order', () => {
    const reversed = modelRoleList([...privacy.modelRequired].reverse());
    expect(modelRoleRequiredRule(casesSite([reversed]), context)).toEqual([]);
  });

  it('fails marked elements missing one required statement, naming it', () => {
    const [first, ...rest] = privacy.modelRequired;
    const findings = modelRoleRequiredRule(casesSite([modelRoleList(rest), `<p>${first?.text ?? ''}</p>`]), context);
    expect(findings).toEqual([{ rule: 'model-role-required', route: PRIVACY_ROUTE, text: `no data-model-role element says "${first?.text ?? ''}"` }]);
  });

  it('fails a marked element holding a forbidden claim, naming route and text, and passes it unmarked', () => {
    const findings = caseFindings(modelRoleForbiddenRule, 'model-role-forbidden', ['<p data-model-role>Code writes the record. The model approves a lane.</p>']);
    expect(findings[0]?.text).toMatch(/^a data-model-role element claims what only code does \(lane-choice\): ".*The model approves a lane\./);
    expect(modelRoleForbiddenRule(casesSite(['<p>The model approves a lane.</p>']), context)).toEqual([]);
  });

  it('passes the negated form a model-role element uses', () => {
    expect(modelRoleForbiddenRule(casesSite(['<p data-model-role>The model never names the cause.</p>']), context)).toEqual([]);
  });

  it('passes the model id equal to the pin, and fails a different one or none', () => {
    expect(privacyTexts(modelIdRule, privacyBody())).toEqual([]);
    expect(privacyTexts(modelIdRule, privacyBody({ modelId: '<p><code data-model-id>eu.planted.other-model</code></p>' }))).toEqual([
      `the AI section shows the model id eu.planted.other-model; the repository pins ${privacy.modelId}`,
    ]);
    expect(privacyTexts(modelIdRule, privacyBody({ modelId: '' }))).toEqual(['the AI section shows no model id (data-model-id)']);
  });
});

const ACCESSIBILITY_RULES = ['accessibility-page', 'accessibility-statement'];
const accessibilitySite = (body: string): BuiltSite => siteOf({ 'accessibility/index.html': page(body) });
const accessibilityTexts = (rule: RuleFunction, body: string): string[] => {
  const findings = rule(accessibilitySite(body), context);
  expect(findings.every((finding) => finding.route === ACCESSIBILITY_ROUTE)).toBe(true);
  return texts(findings);
};
const STATEMENTS = accessibilityStatements();
const withoutStatement = (id: string): string => STATEMENTS.filter((statement) => statement.id !== id).map(statementParagraph).join('');
const criteriaTable = (rows: readonly string[]): string => `<table>${rows.join('')}</table>`;
const [FIRST_CRITERION] = HAND_CHECK_CRITERIA;

describe('the accessibility page rule (D-156 tracer)', () => {
  it('reports a build without /accessibility/ once, under accessibility-page, and no statement finding', () => {
    const findings = runBuiltChecks(siteOf({ 'index.html': page('<p>landing</p>') }), context).filter((finding) => ACCESSIBILITY_RULES.includes(finding.rule));
    expect(findings).toEqual([{ rule: 'accessibility-page', route: ACCESSIBILITY_ROUTE, text: 'the build has no accessibility statement at /accessibility/' }]);
  });

  it('passes a build that holds the statement', () => {
    expect(accessibilityPageRule(accessibilitySite(accessibilityBody()), context)).toEqual([]);
  });
});

describe('the accessibility statement rule (AC-53, UI-SPEC E13)', () => {
  it('passes a statement naming the target, audit date, tool, limitations, contact route and every criterion with its result', () => {
    expect(STATEMENTS.length).toBeGreaterThan(4);
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody())).toEqual([]);
  });

  // Every committed statement, limitations included, so one added later is covered without an edit here.
  it.each(accessibilityStatements().map((statement) => statement.id))('fails a statement missing the %s item, naming it', (id) => {
    const missing = STATEMENTS.find((statement) => statement.id === id);
    expect(missing).toEqual(expect.objectContaining({ id, text: expect.any(String) }));
    const text = missing?.text ?? '';
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ statements: withoutStatement(id) }))).toEqual([`the accessibility statement does not say "${text}"`]);
  });

  it('fails a hand-check schedule missing one criterion, naming it', () => {
    const rows = HAND_CHECK_CRITERIA.slice(1).map(handCheckRow);
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ criteria: criteriaTable(rows) }))).toEqual([`the hand-check schedule has no row for ${FIRST_CRITERION?.number ?? ''}`]);
  });

  it('fails a criterion row that does not show its own result', () => {
    const first = FIRST_CRITERION ?? HAND_CHECK_CRITERIA[0];
    if (first === undefined) throw new Error('no criterion to plant');
    const label = HAND_CHECK_RESULT_LABELS[first.result];
    const other = label === 'Passed' ? 'Failed' : 'Passed';
    const rows = [handCheckRow(first).replace(`<td>${label}</td>`, `<td>${other}</td>`), ...HAND_CHECK_CRITERIA.slice(1).map(handCheckRow)];
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ criteria: criteriaTable(rows) }))).toEqual([`the hand-check row ${first.number} does not show its result "${label}"`]);
  });

  it('fails a criterion row that leaves out its name or its how-checked note', () => {
    const first = FIRST_CRITERION ?? HAND_CHECK_CRITERIA[0];
    if (first === undefined) throw new Error('no criterion to plant');
    const nameless = [`<tr data-criterion="${first.number}"><th>${first.number}</th><td>${HAND_CHECK_RESULT_LABELS[first.result]}</td><td></td></tr>`, ...HAND_CHECK_CRITERIA.slice(1).map(handCheckRow)];
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ criteria: criteriaTable(nameless) }))).toEqual([
      `the hand-check row ${first.number} does not name "${first.name}"`,
      `the hand-check row ${first.number} does not say how it is checked`,
    ]);
  });

  it('fails a criterion shown twice and a row for a criterion axe can decide', () => {
    const first = FIRST_CRITERION ?? HAND_CHECK_CRITERIA[0];
    if (first === undefined) throw new Error('no criterion to plant');
    const all = HAND_CHECK_CRITERIA.map(handCheckRow);
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ criteria: criteriaTable([handCheckRow(first), ...all]) }))).toEqual([`the hand-check schedule shows ${first.number} 2 times, once expected`]);
    const decidable = '<tr data-criterion="1.4.3"><th>1.4.3 Contrast (Minimum)</th><td>Passed</td><td>axe-core</td></tr>';
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody({ criteria: criteriaTable([...all, decidable]) }))).toEqual([
      'the hand-check schedule has a row for 1.4.3, which is not one of the criteria axe-core cannot decide',
    ]);
  });

  it('judges each row by its own recorded state, so the schedule before the hand check passes with every row not yet checked', () => {
    const states = new Set(HAND_CHECK_CRITERIA.map((criterion) => criterion.result));
    expect([...states]).toEqual(['not-yet-checked']);
    expect(accessibilityTexts(accessibilityStatementRule, accessibilityBody())).toEqual([]);
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
