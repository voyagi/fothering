import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../test/planted-dist.js';
import { FLOW_CHOICES, initFlowSwitch, initThemeSwitch, known, THEME_CHOICES, type ChromeDeps } from './chrome.js';

type Listener = (event: Record<string, unknown>) => void;

class Target {
  readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class Radio extends Target {
  checked = false;

  constructor(readonly value: string) {
    super();
  }
}

class Button extends Target {
  textContent: string | null = 'Stop flow';
}

interface PageOptions {
  readonly radios?: readonly string[];
  readonly buttons?: number;
  readonly readyState?: string;
  readonly reduce?: boolean;
  readonly stored?: Readonly<Record<string, string>>;
  readonly storage?: 'works' | 'throws';
  readonly attrs?: Readonly<Record<string, string>>;
}

// A page reduced to what chrome.ts touches: the root's attributes, the radios and flow controls it
// queries, document and window events, one reduced-motion query and a recording storage.
function makePage(options: PageOptions = {}) {
  const attrs = new Map<string, string>(Object.entries(options.attrs ?? {}));
  const store = new Map<string, string>(Object.entries(options.stored ?? {}));
  const writes: string[] = [];
  const radios = (options.radios ?? ['device', 'light', 'dark']).map((value) => new Radio(value));
  const buttons = Array.from({ length: options.buttons ?? 0 }, () => new Button());
  const media = Object.assign(new Target(), { matches: options.reduce ?? false });
  const root = {
    getAttribute: (name: string): string | null => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string): void => { attrs.set(name, String(value)); },
    removeAttribute: (name: string): void => { attrs.delete(name); },
  };
  const doc = Object.assign(new Target(), {
    documentElement: root,
    readyState: options.readyState ?? 'interactive',
    querySelectorAll: (selector: string): unknown[] => {
      if (selector === 'input[type="radio"][name="theme"]') return radios;
      if (selector === 'button[data-flow-switch]') return buttons;
      return [];
    },
  });
  const win = Object.assign(new Target(), { matchMedia: (query: string) => (query === '(prefers-reduced-motion: reduce)' ? media : Object.assign(new Target(), { matches: false })) });
  const fail = (): never => {
    throw new Error('SecurityError');
  };
  const storage = {
    getItem: (key: string): string | null => (options.storage === 'throws' ? fail() : store.get(key) ?? null),
    setItem: (key: string, value: string): void => {
      if (options.storage === 'throws') fail();
      writes.push(key);
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      if (options.storage === 'throws') fail();
      writes.push(key);
      store.delete(key);
    },
  };
  const deps = {
    document: doc,
    window: win,
    storage: () => (options.storage === 'throws' ? fail() : storage),
  } as unknown as ChromeDeps;
  // A radio change the way the browser makes one: the chosen radio checked, the others cleared.
  const choose = (value: string): void => {
    const radio = radios.find((item) => item.value === value);
    if (radio === undefined) throw new Error(`no radio ${value}`);
    for (const item of radios) item.checked = item === radio;
    radio.dispatch('change');
  };
  const checked = (): string[] => radios.filter((item) => item.checked).map((item) => item.value);
  return { attrs, store, writes, radios, buttons, media, doc, win, deps, choose, checked };
}

describe('known (D-141, AC-E29)', () => {
  it('returns a listed value and null for anything else', () => {
    expect(known('dark', THEME_CHOICES)).toBe('dark');
    expect(known('device', THEME_CHOICES)).toBe('device');
    expect(known('stopped', FLOW_CHOICES)).toBe('stopped');
    for (const value of ['DARK', ' dark', 'blue', '', null, undefined, 1, {}]) expect(known(value, THEME_CHOICES), String(value)).toBeNull();
    expect(known('dark', FLOW_CHOICES)).toBeNull();
  });
});

