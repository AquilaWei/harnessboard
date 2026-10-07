// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { serveWeb } from '../src/static.js';

function app(): Hono {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-web-'));
  writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  const root = path.join(dir, 'web');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<html>board</html>');
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'manifest.webmanifest'), '{}');
  const hono = new Hono();
  hono.get('*', serveWeb(root));
  return hono;
}

describe('serveWeb', () => {
  it('serves a built asset with its content type', async () => {
    const res = await app().request('/assets/app.js');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('serves the web app manifest as application/manifest+json', async () => {
    const res = await app().request('/manifest.webmanifest');
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app().request('/tasks/3');
    expect(await res.text()).toBe('<html>board</html>');
  });

  it('never serves files outside the web root', async () => {
    const res = await app().request('/..%2fsecret.txt');
    expect(await res.text()).not.toBe('outside');
  });

  it('returns 404 for a missing asset', async () => {
    const res = await app().request('/assets/missing.js');
    expect(res.status).toBe(404);
  });
});
