import { renderRobots } from '../site/route-list.js';

export function GET(): Response {
  return new Response(renderRobots(), { headers: { 'Content-Type': 'application/octet-stream' } });
}
