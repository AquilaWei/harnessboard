// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { tailscaleHost } from '../src/tailscale.js';

const printing = (stdout: string) => () => Promise.resolve(stdout);

describe('tailscaleHost', () => {
  it('returns the DNS name without the trailing dot when Tailscale is running', async () => {
    const run = printing(
      '{"BackendState":"Running","Self":{"DNSName":"pc.tail1234.ts.net.","HostName":"pc"}}',
    );
    expect(await tailscaleHost(run)).toBe('pc.tail1234.ts.net');
  });

  it('runs tailscale status --json', async () => {
    const calls: unknown[] = [];
    await tailscaleHost((command, args) => {
      calls.push([command, args]);
      return Promise.resolve('{}');
    });
    expect(calls).toEqual([['tailscale', ['status', '--json']]]);
  });

  it('returns null when the tailscale command is missing', async () => {
    const run = () => Promise.reject(new Error('spawn tailscale ENOENT'));
    expect(await tailscaleHost(run)).toBeNull();
  });

  it('returns null when Tailscale is stopped', async () => {
    const run = printing('{"BackendState":"Stopped","Self":{"DNSName":"pc.tail1234.ts.net."}}');
    expect(await tailscaleHost(run)).toBeNull();
  });

  it('returns null when Tailscale is not logged in', async () => {
    const run = printing('{"BackendState":"NeedsLogin","Self":{"DNSName":""}}');
    expect(await tailscaleHost(run)).toBeNull();
  });

  it('returns null when the output is not JSON', async () => {
    expect(await tailscaleHost(printing('failed to connect to local tailscaled'))).toBeNull();
  });

  it('returns null when a running Tailscale reports no DNS name', async () => {
    expect(await tailscaleHost(printing('{"BackendState":"Running","Self":{}}'))).toBeNull();
  });
});
