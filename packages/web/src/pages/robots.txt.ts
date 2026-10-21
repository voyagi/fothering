import { renderRobots } from '../site/route-list.js';

export function GET(): Response {
  return new Response(renderRobots(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
