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

// The unknown path expects 404, so the 404 page is audited like any sheet; any other status
// prints the bare record and the harness names the mismatch.
for (const route of JOB.routes) {
  const response = await page.goto(JOB.base + route, { waitUntil: 'load' });
  const status = response === null ? 0 : response.status();
  if (status !== (JOB.expectedStatus[route] || 200)) {
    console.log('AUDIT ' + JSON.stringify({ route, status }));
    continue;
  }

  // Read before axe runs, so the reading is the state the page's own head script and tokens.css left.
  const theme = await page.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(),
  }));
  // Under reduced motion every lamp and key is placed in its final state, so the page holds no
  // animation at all: neither a running one nor a finished one kept by its fill.
  const motion = await page.evaluate(() => ({ animations: document.getAnimations().length }));

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
    // Whether a gradient fills its element's box (the default size, repeat, position and clip), and
    // whether hit testing at the text's centre, scrolled into view, meets only the text, its own
    // ancestors and then that element. Hit testing returns a pseudo-element as its element and skips
    // pointer-events: none, so neither is seen here. The window is scrolled, never the element:
    // Chromium moves the next Tab's starting point to an element scrolled into view, which the
    // keyboard walk below would read as a page whose first Tab skips the skip link.
    const gradientFacts = (element, holder) => {
      const style = getComputedStyle(holder);
      const backgroundWhole = style.backgroundSize === 'auto' && style.backgroundRepeat === 'repeat' && style.backgroundPosition === '0% 0%' && style.backgroundClip === 'border-box';
      const [left, top] = [window.scrollX, window.scrollY];
      const before = element.getBoundingClientRect();
      window.scrollTo({ left, top: top + before.top + before.height / 2 - window.innerHeight / 2, behavior: 'instant' });
      const box = element.getBoundingClientRect();
      const stack = box.width > 0 && box.height > 0 ? document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2) : [];
      window.scrollTo({ left, top, behavior: 'instant' });
      const reached = stack.indexOf(holder);
      const stackClear = reached >= 0 && stack.slice(0, reached).every((hit) => element.contains(hit) || hit.contains(element));
      return { backgroundWhole, stackClear };
    };
    // For a color-contrast node axe left undecided, what the harness needs to decide it: axe's
    // reason and the ratio it asks for, the text's computed colour, whether any element on the way up
    // is translucent, and the first background painted behind it, as the browser computed them.
    const paintedBehind = (element) => {
      let opaque = true;
      for (let at = element; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.opacity !== '1') opaque = false;
        if (style.backgroundImage !== 'none') return { background: style.backgroundImage, opaque, ...gradientFacts(element, at) };
        if (!/, 0\)$/.test(style.backgroundColor)) return { background: style.backgroundColor, opaque };
      }
      return { background: 'none', opaque };
    };
    const contrastFacts = (node) => {
      const check = (node.any || []).find((entry) => entry.id === 'color-contrast');
      const data = check !== undefined && typeof check.data === 'object' && check.data !== null ? check.data : {};
      const element = node.target.length === 1 ? document.querySelector(node.target[0]) : null;
      const facts = { messageKey: data.messageKey, expected: data.expectedContrastRatio };
      return element === null ? facts : { ...facts, color: getComputedStyle(element).color, ...paintedBehind(element) };
    };
    const shapeIncomplete = (item) => {
      const shaped = shape(item);
      if (item.id !== 'color-contrast') return shaped;
      return { ...shaped, nodes: shaped.nodes.map((node, index) => ({ ...node, ...contrastFacts(item.nodes[index]) })) };
    };
    const ran = [].concat(result.passes, result.violations, result.incomplete, result.inapplicable).map((item) => item.id);
    return {
      version: window.axe.version,
      selected,
      ran,
      violations: result.violations.map(shape),
      incomplete: result.incomplete.map(shapeIncomplete),
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
    theme,
    axe,
    keyboard: { focusables: candidates.focusables, positiveTabindex: candidates.positiveTabindex, walk },
    overflow,
    motion,
  }));
}

console.log('done');
