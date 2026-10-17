export type StepNumber = 1 | 2 | 3 | 4;

export interface ReplayDeps {
  readonly document: Document;
  readonly window: Window;
  readonly location: Location;
  readonly history: History;
}

const FIRST: StepNumber = 1;
const LAST: StepNumber = 4;
// The head script reads the hash with this same closed pattern, and only its digit is ever used.
const STEP_HASH = /^#step-([1-4])$/;
const ROOT = '[data-replay]';
const PREVIOUS = 'button[data-replay-previous]';
const NEXT = 'button[data-replay-next]';
const GOTO = 'button[data-replay-goto]';
const CLOCK = '[data-replay-clock]';
const DESC = '[data-replay-desc]';
// Form controls own their arrow keys; the theme radios are inputs, so the theme moves and the step
// stays (AC-E30).
const OWNS_ARROWS = 'input, textarea, select';

export function parseStep(hash: string): StepNumber {
  const match = STEP_HASH.exec(hash);
  return match === null ? FIRST : (Number(match[1]) as StepNumber);
}

const clamp = (step: number): StepNumber => (Math.min(LAST, Math.max(FIRST, step)) as StepNumber);

function ownsArrowKeys(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as Partial<HTMLElement>;
  if (element.isContentEditable === true) return true;
  return typeof element.closest === 'function' && element.closest(OWNS_ARROWS) !== null;
}

function keepFocus(doc: Document, previous: HTMLButtonElement | null, next: HTMLButtonElement | null): void {
  const active = doc.activeElement;
  if (active === previous && previous?.disabled === true) next?.focus();
  else if (active === next && next?.disabled === true) previous?.focus();
}

// Visibility is CSS only: the panels, board parts and log rows carry their steps and the stylesheet
// reads the root's data-step, so this module writes attributes and text, never markup.
export function initReplay(deps: ReplayDeps): void {
  const doc = deps.document;
  const root = doc.documentElement;
  const previous = doc.querySelector<HTMLButtonElement>(PREVIOUS);
  const next = doc.querySelector<HTMLButtonElement>(NEXT);
  const gotos = Array.from(doc.querySelectorAll<HTMLButtonElement>(GOTO));
  const clock = doc.querySelector<HTMLElement>(CLOCK);
  const descriptions = Array.from(doc.querySelectorAll<Element>(DESC));
  let shown = parseStep(`#step-${root.getAttribute('data-step') ?? ''}`);

  const render = (step: StepNumber): void => {
    shown = step;
    const digit = String(step);
    root.setAttribute('data-step', digit);
    for (const button of gotos) {
      if (button.getAttribute('data-replay-goto') === digit) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    if (previous !== null) previous.disabled = step === FIRST;
    if (next !== null) next.disabled = step === LAST;
    keepFocus(doc, previous, next);
    const clockText = gotos.find((button) => button.getAttribute('data-replay-goto') === digit)?.getAttribute('data-clock');
    if (clock !== null && clockText !== null && clockText !== undefined) clock.textContent = clockText;
    for (const description of descriptions) {
      const text = description.getAttribute(`data-desc-${digit}`);
      if (text !== null) description.textContent = text;
    }
  };

  // Moving replaces the current history entry, so Back still leaves the page (AC-E6).
  const go = (step: StepNumber): void => {
    if (step === shown) return;
    render(step);
    deps.history.replaceState(deps.history.state, '', `#step-${String(step)}`);
  };

  previous?.addEventListener('click', () => go(clamp(shown - 1)));
  next?.addEventListener('click', () => go(clamp(shown + 1)));
  for (const button of gotos) {
    button.addEventListener('click', () => go(parseStep(`#step-${button.getAttribute('data-replay-goto') ?? ''}`)));
  }
  deps.window.addEventListener('hashchange', () => {
    const step = parseStep(deps.location.hash);
    if (step !== shown) render(step);
  });
  doc.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ownsArrowKeys(event.target)) return;
    event.preventDefault();
    go(clamp(shown + (event.key === 'ArrowRight' ? 1 : -1)));
  });
  render(shown);
}

if (typeof document !== 'undefined' && document.querySelector(ROOT) !== null) {
  initReplay({ document, window, location, history });
}