describe('initThemeSwitch (AC-41 unit half, AC-E17, AC-E29, D-141)', () => {
  it('choosing Device removes data-theme and the stored key', () => {
    const page = makePage({ stored: { 'fothering-theme': 'dark' }, attrs: { 'data-theme': 'dark' } });
    initThemeSwitch(page.deps);
    page.choose('device');
    expect(page.attrs.has('data-theme')).toBe(false);
    expect(page.store.has('fothering-theme')).toBe(false);
  });

  it('choosing Light or Dark sets data-theme and stores the choice', () => {
    const page = makePage();
    initThemeSwitch(page.deps);
    page.choose('light');
    expect(page.attrs.get('data-theme')).toBe('light');
    expect(page.store.get('fothering-theme')).toBe('light');
    page.choose('dark');
    expect(page.attrs.get('data-theme')).toBe('dark');
    expect(page.store.get('fothering-theme')).toBe('dark');
  });

  it('ignores an input value outside device, light and dark', () => {
    const page = makePage({ radios: ['device', 'light', 'dark', 'blue'] });
    initThemeSwitch(page.deps);
    page.choose('blue');
    expect(page.attrs.has('data-theme')).toBe(false);
    expect(page.writes).toEqual([]);
  });

  it('checks the stored choice at once when the document has finished parsing', () => {
    const page = makePage({ stored: { 'fothering-theme': 'light' } });
    initThemeSwitch(page.deps);
    expect(page.checked()).toEqual(['light']);
  });

  it('waits for DOMContentLoaded while the document is still loading', () => {
    const page = makePage({ stored: { 'fothering-theme': 'dark' }, readyState: 'loading' });
    initThemeSwitch(page.deps);
    expect(page.checked()).toEqual([]);
    page.doc.dispatch('DOMContentLoaded');
    expect(page.checked()).toEqual(['dark']);
  });

  it.each(['blue', '', 'DARK', 'device'])('a stored %j checks Device and sets no data-theme', (value) => {
    const page = makePage({ stored: { 'fothering-theme': value } });
    initThemeSwitch(page.deps);
    expect(page.checked()).toEqual(['device']);
    expect(page.attrs.has('data-theme')).toBe(false);
  });

  it('a storage event rereads storage and resyncs, ignoring the event newValue', () => {
    const page = makePage({ stored: { 'fothering-theme': 'dark' }, attrs: { 'data-theme': 'dark' } });
    initThemeSwitch(page.deps);
    page.store.set('fothering-theme', 'light');
    page.win.dispatch('storage', { key: 'fothering-theme', newValue: 'dark' });
    expect(page.attrs.get('data-theme')).toBe('light');
    expect(page.checked()).toEqual(['light']);
    page.store.delete('fothering-theme');
    page.win.dispatch('storage', { key: null, newValue: null });
    expect(page.attrs.has('data-theme')).toBe(false);
    expect(page.checked()).toEqual(['device']);
  });

  it('a storage event for another key changes nothing', () => {
    const page = makePage({ stored: { 'fothering-theme': 'dark' }, attrs: { 'data-theme': 'dark' } });
    initThemeSwitch(page.deps);
    page.store.set('fothering-theme', 'light');
    page.win.dispatch('storage', { key: 'fothering-flow', newValue: 'stopped' });
    expect(page.attrs.get('data-theme')).toBe('dark');
  });

  it('a pageshow with persisted rereads storage, one without it does not', () => {
    const page = makePage({ stored: { 'fothering-theme': 'dark' }, attrs: { 'data-theme': 'dark' } });
    initThemeSwitch(page.deps);
    page.store.set('fothering-theme', 'light');
    page.win.dispatch('pageshow', { persisted: false });
    expect(page.attrs.get('data-theme')).toBe('dark');
    page.win.dispatch('pageshow', { persisted: true });
    expect(page.attrs.get('data-theme')).toBe('light');
    expect(page.checked()).toEqual(['light']);
  });

  it('with every storage call throwing, the switch still changes the theme for the session', () => {
    const page = makePage({ storage: 'throws' });
    expect(() => initThemeSwitch(page.deps)).not.toThrow();
    expect(page.checked()).toEqual(['device']);
    expect(() => page.choose('dark')).not.toThrow();
    expect(page.attrs.get('data-theme')).toBe('dark');
    page.win.dispatch('pageshow', { persisted: true });
    page.win.dispatch('storage', { key: 'fothering-theme' });
    expect(page.attrs.get('data-theme')).toBe('dark');
  });

  it('is a no-op on a page with no theme radios', () => {
    const page = makePage({ radios: [], stored: { 'fothering-theme': 'dark' } });
    initThemeSwitch(page.deps);
    expect(page.win.listeners.size).toBe(0);
    expect(page.doc.listeners.size).toBe(0);
    expect(page.attrs.size).toBe(0);
  });
});

