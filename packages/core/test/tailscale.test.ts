// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { tailscaleHost, tailscaleServe } from '../src/tailscale.js';

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

describe('tailscaleServe', () => {
  const recording = (status: string) => {
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve(args[1] === 'status' ? status : '');
    };
    return { calls, run };
  };

  it('serves the port in the background when nothing serves it yet', async () => {
    const { calls, run } = recording('{}');
    await tailscaleServe(4317, run);
    expect(calls).toEqual([
      ['serve', 'status', '--json'],
      ['serve', '--bg', '4317'],
    ]);
  });

  it('does nothing when the port is already served', async () => {
    const { calls, run } = recording(
      '{"Web":{"x.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4317"}}}}}',
    );
    await tailscaleServe(4317, run);
    expect(calls).toEqual([['serve', 'status', '--json']]);
  });

  it('serves the port when only another port is served', async () => {
    const { calls, run } = recording(
      '{"Web":{"x.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}',
    );
    await tailscaleServe(4317, run);
    expect(calls.at(-1)).toEqual(['serve', '--bg', '4317']);
  });

  it('says how to see the reason when tailscale fails', async () => {
    const run = () => Promise.reject(new Error('exit code 1'));
    await expect(tailscaleServe(4317, run)).rejects.toThrow(
      'run "tailscale serve --bg 4317" in a terminal to see why',
    );
  });
});
