// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  eventsUrl,
  isLocked,
  isNotPaired,
  onLocked,
  onNotPaired,
  setReauthPrompt,
  setSession,
} from '../src/api';

const answer = (status: number, body: string) =>
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status })));

/** Answers each call with the next of `replies`, and records the calls. */
const answers = (...replies: [number, string][]) => {
  const fetch = vi.fn((_url: string, _init: RequestInit) => {
    const [status, body] = replies.shift()!;
    return Promise.resolve(new Response(body, { status }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const REAUTH = '{"error":"confirm with your passkey first","reauth":true}';
const LOCKED = '{"error":"this device is locked","locked":true}';

afterEach(() => {
  vi.unstubAllGlobals();
  setReauthPrompt(null);
  setSession(null);
});

describe('isNotPaired', () => {
  it('is true for the 401 a device that is not paired gets', async () => {
    answer(401, '{"error":"this device is not paired"}');
    const err: unknown = await api.tasks().catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(true);
  });

  it('is false for other API errors', async () => {
    answer(403, '{"error":"forbidden host"}');
    const err: unknown = await api.tasks().catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(false);
  });

  it('keeps the server message on the error', async () => {
    answer(401, '{"error":"this device is not paired"}');
    await expect(api.tasks()).rejects.toThrow('this device is not paired');
  });
});

describe('isNotPaired with a lock or a reauth', () => {
  it('is false for the 401 of a locked device', async () => {
    answer(401, LOCKED);
    const err: unknown = await api.tasks().catch((e: unknown) => e);
    expect([isNotPaired(err), isLocked(err)]).toEqual([false, true]);
  });

  it('is false for the 401 that asks for a passkey check', async () => {
    answer(401, REAUTH);
    const err: unknown = await api.queue(1).catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(false);
  });
});

describe('onLocked', () => {
  it('is told about a locked 401, and onNotPaired is not', async () => {
    answer(401, LOCKED);
    const locked = vi.fn();
    const notPaired = vi.fn();
    const stopLocked = onLocked(locked);
    const stopNotPaired = onNotPaired(notPaired);
    await api.tasks().catch(() => {});
    stopLocked();
    stopNotPaired();
    expect([locked.mock.calls.length, notPaired.mock.calls.length]).toEqual([1, 0]);
  });
});

describe('reauth retry', () => {
  it('retries the action once after the passkey prompt passes', async () => {
    const fetch = answers([401, REAUTH], [200, '{"ok":true}']);
    setReauthPrompt(() => Promise.resolve(true));
    await expect(api.queue(1)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the passkey prompt is cancelled', async () => {
    const fetch = answers([401, REAUTH], [200, '{"ok":true}']);
    setReauthPrompt(() => Promise.resolve(false));
    await expect(api.queue(1)).rejects.toThrow('confirm with your passkey first');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a second time when the retry is refused again', async () => {
    const fetch = answers([401, REAUTH], [401, REAUTH], [200, '{"ok":true}']);
    const prompt = vi.fn(() => Promise.resolve(true));
    setReauthPrompt(prompt);
    await expect(api.queue(1)).rejects.toThrow('confirm with your passkey first');
    expect([fetch.mock.calls.length, prompt.mock.calls.length]).toEqual([2, 1]);
  });

  it('does not retry without a prompt', async () => {
    const fetch = answers([401, REAUTH], [200, '{"ok":true}']);
    await expect(api.queue(1)).rejects.toThrow('confirm with your passkey first');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks once for actions refused at the same time', async () => {
    answers([401, REAUTH], [401, REAUTH], [200, '{"ok":true}'], [200, '{"ok":true}']);
    const prompt = vi.fn(() => Promise.resolve(true));
    setReauthPrompt(prompt);
    await Promise.all([api.queue(1), api.queue(2)]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('sends the session from the passkey prompt on the retry', async () => {
    const fetch = answers([401, REAUTH], [200, '{"ok":true}']);
    setReauthPrompt(() => {
      setSession('new-token');
      return Promise.resolve(true);
    });
    await api.queue(1);
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('x-harnessboard-session')).toBe(
      'new-token',
    );
  });
});

/** Answers the first call only once `setSession` has run, as a read in flight while unlocking. */
const lateLocked = (next: [number, string]) => {
  const fetch = vi.fn((_url: string, _init: RequestInit) =>
    fetch.mock.calls.length === 1
      ? new Promise<Response>((resolve) => {
          setSession('new-token');
          resolve(new Response(LOCKED, { status: 401 }));
        })
      : Promise.resolve(new Response(next[1], { status: next[0] })),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

describe('a 401 to a call sent before the session changed', () => {
  it('retries the call with the new session', async () => {
    const fetch = lateLocked([200, '[]']);
    await api.tasks();
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('x-harnessboard-session')).toBe(
      'new-token',
    );
  });

  it('does not tell the lock listeners', async () => {
    lateLocked([200, '[]']);
    const locked = vi.fn();
    const stop = onLocked(locked);
    await api.tasks();
    stop();
    expect(locked).not.toHaveBeenCalled();
  });

  it('tells the lock listeners when the retry under the new session is locked too', async () => {
    lateLocked([401, LOCKED]);
    const locked = vi.fn();
    const stop = onLocked(locked);
    await api.tasks().catch(() => {});
    stop();
    expect(locked).toHaveBeenCalledTimes(1);
  });
});

describe('session', () => {
  it('sends the session token with a read', async () => {
    const fetch = answers([200, '[]']);
    setSession('abc');
    await api.tasks();
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('x-harnessboard-session')).toBe('abc');
  });

  it('keeps the client header on an action that carries the session', async () => {
    const fetch = answers([200, '{}']);
    setSession('abc');
    await api.queue(1);
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('x-harnessboard-client')).toBe('web');
  });

  it('sends no session header before a passkey check', async () => {
    const fetch = answers([200, '[]']);
    await api.tasks();
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('x-harnessboard-session')).toBe(false);
  });

  it('puts the session token in the event stream address', () => {
    setSession('a+b');
    expect(eventsUrl()).toBe('/api/events?session=a%2Bb');
  });

  it('opens the event stream without a session on the computer', () => {
    expect(eventsUrl()).toBe('/api/events');
  });
});
