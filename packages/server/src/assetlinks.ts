// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Harness } from '@harnessboard/core';

/** The Android app's application ID; `android/app/build.gradle.kts` sets the same one. */
export const ANDROID_PACKAGE = 'io.github.aquilawei.harnessboard';

/**
 * Routes under `/.well-known`. Only `assetlinks.json` is answered: it tells Chrome that the
 * Android app signed with one of the `androidAppFingerprints` may show this board in a Trusted
 * Web Activity without a URL bar. Chrome fetches it without the device cookie, which `access()`
 * allows because the path is not under `/api/`. Every other path is 404, so the web UI's
 * client-side routes do not answer here.
 *
 * With no fingerprints saved the file is 404, so the app opens with a URL bar (Custom Tab mode).
 * The list is read on every request, so a settings change applies at once.
 */
export function createWellKnown(harness: Harness): Hono {
  const app = new Hono();
  app.get('/assetlinks.json', (c) => {
    const fingerprints = harness.config.androidAppFingerprints;
    if (fingerprints.length === 0) return c.notFound();
    return c.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          // keytool prints upper case; a fingerprint pasted in lower case is accepted too.
          sha256_cert_fingerprints: fingerprints.map((f) => f.toUpperCase()),
        },
      },
    ]);
  });
  app.all('*', (c) => c.notFound());
  return app;
}
