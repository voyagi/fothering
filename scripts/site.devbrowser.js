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
      .map((element) => ({
        text: element.textContent,
        lines: window.fotheringLines(element),
        ...(element.hasAttribute('data-identifier-words') ? { parts: Array.from(element.children).filter((child) => child.tagName === 'SPAN').map((child) => child.textContent) } : {}),
      }));
    return { route: path, tag: tag ? boxOf(tag) : null, drawings, identifiers };
  }, route);
};

// The stem shown between the closed valve and the hung tag: a walk down the stem's line until the
// card is the element hit there, with the tag scrolled into view so every point can be hit.
const hangRun = async (route, width) => {
  await loadFlow(route, width, null, 'reduce');
  return page.evaluate((args) => {
    // A vertical stem has no width, so a part counts as shown when either side has length.
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    };
    const tag = Array.from(document.querySelectorAll('[data-tag]')).find(shown);
    const valve = Array.from(document.querySelectorAll('[data-lane-state="closed"] .dwg-valve-shut')).find(shown);
    const stem = Array.from(document.querySelectorAll('[data-lane-state="closed"] .dwg-stem')).find(shown);
    if (!tag || !valve || !stem) return { route: args.route, width: args.width, hanging: false, visibleStem: 0, tagTop: 0, valveBottom: 0 };
    tag.scrollIntoView({ block: 'center' });
    const valveBox = valve.getBoundingClientRect();
    const stemBox = stem.getBoundingClientRect();
    const x = stemBox.left + stemBox.width / 2;
    let visibleStem = 0;
    for (let y = Math.ceil(valveBox.bottom) + 1; y < valveBox.bottom + 400; y += 1) {
      const hit = document.elementFromPoint(x, y);
      if (hit === null || hit.closest('[data-tag]')) break;
      visibleStem += 1;
    }
    return { route: args.route, width: args.width, hanging: true, visibleStem, tagTop: tag.getBoundingClientRect().top, valveBottom: valveBox.bottom };
  }, { route, width });
};

for (const route of JOB.routes) {
  for (const width of JOB.hangWidths) console.log('HANG ' + JSON.stringify(await hangRun(route, width)));
  for (const width of JOB.widths) {
    console.log('FLOW ' + JSON.stringify(await flowRun(route, width)));
    console.log('TABFLOW ' + JSON.stringify(await tabFlowRun(route, width)));
  }
  console.log('LINES ' + JSON.stringify(await linesRun(route)));
  console.log('NARROW ' + JSON.stringify(await narrowRun(route)));
}

// The replay's stepping, read from the page itself: the step is the one panel the stylesheet shows,
// and control boxes are read at the top of the page, where a narrow screen's sticky controls still
// sit in the flow.
const REPLAY_CONTROLS = ['[data-replay-previous]', '[data-replay-next]', '[data-replay-goto="1"]', '[data-replay-goto="2"]', '[data-replay-goto="3"]', '[data-replay-goto="4"]'];
const shownStep = () => page.evaluate(() => {
  const shown = Array.from(document.querySelectorAll('[data-wordcount="step"]')).filter((panel) => getComputedStyle(panel).display !== 'none');
  return shown.length === 1 ? Number(shown[0].getAttribute('data-steps')) : 0;
});
const controlBoxes = () => page.evaluate((selectors) => {
  window.scrollTo(0, 0);
  return selectors.map((selector) => document.querySelector(selector)).filter((element) => element !== null).map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  });
}, REPLAY_CONTROLS);
const isDisabled = (selector) => page.evaluate((target) => {
  const element = document.querySelector(target);
  return element !== null && element.disabled === true;
}, selector);
// A hash-only goto stays in the same document, so every load is followed by a reload.
const loadReplay = async (width, hash) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(JOB.base + JOB.replayRoute + hash, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await settle();
};
const pressMove = async (focusSelector, key) => {
  const before = await shownStep();
  await page.focus(focusSelector);
  await page.keyboard.press(key);
  await settle();
  return { before, after: await shownStep() };
};

