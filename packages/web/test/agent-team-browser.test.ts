// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

let server: ViteDevServer;
let browser: Browser | null = null;
let address = '';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTeam } from '/src/components/AgentTeam.tsx';
import '/src/i18n.ts';
const base = { agentId: 'codex', model: 'gpt-model-with-a-very-long-name-for-small-screens', access: 'readOnly', scope: 'Review protocol', acceptance: 'Verify actual evidence', status: 'running', goal: 'Check transfer integrity without duplicating implementation context', activity: 'Inspecting the protocol and tests', updatedAt: 1792696488807 };
const task = { id: 1, status: 'running', context: null, pm: { agentId: 'claude', model: 'pm-model' }, work: [
{ ...base, id: 'writer', access: 'edit', status: 'awaiting_children', goal: 'Implement core' },
{ ...base, id: 'review', parentWorkId: 'writer' },
{ ...base, id: 'deep', parentWorkId: 'review', status: 'failed', summary: 'Fingerprint handling requires a correction.' },
...Array.from({length: 8}, (_, i) => ({ ...base, id: 'helper-'+i, parentWorkId: 'writer', goal: 'Independent analysis '+i }))] };
const root = createRoot(document.getElementById('root'));
const render = () => root.render(React.createElement('aside', {className:'drawer drawer-team'}, React.createElement('div', {className:'drawer-body'}, React.createElement(AgentTeam, {task, events:[]}))));
window.addEventListener('message', event => { if(event.data === 'finish-review') { task.work[1] = {...task.work[1], status: 'completed', activity: 'Protocol review complete'}; render(); } });
render();
</script></body></html>`;

browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] }))
  .catch((error: unknown) => {
    if (process.env.CI) throw error;
    return null;
  });
beforeAll(async () => {
  if (!browser) return;
  server = await createServer({
    configFile: false,
    appType: 'custom',
    root: path.resolve(import.meta.dirname, '..'),
    plugins: [
      {
        name: 'agent-team-fixture',
        resolveId(id) {
          if (id === '/agent-team-entry.js') return '\0agent-team-entry';
        },
        load(id) {
          if (id === '\0agent-team-entry')
            return fixture.split('<script type="module">')[1]!.split('</script>')[0]!;
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  server.middlewares.use('/agent-team-fixture', async (req, res, next) => {
    if (req.url?.includes('html-proxy')) {
      next();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      fixture.replace(
        /<script type="module">[\s\S]*?<\/script>/,
        '<script type="module" src="/agent-team-entry.js"></script>',
      ),
    );
  });
  await server.listen();
  address = server.resolvedUrls!.local[0]! + 'agent-team-fixture';
}, 30000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function pageAt(width: number): Promise<Page | null> {
  if (!browser) return null;
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) =>
    errors.push(request.url() + ': ' + request.failure()?.errorText),
  );
  await page.goto(address, { timeout: 10000, waitUntil: 'domcontentloaded' });
  try {
    await page.locator('[data-agent-id="pm"]').waitFor({ timeout: 8000 });
  } catch (error) {
    await page.close();
    throw new Error(`${String(error)}; browser errors: ${errors.join('; ')}`);
  }
  return page;
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

describe.skipIf(!browser)('agent team across screen sizes', () => {
  it.each([360, 390])(
    'keeps the team, agent detail and return reachable at %ipx',
    async (width) => {
      const page = await pageAt(width);
      if (!page) return;
      try {
        await noPageOverflow(page);
        await page.locator('[data-agent-id="deep"]').click();
        expect(await page.locator('.agent-inspector').isVisible()).toBe(true);
        expect(await page.locator('.agent-map').isVisible()).toBe(false);
        expect(await page.locator('.agent-inspector').textContent()).toContain(
          'Fingerprint handling',
        );
        await noPageOverflow(page);
        await page.locator('.agent-back').click();
        expect(await page.locator('[data-agent-id="deep"]').isVisible()).toBe(true);
        expect(await page.locator('[data-agent-id="deep"]').getAttribute('aria-pressed')).toBe(
          'false',
        );
        expect(
          await page
            .locator('[data-agent-id="pm"]')
            .evaluate((el) => el.getBoundingClientRect().height),
        ).toBeGreaterThanOrEqual(44);
      } finally {
        await page.close();
      }
    },
  );

  it('restores the phones tree scroll position after viewing a deep helper', async () => {
    const page = await pageAt(390);
    if (!page) return;
    try {
      await page.locator('[data-agent-id="helper-5"]').scrollIntoViewIfNeeded();
      const before = await page.locator('.agent-viewport').evaluate((el) => el.scrollTop);
      await page.locator('[data-agent-id="helper-5"]').click();
      await page.locator('.agent-back').click();
      const after = await page.locator('.agent-viewport').evaluate((el) => el.scrollTop);
      expect(after).toBe(before);
    } finally {
      await page.close();
    }
  });

  it('preserves selection, updates and collapsed branches when rotating to desktop', async () => {
    const page = await pageAt(390);
    if (!page) return;
    try {
      await page.locator('[data-agent-id="review"]').click();
      await page.evaluate(() => window.postMessage('finish-review', '*'));
      await page.waitForFunction(() =>
        document
          .querySelector('.agent-inspector')
          ?.textContent?.includes('Protocol review complete'),
      );
      await page.setViewportSize({ width: 1200, height: 900 });
      expect(await page.locator('.agent-map').isVisible()).toBe(true);
      expect(await page.locator('[data-agent-id="review"]').getAttribute('aria-pressed')).toBe(
        'true',
      );
      await page.getByRole('button', { name: 'Collapse Worker · codex', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.agent-back').click();
      expect(await page.locator('[data-agent-id="deep"]').count()).toBe(0);
      expect(
        await page
          .getByRole('button', { name: 'Expand Worker · codex', exact: true })
          .getAttribute('aria-expanded'),
      ).toBe('false');
      await noPageOverflow(page);
    } finally {
      await page.close();
    }
  });

  it.each([768, 1440])('fits the tree and supports keyboard selection at %ipx', async (width) => {
    const page = await pageAt(width);
    if (!page) return;
    try {
      await page.getByRole('button', { name: 'Fit', exact: true }).click();
      await page.locator('[data-agent-id="pm"]').focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('.agent-inspector h3').textContent()).toBe('PM · claude');
      await noPageOverflow(page);
    } finally {
      await page.close();
    }
  });
});
