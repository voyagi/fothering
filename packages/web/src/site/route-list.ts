// D-153: the sitemap, robots, canonical and og:url all read this one origin. It stays an RFC 2606
// reserved name until live session B knows the deployed host.
export const SITE_ORIGIN = 'https://fothering.example';

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

// The 404 page answers at every unknown address, so it has no path of its own.
export interface NotFoundRoute extends PageMeta {
  readonly path: null;
  readonly drawing: string;
  readonly indexable: false;
}

export type SheetRoute = SiteRoute | NotFoundRoute;

// Only routes with a built page belong here, and each page plan adds its own entry, so the sitemap
// and the title block can never name a page the build lacks.
export const ROUTES: readonly SiteRoute[] = Object.freeze([
  Object.freeze({
    path: '/',
    sheet: 'FTH-001',
    label: 'Landing',
    title: 'Fothering: close the one SES lane that is going wrong',
    description: 'Fothering reads Amazon SES events, pauses only the configuration set that is damaging the shared reputation, reads the setting back, and tells the operator by email.',
    indexable: true,
  }),
  Object.freeze({
    path: '/replay/',
    sheet: 'FTH-002',
    label: 'Replay',
    title: 'Incident replay: one SES lane paused and reopened',
    description: 'One SES incident in four steps: bounces arrive on one configuration set, code names the cause with counts, the lane is paused and read back, and the operator reopens it by command.',
    indexable: true,
  }),
  Object.freeze({
    path: '/deploy/',
    sheet: 'FTH-003',
    label: 'Deploy',
    title: 'Deploy Fothering into your own AWS account',
    description: 'The steps to deploy and remove Fothering, everything the template creates, and every IAM permission it holds with the reason, generated from the template.',
    indexable: true,
  }),
  Object.freeze({
    path: '/privacy-and-ai/',
    sheet: 'FTH-004',
    label: 'Privacy and AI',
    title: 'Privacy and AI: what Fothering keeps and what the model decides',
    description: 'Which SES event fields a Fothering deployment stores, where and for how long, how to delete them, what this site keeps, and what the AI model may and may not do.',
    indexable: true,
  }),
  Object.freeze({
    path: '/accessibility/',
    sheet: 'FTH-005',
    label: 'Accessibility',
    title: 'Accessibility statement: Fothering',
    description: 'The WCAG 2.2 AA target for this site, the last automated audit, what was checked by hand, known limitations and how to report a problem.',
    indexable: true,
  }),
]);

export const NOT_FOUND_ROUTE: NotFoundRoute = Object.freeze({
  path: null,
  title: 'No sheet at this address: Fothering',
  description: 'This address is not one of the sheets of the Fothering site.',
  drawing: 'Not in the sheet set',
  indexable: false,
});

const withTrailingSlash = (pathname: string): string => (pathname.endsWith('/') ? pathname : `${pathname}/`);

export function routeFor(pathname: string, routes: readonly SiteRoute[] = ROUTES): SiteRoute {
  const wanted = withTrailingSlash(pathname);
  const route = routes.find((entry) => entry.path === wanted);
  if (route === undefined) throw new Error(`${pathname}: not in the route list; add its entry to ROUTES in packages/web/src/site/route-list.ts`);
  return route;
}

export interface HeadMeta {
  readonly title: string;
  readonly metas: readonly Readonly<Record<string, string>>[];
  readonly links: readonly Readonly<Record<string, string>>[];
}

// A canonical or og:url on the 404 page would point crawlers from every unknown address at one URL.
export function headMeta(route: SheetRoute): HeadMeta {
  const url = route.path === null ? null : `${SITE_ORIGIN}${route.path}`;
  return {
    title: route.title,
    metas: [
      { name: 'description', content: route.description },
      { property: 'og:title', content: route.title },
      { property: 'og:description', content: route.description },
      { property: 'og:type', content: 'website' },
      ...(url === null ? [] : [{ property: 'og:url', content: url }]),
      { name: 'twitter:card', content: 'summary' },
    ],
    links: url === null ? [] : [{ rel: 'canonical', href: url }],
  };
}

const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const XML_UNESCAPES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(XML_ESCAPES).map(([char, entity]) => [entity, char]));

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
const unescapeXml = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity);

export function renderSitemap(routes: readonly Pick<SiteRoute, 'path' | 'indexable'>[] = ROUTES): string {
  const urls = routes.filter((route) => route.indexable).map((route) => `  <url><loc>${escapeXml(`${SITE_ORIGIN}${route.path}`)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((match) => unescapeXml(match[1] ?? ''));
}

export function renderRobots(): string {
  return ['User-agent: *', 'Allow: /', `Sitemap: ${SITE_ORIGIN}/sitemap.xml`, ''].join('\n');
}