const replayRun = async (width) => {
  await loadReplay(width, '');
  const historyBefore = await page.evaluate(() => window.history.length);
  const boxes = [await controlBoxes()];
  const previousDisabledFirst = await isDisabled('[data-replay-previous]');
  const afterNext = [];
  for (let step = 0; step < 3; step += 1) {
    await page.click('[data-replay-next]');
    afterNext.push(await shownStep());
    boxes.push(await controlBoxes());
  }
  const nextDisabledLast = await isDisabled('[data-replay-next]');
  // A disabled button ignores a click, which is what a fourth activation must do.
  await page.evaluate(() => document.querySelector('[data-replay-next]').click());
  const afterFourth = await shownStep();
  const buttons = [];
  for (const step of [1, 2, 3, 4]) {
    await page.click('[data-replay-goto="' + step + '"]');
    buttons.push(await shownStep());
  }
  await page.click('[data-replay-previous]');
  const historyAfter = await page.evaluate(() => window.history.length);
  const deepLinks = [];
  for (const step of [1, 2, 3, 4]) {
    await loadReplay(width, '#step-' + step);
    deepLinks.push({ hash: '#step-' + step, shown: await shownStep() });
  }
  const invalid = [];
  for (const hash of JOB.invalidHashes) {
    await loadReplay(width, hash);
    invalid.push({ hash, shown: await shownStep() });
  }
  await loadReplay(width, '#step-2');
  const sameStepMutations = await page.evaluate(() => new Promise((resolve) => {
    let count = 0;
    const observer = new window.MutationObserver((records) => { count += records.length; });
    observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      observer.disconnect();
      resolve(count);
    }));
  }));
  await loadReplay(width, '');
  const arrow = await pressMove('[data-replay-goto="1"]', 'ArrowRight');
  const radio = await pressMove('input[name="theme"]:checked', 'ArrowRight');
  const modifiers = [];
  for (const modifier of ['Alt', 'Control', 'Meta', 'Shift']) {
    modifiers.push({ modifier, ...(await pressMove('[data-replay-goto="2"]', modifier + '+ArrowRight')) });
  }
  return {
    route: JOB.replayRoute, width, boxes, afterNext, afterFourth, buttons, previousDisabledFirst, nextDisabledLast,
    deepLinks, invalid, sameStepMutations, historyBefore, historyAfter, arrow, radio, modifiers,
  };
};

// The stylesheet reads only the root's js class, so removing it gives the no-JavaScript reading.
const noScriptRun = async (width) => {
  await loadReplay(width, '');
  return page.evaluate((args) => {
    document.documentElement.classList.remove('js');
    const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const panels = Array.from(document.querySelectorAll('[data-wordcount="step"]')).filter(shown).map((panel) => panel.getAttribute('data-steps'));
    const controls = args.selectors.map((selector) => document.querySelector(selector)).filter((element) => element !== null && shown(element)).length;
    const boardParts = Array.from(document.querySelectorAll('svg[data-drawing="board"] [data-steps]')).map((part) => ({ steps: part.getAttribute('data-steps'), displayed: part.getClientRects().length > 0 }));
    const tag = document.querySelector('[data-tag]');
    return { route: args.route, width: args.width, panels, controls, boardParts, tagShown: tag !== null && shown(tag) };
  }, { route: JOB.replayRoute, width, selectors: REPLAY_CONTROLS });
};

