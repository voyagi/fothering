import { renderTokensCss } from '../theme/head-script.js';

// A plain function rather than Astro's APIRoute type, so the root tsc reads this file without
// Astro's types. A file-extension endpoint is written as dist/tokens.css whatever trailingSlash says.
export function GET(): Response {
  return new Response(renderTokensCss(), { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
}
