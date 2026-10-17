export const SITE_ORIGIN = '';

interface PageMeta {
  readonly title: string;
  readonly description: string;
}

export interface SiteRoute extends PageMeta {
  readonly path: string;
  readonly sheet: string;
  readonly label: string;
  readonly indexable: boolean;
}

export interface NotFoundRoute extends PageMeta {
  readonly path: null;
  readonly drawing: string;
  readonly indexable: false;
}

export type SheetRoute = SiteRoute | NotFoundRoute;

export const ROUTES: readonly SiteRoute[] = [];

export const NOT_FOUND_ROUTE: NotFoundRoute = { path: null, title: '', description: '', drawing: '', indexable: false };

export function routeFor(pathname: string, routes: readonly SiteRoute[] = ROUTES): SiteRoute {
  const route = routes[0];
  if (route === undefined) throw new Error(pathname);
  return route;
}

export interface HeadMeta {
  readonly title: string;
  readonly metas: readonly Readonly<Record<string, string>>[];
  readonly links: readonly Readonly<Record<string, string>>[];
}

export function headMeta(route: SheetRoute): HeadMeta {
  return { title: route.title, metas: [], links: [] };
}

export function renderSitemap(_routes: readonly Pick<SiteRoute, 'path' | 'indexable'>[] = ROUTES): string {
  return '';
}

export function sitemapUrls(_xml: string): string[] {
  return [];
}

export function renderRobots(): string {
  return '';
}
