// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probePort, stopServer, waitForServer } from '../src/server.js';
import type { ServerProcess } from '../src/server.js';

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

/** An HTTP server on a free port answering with `handler`; resolves its URL. */
async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const harnessboard: RequestListener = (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ maxConcurrent: 1 }));
};

/** A port nothing listens on: one that was free a moment ago. */
async function freeUrl(): Promise<string> {
  const url = await listen(harnessboard);
  await new Promise((resolve) => server!.close(resolve));
  server = null;
  return url;
}

describe('probePort', () => {
  it('recognises a Harnessboard server', async () => {
    expect(await probePort(await listen(harnessboard))).toBe('harnessboard');
  });

  it('sends the header the API requires', async () => {
    let header: string | undefined;
    const url = await listen((req, res) => {
      header = req.headers['x-harnessboard-client'] as string | undefined;
      harnessboard(req, res);
    });
    await probePort(url);
    expect(header).toBe('desktop');
  });

  it('reports another program that answers with an error', async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 404;
      res.end('not here');
    });
    expect(await probePort(url)).toBe('other');
  });

  it('reports another program that answers with something else', async () => {
    const url = await listen((_req, res) => res.end('<html></html>'));
    expect(await probePort(url)).toBe('other');
  });

  it('reports a free port', async () => {
    expect(await probePort(await freeUrl())).toBe('free');
  });
});

describe('waitForServer', () => {
  it('is true once the server answers', async () => {
    const url = await listen(harnessboard);
    expect(await waitForServer(url, new Promise(() => {}), 2000, 10)).toBe(true);
  });

  it('is false when the server process exits first', async () => {
    expect(await waitForServer(await freeUrl(), Promise.resolve(1), 2000, 10)).toBe(false);
  });

  it('is false after the time limit', async () => {
    expect(await waitForServer(await freeUrl(), new Promise(() => {}), 50, 10)).toBe(false);
  });
});

describe('stopServer', () => {
  function fakeProcess(exitsOnShutdown: boolean) {
    const calls: string[] = [];
    let exit = () => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const child: ServerProcess = {
      postMessage: (message) => {
        calls.push(`message ${String(message)}`);
        if (exitsOnShutdown) exit();
      },
      kill: () => {
        calls.push('kill');
        exit();
        return true;
      },
    };
    return { child, exited, calls };
  }

  it('asks the server to shut down', async () => {
    const { child, exited, calls } = fakeProcess(true);
    await stopServer(child, exited, 1000);
    expect(calls).toEqual(['message shutdown']);
  });

  it('is true when the server exits by itself', async () => {
    const { child, exited } = fakeProcess(true);
    expect(await stopServer(child, exited, 1000)).toBe(true);
  });

  it('kills a server that does not exit in time', async () => {
    const { child, exited, calls } = fakeProcess(false);
    expect([await stopServer(child, exited, 20), calls]).toEqual([
      false,
      ['message shutdown', 'kill'],
    ]);
  });
});
