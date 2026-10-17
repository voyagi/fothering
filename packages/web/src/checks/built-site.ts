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
}

export const NOT_FOUND_ROUTE = '404 page';

export class NoBuiltPagesError extends Error {
  constructor(readonly dist: string) {
    super(`${dist} holds no built HTML page`);
    this.name = 'NoBuiltPagesError';
  }
}

export function loadBuiltSite(dist: string): BuiltSite {
  return { dist, pages: [], css: [], scripts: [], headers: null };
}
