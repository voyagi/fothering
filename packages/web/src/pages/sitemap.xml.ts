import { renderSitemap } from '../site/route-list.js';

// A plain function rather than Astro's APIRoute type, so the root tsc reads this file without
// Astro's types.
export function GET(): Response {
  return new Response(renderSitemap(), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
