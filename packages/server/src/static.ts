// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * Serves the built web UI from `root`, falling back to `index.html` for client-side routes.
 * Paths are resolved and checked to stay inside `root`, so `..` cannot escape it.
 */
export function serveWeb(root: string): MiddlewareHandler {
  const base = path.resolve(root);
  return async (c) => {
    const requested = path.resolve(base, '.' + decodeURIComponent(new URL(c.req.url).pathname));
    const inside = requested === base || requested.startsWith(base + path.sep);
    const file = inside && path.extname(requested) ? requested : path.join(base, 'index.html');
    try {
      const body = await readFile(file);
      return c.body(body, 200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (file.endsWith('index.html')) return c.text('web UI not built; run `pnpm build`', 404);
      return c.notFound();
    }
  };
}
