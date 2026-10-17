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
