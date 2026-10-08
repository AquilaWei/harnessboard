// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import { createWellKnown } from '../src/assetlinks.js';

const FINGERPRINT =
  '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
const OTHER =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
let harness: Harness;
let app: Hono;

beforeEach(() => {
  const dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-assetlinks-'));
  harness = Harness.open({ ...defaultConfig({}), dataDir: path.join(dir, 'data') });
  app = new Hono().route('/.well-known', createWellKnown(harness));
});

afterEach(() => harness.store.close());

describe('GET /.well-known/assetlinks.json', () => {
  it('answers 404 when no fingerprint is saved', async () => {
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
  });

  it('answers the one handle_all_urls statement for the app and the saved fingerprints', async () => {
    harness.updateSettings({ androidAppFingerprints: [FINGERPRINT, OTHER] });
    const res = await app.request('/.well-known/assetlinks.json');
    expect([res.status, res.headers.get('content-type'), await res.json()]).toEqual([
      200,
      'application/json',
      [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'io.github.aquilawei.harnessboard',
            sha256_cert_fingerprints: [FINGERPRINT, OTHER],
          },
        },
      ],
    ]);
  });

  it('serves a fingerprint saved in lower case in upper case', async () => {
    harness.updateSettings({
      androidAppFingerprints: [
        '14:6d:e9:83:c5:73:06:50:d8:ee:b9:95:2f:34:fc:64:16:a0:83:42:e6:1d:be:a8:8a:04:96:b2:3f:cf:44:e5',
      ],
    });
    const res = await app.request('/.well-known/assetlinks.json');
    const [statement] = (await res.json()) as {
      target: { sha256_cert_fingerprints: string[] };
    }[];
    expect(statement!.target.sha256_cert_fingerprints).toEqual([FINGERPRINT]);
  });

  it('answers 404 again once the fingerprints are cleared', async () => {
    harness.updateSettings({ androidAppFingerprints: [FINGERPRINT] });
    harness.updateSettings({ androidAppFingerprints: [] });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
  });
});

describe('other /.well-known paths', () => {
  it('answers 404 to another file under /.well-known', async () => {
    harness.updateSettings({ androidAppFingerprints: [FINGERPRINT] });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
  });

  it('answers 404 to a POST to assetlinks.json', async () => {
    harness.updateSettings({ androidAppFingerprints: [FINGERPRINT] });
    const res = await app.request('/.well-known/assetlinks.json', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
