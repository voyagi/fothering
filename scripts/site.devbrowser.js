// site.devbrowser.js - the dev-browser (QuickJS) driver template behind the rendered step of
// npm run test:e2e. The harness in packages/web/src/harness writes one copy with its job in place of
// the token below, serves the build under its real _headers, runs this, and owns every verdict; this
// file only does page work and prints one `<CHECK> <json>` line per check, then `done`.
const JOB = /* fothering-job */ null;

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
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

for (const text of consoleErrors) console.log('CONSOLE ' + JSON.stringify({ type: 'error', text }));
console.log('done');
