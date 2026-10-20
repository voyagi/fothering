export const THEME_CHOICES = ['device', 'light', 'dark'] as const;

type ThemeChoice = (typeof THEME_CHOICES)[number];

// Device is the absence of a stored key, so only these two are ever read back as a stored theme.
const STORED_THEMES = ['light', 'dark'] as const;
const THEME_KEY = 'fothering-theme';
const THEME_RADIOS = 'input[type="radio"][name="theme"]';

export interface ChromeDeps {
  readonly document: Document;
  readonly window: Window;
  // A getter, because reading window.localStorage itself throws where storage is blocked.
  readonly storage: () => Storage;
}

// Storage, the radios' values and the root's attributes are all outside input; nothing outside the
// listed choices is ever applied or stored (AC-E29).
export function known<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === 'string' && (choices as readonly string[]).includes(value) ? (value as T) : null;
}

function read(deps: ChromeDeps, key: string): string | null {
  try {
    return deps.storage().getItem(key);
  } catch {
    return null;
  }
}

// A blocked or full storage leaves the choice applied for this page view only.
function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // Nothing to do: the page already shows the choice.
  }
}

// Loaded as a module it runs after parsing, but injected or loaded early it must still wait.
function whenParsed(doc: Document, run: () => void): void {
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', run);
  else run();
}

export function initThemeSwitch(deps: ChromeDeps): void {
  const doc = deps.document;
  whenParsed(doc, () => {
    const radios = Array.from(doc.querySelectorAll<HTMLInputElement>(THEME_RADIOS));
    if (radios.length === 0) return;
    const root = doc.documentElement;
    const apply = (choice: ThemeChoice): void => {
      if (choice === 'device') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', choice);
      for (const radio of radios) radio.checked = radio.value === choice;
    };
    const storedChoice = (): ThemeChoice => known(read(deps, THEME_KEY), STORED_THEMES) ?? 'device';
    // The stored value this page view last saw. A different one later means a choice was made in
    // another tab, or on another page before Back restored this one; storage is reread rather than a
    // storage event's newValue trusted, so tabs converge on what is actually stored (AC-E17).
    let seen = read(deps, THEME_KEY);
    const follow = (): void => {
      const now = read(deps, THEME_KEY);
      if (now === seen) return;
      seen = now;
      apply(storedChoice());
    };
    for (const radio of radios) {
      radio.addEventListener('change', () => {
        const choice = known(radio.value, THEME_CHOICES);
        if (choice === null || !radio.checked) return;
        attempt(() => {
          const storage = deps.storage();
          if (choice === 'device') storage.removeItem(THEME_KEY);
          else storage.setItem(THEME_KEY, choice);
        });
        seen = read(deps, THEME_KEY);
        apply(choice);
      });
    }
    deps.window.addEventListener('storage', (event) => {
      if (event.key === null || event.key === THEME_KEY) follow();
    });
    deps.window.addEventListener('pageshow', (event) => {
      if (event.persisted) follow();
    });
    apply(storedChoice());
  });
}

if (typeof document !== 'undefined') {
  initThemeSwitch({ document, window, storage: () => window.localStorage });
}
