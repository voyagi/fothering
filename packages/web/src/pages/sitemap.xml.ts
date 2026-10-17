import { renderSitemap } from '../site/route-list.js';

export function GET(): Response {
  return new Response(renderSitemap(), { headers: { 'Content-Type': 'text/plain' } });
}
