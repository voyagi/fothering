import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../test/planted-dist.js';
import { FLOW_CHOICES, initFlowSwitch, initThemeSwitch, known, THEME_CHOICES, type ChromeDeps } from './chrome.js';
import { initReplay, parseStep, type ReplayDeps } from './replay.js';

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

  it('a pageshow with persisted rereads the stored flow and relabels, one without it does not', () => {
    const page = makePage({ buttons: 1, reduce: false });
    initFlowSwitch(page.deps);
    page.store.set('fothering-flow', 'stopped');
    page.win.dispatch('pageshow', { persisted: false });
    expect(labels(page)).toEqual(['Stop flow']);
    page.win.dispatch('pageshow', { persisted: true });
    expect(page.attrs.get('data-flow')).toBe('stopped');
    expect(labels(page)).toEqual(['Run flow']);
  });

  it('a page restored from the back/forward cache labels a reduced-motion change it missed', () => {
    const page = makePage({ buttons: 1, reduce: false });
    initFlowSwitch(page.deps);
    page.media.matches = true;
    page.win.dispatch('pageshow', { persisted: true });
    expect(page.attrs.has('data-flow')).toBe(false);
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

class StandIn extends Target {
  readonly attrs = new Map<string, string>();
  readonly writes: string[] = [];
  disabled = false;
  textContent: string | null = '';
  isContentEditable = false;

  constructor(readonly owner: { activeElement: unknown }, attrs: Readonly<Record<string, string>> = {}, readonly within: readonly string[] = []) {
    super();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.writes.push(name);
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.writes.push(name);
    this.attrs.delete(name);
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  // Answers for the selectors replay.ts asks about; `within` names the form controls around it.
  closest(selector: string): StandIn | null {
    return selector.split(',').some((part) => this.within.includes(part.trim())) ? this : null;
  }
}

interface ReplayOptions {
  readonly dataStep?: string;
  readonly hash?: string;
}

// A replay page reduced to what replay.ts touches: the root's data-step, the two controls, the four
// step buttons with their clock text, the clock, the board description, and recording location and
// history stand-ins.
function makeReplay(options: ReplayOptions = {}) {
  const owner: { activeElement: unknown } = { activeElement: null };
  const root = new StandIn(owner, options.dataStep === undefined ? {} : { 'data-step': options.dataStep });
  const previous = new StandIn(owner, { 'data-replay-previous': '' });
  const next = new StandIn(owner, { 'data-replay-next': '' });
  const steps = [1, 2, 3, 4].map((step) => new StandIn(owner, { 'data-replay-goto': String(step), 'data-clock': `Step ${String(step)} of 4, 14:0${String(step)} UTC` }));
  const clock = new StandIn(owner, { 'data-replay-clock': '' });
  const desc = new StandIn(owner, Object.fromEntries([1, 2, 3, 4].map((step) => [`data-desc-${String(step)}`, `board at step ${String(step)}`])));
  const single: Record<string, StandIn> = {
    'button[data-replay-previous]': previous,
    'button[data-replay-next]': next,
    '[data-replay-clock]': clock,
  };
  const doc = Object.assign(new Target(), owner, {
    documentElement: root,
    readyState: 'interactive',
    querySelector: (selector: string): StandIn | null => single[selector] ?? null,
    querySelectorAll: (selector: string): StandIn[] => {
      if (selector === 'button[data-replay-goto]') return steps;
      if (selector === '[data-replay-desc]') return [desc];
      return [];
    },
  });
  Object.defineProperty(doc, 'activeElement', { get: () => owner.activeElement });
  const win = new Target();
  const location = { hash: options.hash ?? '' };
  const calls: string[] = [];
  const history = {
    length: 1,
    state: null,
    replaceState: (_state: unknown, _title: string, url: string): void => {
      calls.push(`replace ${url}`);
      location.hash = url;
    },
    pushState: (_state: unknown, _title: string, url: string): void => {
      calls.push(`push ${url}`);
    },
  };
  const deps = { document: doc, window: win, location, history } as unknown as ReplayDeps;
  const shown = (): string | null => root.getAttribute('data-step');
  const key = (init: Readonly<Record<string, unknown>>, target: unknown = doc): { prevented: boolean } => {
    const event = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target, prevented: false, ...init, preventDefault: () => { event.prevented = true; } };
    doc.dispatch('keydown', event);
    return event;
  };
  return { owner, root, previous, next, steps, clock, desc, doc, win, location, history, calls, deps, shown, key };
}

describe('parseStep (AC-7, AC-E5, D-149)', () => {
  it.each([1, 2, 3, 4])('reads #step-%i as that step', (step) => {
    expect(parseStep(`#step-${String(step)}`)).toBe(step);
  });

  it.each(['#step-0', '#step-5', '#step-01', '#step-1x', '#step-', '', '#', 'step-2', '#step-2 '])('reads %j as step 1', (hash) => {
    expect(parseStep(hash)).toBe(1);
  });
});

describe('initReplay (AC-4, AC-7, AC-10, AC-E5, AC-E6, AC-E30)', () => {
  it('three Next activations from step 1 reach step 4 and a fourth changes nothing', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    expect(replay.shown()).toBe('1');
    for (const expected of ['2', '3', '4']) {
      replay.next.dispatch('click');
      expect(replay.shown()).toBe(expected);
    }
    const calls = replay.calls.length;
    replay.next.dispatch('click');
    expect(replay.shown()).toBe('4');
    expect(replay.calls).toHaveLength(calls);
  });

  it('disables Previous on step 1 and Next on step 4', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    expect([replay.previous.disabled, replay.next.disabled]).toEqual([true, false]);
    replay.steps[3]?.dispatch('click');
    expect([replay.previous.disabled, replay.next.disabled]).toEqual([false, true]);
  });

  it('moves focus to the other control when the focused control becomes disabled', () => {
    const replay = makeReplay({ dataStep: '3' });
    initReplay(replay.deps);
    replay.next.focus();
    replay.next.dispatch('click');
    expect(replay.owner.activeElement).toBe(replay.previous);
    replay.steps[1]?.dispatch('click');
    replay.previous.focus();
    replay.previous.dispatch('click');
    expect(replay.shown()).toBe('1');
    expect(replay.owner.activeElement).toBe(replay.next);
  });

  it('marks the shown step button with aria-current and shows its clock and board description', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.steps[2]?.dispatch('click');
    expect(replay.steps.map((button) => button.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(replay.clock.textContent).toBe('Step 3 of 4, 14:03 UTC');
    expect(replay.desc.textContent).toBe('board at step 3');
  });

  it('starts on the step the head script wrote to data-step', () => {
    const replay = makeReplay({ dataStep: '3', hash: '#step-3' });
    initReplay(replay.deps);
    expect(replay.shown()).toBe('3');
    expect(replay.steps[2]?.getAttribute('aria-current')).toBe('step');
  });

  it.each([undefined, '7', '01', 'x'])('starts on step 1 when data-step reads %j', (dataStep) => {
    const replay = makeReplay(dataStep === undefined ? {} : { dataStep });
    initReplay(replay.deps);
    expect(replay.shown()).toBe('1');
  });

  it('a hashchange to the shown step changes no attribute', () => {
    const replay = makeReplay({ dataStep: '2', hash: '#step-2' });
    initReplay(replay.deps);
    const written = [replay.root, replay.previous, replay.next, ...replay.steps].map((element) => element.writes.length);
    replay.win.dispatch('hashchange');
    expect([replay.root, replay.previous, replay.next, ...replay.steps].map((element) => element.writes.length)).toEqual(written);
  });

  it('a hashchange to another step shows it, and an invalid hash shows step 1', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.location.hash = '#step-4';
    replay.win.dispatch('hashchange');
    expect(replay.shown()).toBe('4');
    replay.location.hash = '#step-01';
    replay.win.dispatch('hashchange');
    expect(replay.shown()).toBe('1');
    expect(replay.calls).toEqual([]);
  });

  it('Next, Previous and the step buttons replace the history entry with the digit only and never push one', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.next.dispatch('click');
    replay.steps[3]?.dispatch('click');
    replay.previous.dispatch('click');
    expect(replay.calls).toEqual(['replace #step-2', 'replace #step-4', 'replace #step-3']);
    expect(replay.history.length).toBe(1);
  });

  it('ArrowRight and ArrowLeft move one step', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.key({ key: 'ArrowRight' });
    replay.key({ key: 'ArrowRight' });
    expect(replay.shown()).toBe('3');
    replay.key({ key: 'ArrowLeft' });
    expect(replay.shown()).toBe('2');
    expect(replay.key({ key: 'ArrowRight' }, replay.steps[0]).prevented).toBe(true);
    expect(replay.shown()).toBe('3');
  });

  it('ignores keys other than the two arrows', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.key({ key: 'ArrowDown' });
    replay.key({ key: 'Enter' });
    expect(replay.shown()).toBe('1');
  });

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'])('does nothing on an arrow key with %s held', (modifier) => {
    const replay = makeReplay();
    initReplay(replay.deps);
    expect(replay.key({ key: 'ArrowRight', [modifier]: true }).prevented).toBe(false);
    expect(replay.shown()).toBe('1');
  });

  it.each([['an input', 'input'], ['a textarea', 'textarea'], ['a select', 'select']])('does nothing on an arrow key with focus in %s', (_name, control) => {
    const replay = makeReplay();
    initReplay(replay.deps);
    replay.key({ key: 'ArrowRight' }, new StandIn(replay.owner, {}, [control]));
    expect(replay.shown()).toBe('1');
  });

  it('does nothing on an arrow key with focus in a contenteditable element', () => {
    const replay = makeReplay();
    initReplay(replay.deps);
    const editable = Object.assign(new StandIn(replay.owner), { isContentEditable: true });
    replay.key({ key: 'ArrowRight' }, editable);
    expect(replay.shown()).toBe('1');
  });

  it('does nothing on an arrow key inside the theme radios, so the theme changes and the step stays (AC-E30)', () => {
    const replay = makeReplay({ dataStep: '2' });
    initReplay(replay.deps);
    const radio = new StandIn(replay.owner, { type: 'radio', name: 'theme', value: 'light' }, ['input']);
    replay.key({ key: 'ArrowRight' }, radio);
    replay.key({ key: 'ArrowLeft' }, radio);
    expect(replay.shown()).toBe('2');
  });

  it('the shipped source names no pushState and writes no markup', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', 'web', 'src', 'client', 'replay.ts'), 'utf8');
    expect(source).toContain('replaceState');
    expect(source).not.toMatch(/pushState|innerHTML|outerHTML|insertAdjacentHTML/);
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
