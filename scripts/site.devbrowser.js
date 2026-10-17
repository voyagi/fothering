// site.devbrowser.js - the dev-browser (QuickJS) driver template behind the rendered step of
// npm run test:e2e. The harness in packages/web/src/harness writes one copy with its job in place of
// the token below, serves the build under its real _headers, runs this, and owns every verdict; this
// file only does page work and prints one `<CHECK> <json>` line per check, then `done`.
const JOB = /* fothering-job */ null;

// A family no stylesheet declares: its absence is what makes a passing font check mean something.
const CONTROL_FAMILY = 'Fothering Undeclared Face';
const RADIOS = 'input[type="radio"][name="theme"]';

const page = await browser.newPage();
const consoleErrors = [];
// The location travels with each error, so the harness can tell the unknown address's own 404 from
// a resource that failed to load.
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const location = message.location();
  consoleErrors.push({ text: message.text(), url: location && location.url ? location.url : '' });
});
let requests = [];
page.on('request', (request) => {
  requests.push(request.url());
});

const url = JOB.base + JOB.route;
const readTheme = () => page.evaluate(() => ({
  dataTheme: document.documentElement.getAttribute('data-theme'),
  ground: getComputedStyle(document.documentElement).getPropertyValue('--ground').trim(),
}));

// The theme is pinned by storage and a second navigation, never the page init-script API, which
// crashes dev-browser 0.2.9 in every form. The page's own head script reads storage on the next load.
const loadWith = async (stored, os) => {
  await page.evaluate((value) => {
    localStorage.clear();
    if (value !== null) localStorage.setItem('fothering-theme', value);
  }, stored);
  await page.emulateMedia({ colorScheme: os, reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'load' });
};

await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
await page.goto(url, { waitUntil: 'load' });

await loadWith('dark', 'light');
console.log('THEME ' + JSON.stringify(await readTheme()));

// Device: the same loaded page, the OS flipped with no reload, so only CSS can follow it.
await loadWith(null, 'dark');
const deviceDark = await readTheme();
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
console.log('DEVICE ' + JSON.stringify({ dark: deviceDark, light: await readTheme() }));

await loadWith('dark', 'dark');
const pinnedBefore = await readTheme();
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
console.log('PIN ' + JSON.stringify({ before: pinnedBefore, after: await readTheme() }));

const dataTheme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const storedTheme = () => page.evaluate(() => localStorage.getItem('fothering-theme'));
const ground = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim());
const checkedRadio = () => page.evaluate((selector) => {
  const radio = document.querySelector(selector + ':checked');
  return radio === null ? null : radio.value;
}, RADIOS);
const reload = () => page.reload({ waitUntil: 'load' });
const choose = (value) => page.check(RADIOS + '[value="' + value + '"]');

const readFonts = () => page.evaluate((job) => {
  const faces = Array.from(document.fonts);
  const named = (face) => face.family.replace(/^["']|["']$/g, '');
  return {
    families: job.families.map((family) => ({
      family,
      loaded: faces.some((face) => named(face) === family && face.status === 'loaded'),
      check: document.fonts.check('16px "' + family + '"'),
    })),
    control: { family: job.control, present: faces.some((face) => named(face) === job.control) },
  };
}, { families: JOB.families, control: CONTROL_FAMILY });

const switchRun = async (route) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.evaluate(() => localStorage.clear());
  await reload();
  const chosen = [];
  for (const choice of ['light', 'dark']) {
    await choose(choice);
    const stored = await storedTheme();
    await reload();
    chosen.push({ choice, stored, reloadedTheme: await dataTheme(), reloadedChecked: await checkedRadio() });
  }
  await choose('device');
  const deviceStored = await storedTheme();
  const light = await ground();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const osFlip = { light, dark: await ground() };
  const invalid = [];
  for (const value of ['blue', '', 'DARK']) {
    await page.evaluate((stored) => localStorage.setItem('fothering-theme', stored), value);
    await reload();
    invalid.push({ stored: value, checked: await checkedRadio() });
  }
  await page.evaluate(() => localStorage.clear());
  await reload();
  const domOrder = await page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).map((radio) => radio.value), RADIOS);
  const boxOrders = [];
  for (const width of JOB.widths) {
    await page.setViewportSize({ width, height: 900 });
    const order = await page.evaluate((selector) => Array.from(document.querySelectorAll(selector))
      .map((radio) => ({ value: radio.value, left: radio.getBoundingClientRect().left }))
      .sort((first, second) => first.left - second.left)
      .map((item) => item.value), RADIOS);
    boxOrders.push({ width, order });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.focus(RADIOS + ':checked');
  const before = await dataTheme();
  await page.keyboard.press('ArrowRight');
  const arrow = { before, after: await dataTheme() };
  return { route, deviceStored, chosen, osFlip, invalid, domOrder, boxOrders, arrow };
};

