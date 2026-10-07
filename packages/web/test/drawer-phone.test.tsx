// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, TaskDetail } from '@harnessboard/shared';
import { TaskDrawer } from '../src/components/TaskDrawer';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The task the panel loads; each test sets it before rendering.
const state = vi.hoisted(() => ({ task: null as unknown }));
vi.mock('../src/api', () => ({
  api: {
    task: () => Promise.resolve(state.task),
    timeline: () => Promise.resolve([]),
    events: () => Promise.resolve([]),
  },
}));
vi.mock('../src/live', () => ({ useLiveEvents: () => {}, useThrottled: (fn: () => void) => fn }));

// Read from disk: Vitest replaces imported CSS with an empty string. A path, not a URL:
// happy-dom's URL is not one `readFileSync` accepts.
const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');

// Uses the installed Chrome, which GitHub's runners have; a machine without it skips,
// but CI must not.
const browser = await chromium.launch({ channel: 'chrome' }).catch((err: unknown) => {
  if (process.env.CI) throw err;
  return null;
});
afterAll(() => browser?.close());

const request = (n: number): PermissionRequest => ({
  requestId: `r${n}`,
  sessionId: 's',
  toolName: 'Bash',
  summary: `pnpm run script-number-${n} --with a fairly long list of arguments to wrap`,
  suggestedRules: [`Bash(pnpm run script-number-${n}:*)`],
  risk: null,
  ts: 0,
});

const task = (fields: Partial<TaskDetail>) =>
  ({
    id: 1,
    title: 'Fit the task panel to a phone',
    status: 'awaiting_permission',
    mode: 'single',
    agents: { implementer: 'claude', reviewer: 'codex', maxReviewRounds: 2 },
    activity: null,
    context: null,
    loop: null,
    lastReview: null,
    reviewPending: false,
    lastNotice: null,
    plan: null,
    criteria: null,
    merge: null,
    permissionRequests: [],
    usage: { runs: 1, agentMs: 0, elapsedMs: null, tokens: null, costUsd: null, byModel: {} },
    sessionCount: 1,
    latestSessionId: null,
    sessions: [],
    features: null,
    ...fields,
  }) as unknown as TaskDetail;

/** The panel's HTML once it has loaded `detail`, rendered by React in happy-dom. */
const drawerHtml = async (detail: TaskDetail) => {
  state.task = detail;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TaskDrawer
        taskId={1}
        initialTab="timeline"
        onAction={() => Promise.resolve()}
        onClose={() => {}}
        onError={() => {}}
      />,
    ),
  );
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
};

/** A Chrome page the size of a phone showing `html` with the app's styles. */
const phone = async (html: string, width: number, height: number): Promise<Page> => {
  const page = await browser!.newPage({ viewport: { width, height } });
  await page.setContent(`<style>${css}</style>${html}`);
  return page;
};

/** Whether `selector`'s last match is fully on screen once scrolled into view. */
const reachable = (page: Page, selector: string) =>
  page
    .locator(selector)
    .last()
    .evaluate((el) => {
      el.scrollIntoView({ block: 'nearest' });
      const box = el.getBoundingClientRect();
      return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
    });

const fiveRequests = () => task({ permissionRequests: [1, 2, 3, 4, 5].map(request) });

const longFindings = () =>
  task({
    status: 'review',
    lastReview: {
      agentId: 'codex',
      verdict: 'changes',
      round: 1,
      findings: Array.from({ length: 40 }, (_, i) => `- Point ${i + 1}: this needs fixing.`).join(
        '\n',
      ),
    } as TaskDetail['lastReview'],
  });

describe.skipIf(!browser)('task panel on a 390×844 phone', () => {
  it('lets the last of five permission requests be scrolled to and answered', async () => {
    const page = await phone(await drawerHtml(fiveRequests()), 390, 844);
    expect(await reachable(page, '.permission button')).toBe(true);
  });

  it('keeps the tabs on screen below five permission requests', async () => {
    const page = await phone(await drawerHtml(fiveRequests()), 390, 844);
    expect(await reachable(page, '.drawer .tab')).toBe(true);
  });

  it('keeps part of the body on screen below five permission requests', async () => {
    const page = await phone(await drawerHtml(fiveRequests()), 390, 844);
    const visible = await page
      .locator('.drawer-body')
      .evaluate((el) => window.innerHeight - el.getBoundingClientRect().top);
    expect(visible).toBeGreaterThanOrEqual(200);
  });
});

// Findings are capped at 420px (`.markdown.reply`), so they overflow only a small phone.
describe.skipIf(!browser)('task panel on a 375×667 phone', () => {
  it('lets the actions below long review findings be scrolled to', async () => {
    const page = await phone(await drawerHtml(longFindings()), 375, 667);
    expect(await reachable(page, '.drawer-head .actions button')).toBe(true);
  });

  it('keeps the tabs on screen below long review findings', async () => {
    const page = await phone(await drawerHtml(longFindings()), 375, 667);
    expect(await reachable(page, '.drawer .tab')).toBe(true);
  });

  it('keeps part of the body on screen below long review findings', async () => {
    const page = await phone(await drawerHtml(longFindings()), 375, 667);
    const visible = await page
      .locator('.drawer-body')
      .evaluate((el) => window.innerHeight - el.getBoundingClientRect().top);
    expect(visible).toBeGreaterThanOrEqual(200);
  });
});