// The replay's layout, each step loaded by its deep link: the board's height and whether the tag's
// drawn place shows; on step 2 the evidence schedule's right edge against its panel's; on step 4,
// with every log row shown, each row's cell baselines and every identifier's computed weight. A
// zero-size inline block set just before a cell's first text sits on that line's baseline, so its
// bottom edge is the baseline; it is removed straight after.
const layoutStep = (step) => page.evaluate((args) => {
  const round = (value) => Math.round(value * 100) / 100;
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const board = document.querySelector('[data-replay] .board');
  const phantoms = Array.from(document.querySelectorAll('[data-tag-phantom]'));
  const reading = {
    step: args.step,
    scrollWidth: document.documentElement.scrollWidth,
    boardHeight: board === null ? 0 : round(board.getBoundingClientRect().height),
    phantom: phantoms.some(visible),
    phantomExposed: phantoms.filter((element) => element.closest('[aria-hidden="true"]') === null).length,
  };
  const { NodeFilter: filter } = window;
  const textNodes = (element) => {
    const walker = document.createTreeWalker(element, filter.SHOW_TEXT, { acceptNode: (node) => (node.textContent.trim() === '' ? filter.FILTER_SKIP : filter.FILTER_ACCEPT) });
    const nodes = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
    return nodes;
  };
  // An identifier's rendered lines: a character that starts left of the one before it opens a new
  // line. Tops are not compared, since the hung tag is tilted and its one line climbs as it runs.
  const linesOf = (element) => {
    const lines = [];
    let left = null;
    for (const node of textNodes(element)) {
      for (let index = 0; index < node.textContent.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (left === null || rect.left < left - 1) lines.push('');
        left = rect.left;
        lines[lines.length - 1] += node.textContent[index];
      }
    }
    return lines;
  };
  // Every identifier this step shows, the log's mono cells (times and lane names) included; a
  // word-mode API name carries its word parts, whose ends are its allowed breaks.
  const partsOf = (element) => (element.hasAttribute('data-identifier-words')
    ? { parts: Array.from(element.children).filter((child) => child.tagName === 'SPAN').map((child) => child.textContent) } : {});
  const faceOf = (element) => (element.hasAttribute('data-identifier-face') ? { face: element.getAttribute('data-identifier-face') } : {});
  reading.identifiers = Array.from(document.querySelectorAll('[data-identifier], tr[data-log-step] .mono')).filter(visible)
    .map((element) => {
      const style = getComputedStyle(element);
      return { text: element.textContent.trim(), weight: style.fontWeight, family: style.fontFamily, lines: linesOf(element), ...partsOf(element), ...faceOf(element) };
    });
  // Text outside every identifier: drawings, command blocks and hidden parts aside.
  const plainNodes = (root) => textNodes(root).filter((node) => {
    const parent = node.parentElement;
    return parent.closest('[data-identifier], svg, pre, script, style') === null && visible(parent);
  });
  // A listed SES API name left as plain text in a log Detail cell.
  reading.plainApiNames = Array.from(document.querySelectorAll('tr[data-log-step] td[data-col="Detail"]')).filter(visible)
    .flatMap((cell) => plainNodes(cell))
    .flatMap((node) => args.apiNames.filter((name) => node.textContent.includes(name)));
  // A configuration set name or tag value written as plain text anywhere on the page, as a whole
  // token: nothing word-like touches its start, and its end meets a space, punctuation or a full stop.
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenOf = (term) => new RegExp('(^|[^\\w.=-])' + escape(term) + '(?=$|[^\\w.=-]|\\.(\\s|$))');
  reading.plainTerms = plainNodes(document.body).flatMap((node) => args.terms
    .filter((term) => tokenOf(term).test(node.textContent))
    .map((term) => term + ' in ' + node.parentElement.tagName.toLowerCase()));
  if (args.step === 2) {
    const panel = document.querySelector('[data-wordcount="step"][data-steps="2"]');
    const table = panel === null ? null : panel.querySelector('table');
    reading.evidence = table === null ? null : { tableRight: round(table.getBoundingClientRect().right), panelRight: round(panel.getBoundingClientRect().right) };
  }
  if (args.step === 4) {
    const firstText = (cell) => textNodes(cell)[0] ?? null;
    const baselineOf = (cell) => {
      const text = firstText(cell);
      if (text === null) return null;
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0';
      text.parentNode.insertBefore(probe, text);
      const baseline = probe.getBoundingClientRect().bottom;
      probe.remove();
      return round(baseline);
    };
    const rows = Array.from(document.querySelectorAll('tr[data-log-step]')).filter(visible);
    const logTable = rows.length === 0 ? null : rows[0].closest('table');
    const logHead = logTable === null ? null : logTable.querySelector('thead');
    reading.logForm = logHead !== null && getComputedStyle(logHead).display !== 'none' ? 'table' : 'stack';
    reading.logHeaders = logTable === null ? [] : Array.from(logTable.querySelectorAll('thead th')).filter(visible).map((header) => {
      const style = getComputedStyle(header);
      return { text: header.textContent.trim(), type: [style.fontWeight, style.fontSize, style.letterSpacing, style.textTransform].join(' ') };
    });
    reading.logRows = rows.map((row) => ({
      header: (row.firstElementChild === null ? '' : row.firstElementChild.textContent.trim()),
      baselines: Array.from(row.children).filter(visible).map(baselineOf).filter((value) => value !== null),
    }));
  }
  return reading;
}, { step, terms: JOB.identifierTerms, apiNames: JOB.apiNames });

const layoutRun = async (width) => {
  const steps = [];
  let phantomExposed = 0;
  let evidence = null;
  let logRows = [];
  let logHeaders = [];
  const identifiers = [];
  const plainApiNames = [];
  const plainTerms = [];
  const scrollWidths = [];
  let logForm = 'stack';
  for (const step of [1, 2, 3, 4]) {
    await loadReplay(width, '#step-' + step);
    const reading = await layoutStep(step);
    steps.push({ step, boardHeight: reading.boardHeight, phantom: reading.phantom });
    scrollWidths.push(reading.scrollWidth);
    phantomExposed = Math.max(phantomExposed, reading.phantomExposed);
    if (step === 2) evidence = reading.evidence;
    if (step === 4) {
      logRows = reading.logRows;
      logHeaders = reading.logHeaders;
      logForm = reading.logForm;
    }
    for (const name of reading.plainApiNames) {
      if (!plainApiNames.includes(name)) plainApiNames.push(name);
    }
    for (const where of reading.plainTerms) {
      if (!plainTerms.includes(where)) plainTerms.push(where);
    }
    for (const item of reading.identifiers) {
      if (!identifiers.some((seen) => seen.text === item.text && seen.weight === item.weight && seen.lines.join('|') === item.lines.join('|'))) identifiers.push(item);
    }
  }
  return { route: JOB.replayRoute, width, steps, phantomExposed, evidence, logRows, identifiers, logHeaders, plainApiNames, plainTerms, scrollWidths, logForm };
};

if (JOB.routes.includes(JOB.replayRoute)) {
  for (const width of JOB.widths) {
    console.log('REPLAY ' + JSON.stringify(await replayRun(width)));
    console.log('NOSCRIPT ' + JSON.stringify(await noScriptRun(width)));
  }
  for (const width of JOB.layoutWidths) console.log('LAYOUT ' + JSON.stringify(await layoutRun(width)));
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