// Every route is loaded fresh with the request list emptied, so each page's requests are its own.
for (const route of JOB.routes) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  requests = [];
  await page.goto(JOB.base + route, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForLoadState('networkidle');
  console.log('FONTS ' + JSON.stringify(Object.assign({ route }, await readFonts())));
  console.log('REQUESTS ' + JSON.stringify({ route, page: page.url(), requests: requests.slice() }));
  console.log('SWITCH ' + JSON.stringify(await switchRun(route)));
}

const FLOW_SWITCHES = 'button[data-flow-switch]';
const runningAnimations = () => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length);
const settle = () => page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(true))))));
const visibleFlowSwitches = () => page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).map((button, index) => {
  const box = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  return { index, label: button.textContent.trim(), width: box.width, height: box.height, visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' };
}).filter((control) => control.visible), FLOW_SWITCHES);
const flowLabels = async () => (await visibleFlowSwitches()).map((control) => control.label);
// Each reading starts from a known stored choice and motion preference, then a fresh load.
const loadFlow = async (route, width, stored, motion) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: motion });
  // Only the flow key changes, so the storage reading after the run still holds the theme key the
  // switch run wrote.
  await page.evaluate((value) => {
    if (value === null) localStorage.removeItem('fothering-flow');
    else localStorage.setItem('fothering-flow', value);
  }, stored);
  await page.goto(JOB.base + route, { waitUntil: 'load' });
  await settle();
};

// Whether a route moves is read from its running animations, never from a marker on the page.
const flowRun = async (route, width) => {
  await loadFlow(route, width, null, 'no-preference');
  const movingOnLoad = (await runningAnimations()) > 0;
  const controls = await visibleFlowSwitches();
  for (const control of controls) {
    const label = await page.evaluate((args) => document.querySelectorAll(args.selector)[args.index].textContent.trim(), { selector: FLOW_SWITCHES, index: control.index });
    if (label === 'Stop flow') await page.locator(FLOW_SWITCHES).nth(control.index).click();
  }
  await settle();
  const afterClick = { running: await runningAnimations(), labels: await flowLabels() };
  await page.reload({ waitUntil: 'load' });
  await settle();
  const afterReload = { running: await runningAnimations(), labels: await flowLabels() };
  await loadFlow(route, width, null, 'reduce');
  const reduced = await runningAnimations();
  await loadFlow(route, width, 'running', 'reduce');
  const storedRunningReduced = await runningAnimations();
  await loadFlow(route, width, 'stopped', 'no-preference');
  const storedStopped = await runningAnimations();
  return {
    route, width, movingOnLoad,
    controls: controls.map((control) => ({ label: control.label, width: control.width, height: control.height })),
    afterClick, afterReload, reduced, storedRunningReduced, storedStopped,
  };
};