describe('initFlowSwitch (AC-43 and AC-E31 unit half, D-141)', () => {
  const labels = (page: ReturnType<typeof makePage>): (string | null)[] => page.buttons.map((button) => button.textContent);

  it('with no stored flow, a reduce preference stops the flow and no preference runs it', () => {
    const reduced = makePage({ buttons: 1, reduce: true });
    initFlowSwitch(reduced.deps);
    expect(labels(reduced)).toEqual(['Run flow']);
    const moving = makePage({ buttons: 1, reduce: false });
    initFlowSwitch(moving.deps);
    expect(labels(moving)).toEqual(['Stop flow']);
  });

  it('a stored running runs under reduce and a stored stopped stops without it', () => {
    const running = makePage({ buttons: 1, reduce: true, stored: { 'fothering-flow': 'running' } });
    initFlowSwitch(running.deps);
    expect(labels(running)).toEqual(['Stop flow']);
    expect(running.attrs.get('data-flow')).toBe('running');
    const stopped = makePage({ buttons: 1, reduce: false, stored: { 'fothering-flow': 'stopped' } });
    initFlowSwitch(stopped.deps);
    expect(labels(stopped)).toEqual(['Run flow']);
  });

  it('ignores a stored flow outside stopped and running', () => {
    const page = makePage({ buttons: 1, reduce: true, stored: { 'fothering-flow': 'paused' } });
    initFlowSwitch(page.deps);
    expect(page.attrs.has('data-flow')).toBe(false);
    expect(labels(page)).toEqual(['Run flow']);
  });

  it('a click toggles the flow, stores stopped or running and relabels every flow control', () => {
    const page = makePage({ buttons: 2 });
    initFlowSwitch(page.deps);
    page.buttons[0]?.dispatch('click');
    expect(page.attrs.get('data-flow')).toBe('stopped');
    expect(page.store.get('fothering-flow')).toBe('stopped');
    expect(labels(page)).toEqual(['Run flow', 'Run flow']);
    page.buttons[1]?.dispatch('click');
    expect(page.attrs.get('data-flow')).toBe('running');
    expect(page.store.get('fothering-flow')).toBe('running');
    expect(labels(page)).toEqual(['Stop flow', 'Stop flow']);
  });

  it('a click survives storage throwing and still toggles for the session', () => {
    const page = makePage({ buttons: 1, storage: 'throws' });
    expect(() => initFlowSwitch(page.deps)).not.toThrow();
    expect(() => page.buttons[0]?.dispatch('click')).not.toThrow();
    expect(page.attrs.get('data-flow')).toBe('stopped');
    expect(labels(page)).toEqual(['Run flow']);
  });

  it('the label follows a live reduced-motion change while nothing is stored', () => {
    const page = makePage({ buttons: 1, reduce: false });
    initFlowSwitch(page.deps);
    page.media.matches = true;
    page.media.dispatch('change');
    expect(labels(page)).toEqual(['Run flow']);
  });

  it('waits for DOMContentLoaded while the document is still loading', () => {
    const page = makePage({ buttons: 1, reduce: true, readyState: 'loading' });
    initFlowSwitch(page.deps);
    expect(labels(page)).toEqual(['Stop flow']);
    page.doc.dispatch('DOMContentLoaded');
    expect(labels(page)).toEqual(['Run flow']);
  });

  it('is a no-op on a page with no flow controls', () => {
    const page = makePage({ buttons: 0, stored: { 'fothering-flow': 'stopped' } });
    initFlowSwitch(page.deps);
    expect(page.media.listeners.size).toBe(0);
    expect(page.attrs.size).toBe(0);
  });
});

describe('storage keys (AC-22, AC-P11)', () => {
  it('writes only fothering-theme and fothering-flow, whatever the visitor does', () => {
    const page = makePage({ buttons: 2 });
    initThemeSwitch(page.deps);
    initFlowSwitch(page.deps);
    for (const value of ['dark', 'light', 'device', 'dark']) page.choose(value);
    page.buttons[0]?.dispatch('click');
    page.buttons[1]?.dispatch('click');
    page.win.dispatch('storage', { key: 'fothering-theme' });
    page.win.dispatch('pageshow', { persisted: true });
    expect(page.writes.length).toBeGreaterThan(0);
    expect(new Set(page.writes)).toEqual(new Set(['fothering-theme', 'fothering-flow']));
  });

  it('never names sessionStorage in the shipped source', () => {
    expect(readFileSync(join(REPO_ROOT, 'packages', 'web', 'src', 'client', 'chrome.ts'), 'utf8')).not.toMatch(/sessionStorage/);
  });
});
