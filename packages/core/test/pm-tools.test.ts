// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { pmTools } from '../src/pm-tools.js';
import { tempDir } from './helpers.js';

it('rejects requests without the task capability before calling the dispatcher', async () => {
  const call = vi.fn();
  const bridge = await pmTools(tempDir('bridge'), call);
  try {
    const response = await fetch(bridge.server.env.HB_PM_ENDPOINT!, { method: 'POST', body: '{}' });
    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  } finally {
    await bridge.close();
  }
});

it('serves MCP initialize and tools/list through the actual stdio bridge', async () => {
  const bridge = await pmTools(tempDir('bridge'), async () => ({}));
  try {
    const child = spawn(bridge.server.command, bridge.server.args, {
      env: { ...process.env, ...bridge.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdin.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
        '\n',
    );
    expect(await exited).toBe(0);
    const responses = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses[0].result.serverInfo.name).toBe('harnessboard');
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toContain(
      'dispatch',
    );
  } finally {
    await bridge.close();
  }
});

it('revokes the capability when its PM run ends', async () => {
  const bridge = await pmTools(tempDir('bridge'), async () => ({}));
  await bridge.close();
  await expect(fetch(bridge.server.env.HB_PM_ENDPOINT!)).rejects.toThrow();
});

it('reports every missing dispatch field before invoking a worker', async () => {
  const call = vi.fn();
  const bridge = await pmTools(tempDir('bridge'), call);
  try {
    const response = await fetch(bridge.server.env.HB_PM_ENDPOINT!, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.server.env.HB_PM_CAPABILITY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'tools/call', params: { name: 'dispatch', arguments: {} } }),
    });
    const result = (await response.json()) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('missing required fields:');
    expect(result.content[0]!.text).toContain('tools/list');
    expect(call).not.toHaveBeenCalled();
  } finally {
    await bridge.close();
  }
});
