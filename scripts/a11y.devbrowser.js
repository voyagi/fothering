// a11y.devbrowser.js - the dev-browser (QuickJS) driver template behind npm run a11y:live. The
// harness in packages/web/src/harness writes one copy per theme and width with its job in place of
// the token below, runs it, and owns every verdict; this file only does page work and prints one
// `AUDIT <json>` line per route, then `done`.
const JOB = /* fothering-job */ null;

const page = await browser.newPage();
await page.setViewportSize({ width: JOB.width, height: JOB.height });
await page.emulateMedia({ colorScheme: JOB.osScheme, reducedMotion: 'reduce' });

// The theme is pinned by storage and a second navigation, never the page init-script API, which
// crashes dev-browser 0.2.9 in every form. The page's own head script reads storage on the next load.
await page.goto(JOB.base + JOB.routes[0], { waitUntil: 'load' });
await page.evaluate((stored) => {
  localStorage.clear();
  if (stored !== null) localStorage.setItem('fothering-theme', stored);
}, JOB.storedTheme);

const axeSource = await readFile(JOB.axeFile);

for (const route of JOB.routes) {
  const response = await page.goto(JOB.base + route, { waitUntil: 'load' });
  const status = response === null ? 0 : response.status();
  if (status !== 200) {
    console.log('AUDIT ' + JSON.stringify({ route, status }));
    continue;
  }

  await page.evaluate(axeSource);
  const axe = await page.evaluate(async (cfg) => {
    const selected = window.axe.getRules(cfg.tags).map((rule) => rule.ruleId);
    const rules = {};
    for (const id of cfg.rules) rules[id] = { enabled: true };
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: cfg.tags }, rules });
    const shape = (item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.map((node) => ({ target: node.target.join(' '), summary: (node.failureSummary || '').slice(0, 200) })),
    });
    const ran = [].concat(result.passes, result.violations, result.incomplete, result.inapplicable).map((item) => item.id);
    return {
      version: window.axe.version,
      selected,
      ran,
      violations: result.violations.map(shape),
      incomplete: result.incomplete.map(shape),
    };
  }, { tags: JOB.tags, rules: JOB.rules });

  // A candidate is anything the browser puts in the sequential Tab order: tabIndex 0 or more on an
  // element that can take focus, enabled and rendered. Positive tabindex values are listed apart.
  const candidates = await page.evaluate(() => {
    const selector = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]';
    const focusables = [];
    const positiveTabindex = [];
    Array.from(document.querySelectorAll('*')).forEach((el, domIndex) => {
      const tag = el.tagName.toLowerCase();
      if (el.tabIndex > 0) positiveTabindex.push({ domIndex, tag, tabindex: el.getAttribute('tabindex') });
      if (!el.matches(selector) || el.tabIndex < 0 || el.disabled === true) return;
      if (tag === 'input' && el.type === 'hidden') return;
      if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') return;
      focusables.push({
        domIndex,
        tag,
        radioGroup: tag === 'input' && el.type === 'radio' && el.name !== '' ? el.name : null,
        skipLink: tag === 'a' && (el.getAttribute('href') || '').startsWith('#') && /skip/i.test(el.textContent || ''),
      });
    });
    return { focusables, positiveTabindex };
  });

  const walk = [];
  for (let press = 0; press < candidates.focusables.length + 2; press += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body || el === document.documentElement) return null;
      const tag = el.tagName.toLowerCase();
      const style = getComputedStyle(el);
      return {
        domIndex: Array.from(document.querySelectorAll('*')).indexOf(el),
        tag,
        radioGroup: tag === 'input' && el.type === 'radio' && el.name !== '' ? el.name : null,
        skipLink: tag === 'a' && (el.getAttribute('href') || '').startsWith('#') && /skip/i.test(el.textContent || ''),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    if (stop === null || (walk.length > 0 && stop.domIndex === walk[0].domIndex)) break;
    walk.push(stop);
  }

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  console.log('AUDIT ' + JSON.stringify({
    route,
    status,
    axe,
    keyboard: { focusables: candidates.focusables, positiveTabindex: candidates.positiveTabindex, walk },
    overflow,
  }));
}

console.log('done');
