// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { startTailscale, tailscaleHost, tailscaleServe, tailscaleState } from '../src/tailscale.js';

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

describe('tailscaleState', () => {
  it('is missing when the command is not installed', async () => {
    const run = () => Promise.reject(new Error('spawn tailscale ENOENT'));
    expect(await tailscaleState(run)).toBe('missing');
  });

  it('is stopped when the command cannot reach the service', async () => {
    const run = () => Promise.reject(new Error('tailscale status --json exited with code 1'));
    expect(await tailscaleState(run)).toBe('stopped');
  });

  it('needs login when the service is up but logged out', async () => {
    expect(await tailscaleState(printing('{"BackendState":"NeedsLogin"}'))).toBe('needs-login');
  });

  it('needs login when Tailscale was switched off with tailscale down', async () => {
    expect(await tailscaleState(printing('{"BackendState":"Stopped"}'))).toBe('needs-login');
  });

  it('is running when connected', async () => {
    expect(await tailscaleState(printing('{"BackendState":"Running"}'))).toBe('running');
  });
});

describe('startTailscale', () => {
  /** A fake machine: each state it passes through, and every command run against it. */
  function machine(states: string[], loginUrl: string | null = null) {
    const commands: string[] = [];
    const queue = [...states];
    const starter = {
      run: (command: string, args: string[]) => {
        commands.push([command, ...args].join(' '));
        if (command === 'pkexec') return Promise.resolve('');
        const next = queue.length > 1 ? queue.shift()! : queue[0]!;
        return next === 'ENOENT'
          ? Promise.reject(new Error('spawn tailscale ENOENT'))
          : next === 'DOWN'
            ? Promise.reject(new Error('exited with code 1'))
            : Promise.resolve(`{"BackendState":"${next}"}`);
      },
      up: () => {
        commands.push('tailscale up');
        return Promise.resolve(loginUrl);
      },
    };
    return { commands, starter };
  }

  it('starts the service through pkexec on Linux, then returns the login address', async () => {
    const { commands, starter } = machine(
      ['DOWN', 'NeedsLogin'],
      'https://login.tailscale.com/a/1',
    );
    const result = await startTailscale('linux', starter);
    expect(commands).toEqual([
      'tailscale status --json',
      'pkexec systemctl enable --now tailscaled',
      'tailscale status --json',
      'tailscale up',
    ]);
    expect(result).toEqual({ state: 'needs-login', loginUrl: 'https://login.tailscale.com/a/1' });
  });

  it('does not ask for a password when the service already runs', async () => {
    const { commands, starter } = machine(['NeedsLogin'], 'https://login.tailscale.com/a/1');
    await startTailscale('linux', starter);
    expect(commands.some((c) => c.startsWith('pkexec'))).toBe(false);
  });

  it('leaves a stopped service alone on other systems', async () => {
    const { commands, starter } = machine(['DOWN']);
    expect(await startTailscale('darwin', starter)).toEqual({ state: 'stopped' });
    expect(commands).toEqual(['tailscale status --json']);
  });

  it('does nothing when Tailscale is not installed', async () => {
    const { starter } = machine(['ENOENT']);
    expect(await startTailscale('linux', starter)).toEqual({ state: 'missing' });
  });

  it('reports running without a login address when up finished by itself', async () => {
    const { starter } = machine(['NeedsLogin', 'Running'], null);
    expect(await startTailscale('linux', starter)).toEqual({ state: 'running' });
  });

  it('passes on the refusal when the password prompt is cancelled', async () => {
    const starter = {
      run: (command: string) =>
        command === 'pkexec'
          ? Promise.reject(new Error('pkexec exited with code 126'))
          : Promise.reject(new Error('exited with code 1')),
      up: () => Promise.resolve(null),
    };
    await expect(startTailscale('linux', starter)).rejects.toThrow('code 126');
  });
});