// A flow switch's section is its numbered row; the next section's first focusable is the first one
// in the document after that row. Both are tagged, then a Tab walk records when each is reached.
const tabFlowRun = async (route, width) => {
  await loadFlow(route, width, null, 'reduce');
  const pairs = await page.evaluate((selector) => {
    const focusable = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const all = Array.from(document.querySelectorAll(focusable)).filter(visible);
    const flows = Array.from(document.querySelectorAll(selector)).filter(visible);
    return flows.map((button, index) => {
      button.setAttribute('data-tab-probe', 'flow-' + index);
      const section = button.closest('.row') || button.parentElement;
      const next = all.find((element) => !section.contains(element) && (section.compareDocumentPosition(element) & window.Node.DOCUMENT_POSITION_FOLLOWING));
      if (next) next.setAttribute('data-tab-probe', (next.getAttribute('data-tab-probe') || '') + ' next-' + index);
      return { index, hasNext: Boolean(next) };
    });
  }, FLOW_SWITCHES);
  const steps = new Map();
  if (pairs.length > 0) {
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
    });
    const limit = await page.evaluate(() => document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]').length + 4);
    for (let step = 1; step <= limit; step += 1) {
      await page.keyboard.press('Tab');
      const probe = await page.evaluate(() => (document.activeElement ? document.activeElement.getAttribute('data-tab-probe') : null));
      for (const tag of (probe || '').split(' ').filter((item) => item !== '')) {
        if (!steps.has(tag)) steps.set(tag, step);
      }
    }
  }
  const flows = pairs.map((pair) => ({
    flowStep: steps.has('flow-' + pair.index) ? steps.get('flow-' + pair.index) : null,
    nextStep: pair.hasNext && steps.has('next-' + pair.index) ? steps.get('next-' + pair.index) : null,
  }));
  return { route, width, flows };
};

// Rendered lines are found by walking each character's box: a character whose vertical middle sits
// below the current line's bottom starts a new line, so a smaller inline face never splits a line.
// Installed on the page after every load, since evaluated functions share no scope.
const installLineWalker = () => page.evaluate(() => {
  window.fotheringLines = (root) => {
    const lines = [];
    let current = null;
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getClientRects()[0];
        const char = node.data[offset];
        if (!rect || rect.width === 0) {
          if (current && /\s/.test(char)) current.text += ' ';
          continue;
        }
        const middle = (rect.top + rect.bottom) / 2;
        if (current === null || middle > current.bottom) {
          current = { text: '', bottom: rect.bottom };
          lines.push(current);
        }
        current.bottom = Math.max(current.bottom, rect.bottom);
        current.text += char;
      }
      node = walker.nextNode();
    }
    return lines.map((line) => line.text.replace(/\s+/g, ' ').trim()).filter((text) => text !== '');
  };
  return true;
});

const linesRun = async (route) => {
  await loadFlow(route, 1440, null, 'reduce');
  await installLineWalker();
  const measured = await page.evaluate(() => {
    const lines = [];
    let blocks = 0;
    for (const block of document.querySelectorAll('p, li, td, dd')) {
      if (block.closest('svg')) continue;
      const texts = window.fotheringLines(block);
      if (texts.length > 0) blocks += 1;
      lines.push(...texts);
    }
    return { blocks, lines };
  });
  return { route, blocks: measured.blocks, lines: measured.lines };
};

const narrowRun = async (route) => {
  await loadFlow(route, 320, null, 'reduce');
  await installLineWalker();
  return page.evaluate((path) => {
    const boxOf = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const tag = Array.from(document.querySelectorAll('[data-tag]')).find(shown);
    const drawings = Array.from(document.querySelectorAll('svg[data-drawing]')).filter(shown).map((svg) => ({
      box: boxOf(svg),
      texts: Array.from(svg.querySelectorAll('text')).filter(shown).map((text) => ({ text: text.textContent.trim(), box: boxOf(text) })),
    }));
    const identifiers = Array.from(document.querySelectorAll('[data-identifier]')).filter(shown)
      .map((element) => ({ text: element.textContent, lines: window.fotheringLines(element) }));
    return { route: path, tag: tag ? boxOf(tag) : null, drawings, identifiers };
  }, route);
};

for (const route of JOB.routes) {
  for (const width of JOB.widths) {
    console.log('FLOW ' + JSON.stringify(await flowRun(route, width)));
    console.log('TABFLOW ' + JSON.stringify(await tabFlowRun(route, width)));
  }
  console.log('LINES ' + JSON.stringify(await linesRun(route)));
  console.log('NARROW ' + JSON.stringify(await narrowRun(route)));
}

const storage = await page.evaluate(() => {
  const keysOf = (area) => {
    const keys = [];
    for (let index = 0; index < area.length; index += 1) keys.push(area.key(index));
    return keys;
  };
  return { local: keysOf(localStorage), session: keysOf(window.sessionStorage) };
});
console.log('STORAGE ' + JSON.stringify(storage));

for (const error of consoleErrors) console.log('CONSOLE ' + JSON.stringify({ type: 'error', text: error.text, url: error.url }));
console.log('done');
