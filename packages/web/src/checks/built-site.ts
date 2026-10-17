import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export type BuiltChild = BuiltElement | string;

export interface BuiltElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly BuiltChild[];
  readonly inSvg: boolean;
}

export interface BuiltReference {
  readonly tag: string;
  readonly attr: string;
  readonly value: string;
  readonly rel: string | null;
}

export interface BuiltPage {
  readonly route: string;
  readonly file: string;
  readonly root: BuiltElement;
  readonly text: string;
  readonly textOutsideSvg: string;
  readonly markers: ReadonlyMap<string, readonly BuiltElement[]>;
  readonly scripts: readonly { readonly src: string | null; readonly text: string }[];
  readonly links: readonly Readonly<Record<string, string>>[];
  readonly metas: readonly Readonly<Record<string, string>>[];
  readonly forms: readonly Readonly<Record<string, string>>[];
  readonly inputs: readonly Readonly<Record<string, string>>[];
  readonly references: readonly BuiltReference[];
}

export interface BuiltFile {
  readonly file: string;
  readonly text: string;
}

export interface BuiltSite {
  readonly dist: string;
  readonly pages: readonly BuiltPage[];
  readonly css: readonly BuiltFile[];
  readonly scripts: readonly BuiltFile[];
  readonly headers: string | null;
  readonly sitemap: string | null;
  readonly robots: string | null;
}

export const NOT_FOUND_ROUTE = '404 page';

export class NoBuiltPagesError extends Error {
  constructor(readonly dist: string) {
    super(`${dist} holds no built HTML page`);
    this.name = 'NoBuiltPagesError';
  }
}

// Inline elements join their text to the neighbours'; every other element is a word boundary, so
// two list items never fuse into one word and `your <b>SES</b> bounce rate` still reads whole.
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'label', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'tspan', 'textPath',
]);
const NOT_RENDERED = new Set(['script', 'style', 'template']);
const REFERENCE_ATTRS = new Set(['href', 'src', 'srcset', 'data', 'poster']);

export function normalizeText(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

export function textOf(element: BuiltElement, skip: (element: BuiltElement) => boolean = () => false): string {
  const parts: string[] = [];
  const visit = (node: BuiltElement): void => {
    if (NOT_RENDERED.has(node.tag) || skip(node)) {
      parts.push(' ');
      return;
    }
    const boundary = INLINE_TAGS.has(node.tag) ? '' : ' ';
    parts.push(boundary);
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child);
      else visit(child);
    }
    parts.push(boundary);
  };
  visit(element);
  return normalizeText(parts.join(''));
}

export function walk(element: BuiltElement, visit: (element: BuiltElement) => void): void {
  visit(element);
  for (const child of element.children) {
    if (typeof child !== 'string') walk(child, visit);
  }
}

// Workers serves folder/index.html at /folder/ and page.html at /page.
export function routeOf(file: string): string {
  if (file === '404.html') return NOT_FOUND_ROUTE;
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file.slice(0, -'.html'.length)}`;
}

// Every file under dist as a forward-slash path relative to it, sorted, so every reader and every
// report sees the same order whatever the disk returns.
export function filesIn(dist: string): string[] {
  const files: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(dist, path).split(sep).join('/'));
    }
  };
  visit(dist);
  return files.sort();
}

type Parse5Node = DefaultTreeAdapterTypes.Node;

function convert(node: DefaultTreeAdapterTypes.Element, inSvg: boolean): BuiltElement {
  const svg = inSvg || node.tagName === 'svg';
  const attrs: Record<string, string> = {};
  for (const attr of node.attrs) attrs[attr.name] = attr.value;
  const source: readonly Parse5Node[] = node.tagName === 'template' ? (node as DefaultTreeAdapterTypes.Template).content.childNodes : node.childNodes;
  const children: BuiltChild[] = [];
  for (const child of source) {
    if (child.nodeName === '#text') children.push((child as DefaultTreeAdapterTypes.TextNode).value);
    else if ('tagName' in child) children.push(convert(child, svg));
  }
  return { tag: node.tagName, attrs, children, inSvg: svg };
}

function rootElement(html: string, file: string): BuiltElement {
  // With scripting on, parse5 reads <noscript> content as one text node; the no-JavaScript reading
  // of the replay lives there, so the rules must see it as elements.
  const document = parse(html, { scriptingEnabled: false });
  const root = document.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => 'tagName' in node);
  if (root === undefined) throw new Error(`${file}: parse5 returned no root element`);
  return convert(root, false);
}

function scriptText(element: BuiltElement): string {
  return element.children.filter((child): child is string => typeof child === 'string').join('');
}

function readPage(dist: string, file: string): BuiltPage {
  const root = rootElement(readFileSync(join(dist, file), 'utf8'), file);
  const markers = new Map<string, BuiltElement[]>();
  const scripts: { src: string | null; text: string }[] = [];
  const links: Record<string, string>[] = [];
  const metas: Record<string, string>[] = [];
  const forms: Record<string, string>[] = [];
  const inputs: Record<string, string>[] = [];
  const references: BuiltReference[] = [];
  walk(root, (element) => {
    for (const [name, value] of Object.entries(element.attrs)) {
      if (name.startsWith('data-')) markers.set(name, [...(markers.get(name) ?? []), element]);
      if (REFERENCE_ATTRS.has(name)) references.push({ tag: element.tag, attr: name, value, rel: element.attrs.rel ?? null });
    }
    if (element.tag === 'script') scripts.push({ src: element.attrs.src ?? null, text: scriptText(element) });
    else if (element.tag === 'link') links.push({ ...element.attrs });
    else if (element.tag === 'meta') metas.push({ ...element.attrs });
    else if (element.tag === 'form') forms.push({ ...element.attrs });
    else if (element.tag === 'input') inputs.push({ ...element.attrs });
  });
  return {
    route: routeOf(file),
    file,
    root,
    text: textOf(root),
    textOutsideSvg: textOf(root, (element) => element.tag === 'svg'),
    markers,
    scripts,
    links,
    metas,
    forms,
    inputs,
    references,
  };
}

const readText = (dist: string, file: string): BuiltFile => ({ file, text: readFileSync(join(dist, file), 'utf8') });

function readOptional(dist: string, file: string): string | null {
  const path = join(dist, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function loadBuiltSite(dist: string): BuiltSite {
  const files = filesIn(dist);
  // Reported in route order, the order the audit and the sitemap use.
  const pages = files.filter((file) => file.endsWith('.html')).map((file) => readPage(dist, file))
    .sort((left, right) => (left.route < right.route ? -1 : left.route > right.route ? 1 : 0));
  if (pages.length === 0) throw new NoBuiltPagesError(dist);
  return {
    dist,
    pages,
    css: files.filter((file) => file.endsWith('.css')).map((file) => readText(dist, file)),
    scripts: files.filter((file) => /\.(?:js|mjs)$/.test(file)).map((file) => readText(dist, file)),
    headers: readOptional(dist, '_headers'),
    sitemap: readOptional(dist, 'sitemap.xml'),
    robots: readOptional(dist, 'robots.txt'),
  };
}
