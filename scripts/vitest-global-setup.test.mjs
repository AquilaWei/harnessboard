// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import setup from '../vitest.global-setup.ts';

describe('vitest global setup', () => {
  // These tests run in a worker started after the real global setup, so its run folder is set.
  it('points the system temp folder at this run’s folder', () => {
    expect(path.basename(tmpdir())).toMatch(/^hb-test-run-/);
  });

  it('puts temp folders made by a test under this run’s folder', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hb-cleanup-check-'));

    expect(path.dirname(dir)).toBe(process.env.TMPDIR);
  });

  describe('teardown', () => {
    const saved = {};

    beforeEach(() => {
      saved.TMPDIR = process.env.TMPDIR;
      saved.TEMP = process.env.TEMP;
      saved.TMP = process.env.TMP;
    });

    afterEach(() => {
      process.env.TMPDIR = saved.TMPDIR;
      process.env.TEMP = saved.TEMP;
      process.env.TMP = saved.TMP;
    });

    it('deletes the files a test left in the run folder', () => {
      const teardown = setup();
      const leftover = path.join(mkdtempSync(path.join(tmpdir(), 'hb-leftover-')), 'file.txt');
      writeFileSync(leftover, 'left behind');

      teardown();

      expect(existsSync(leftover)).toBe(false);
    });

    it('deletes the run folder itself', () => {
      const teardown = setup();
      const runDir = tmpdir();

      teardown();

      expect(existsSync(runDir)).toBe(false);
    });
  });
});
