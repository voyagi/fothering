import { defineConfig } from 'astro/config';

// The production CSP is default-src 'self', so nothing may be inlined: stylesheets stay files and
// Vite never turns an asset into a data: URI.
export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
});
