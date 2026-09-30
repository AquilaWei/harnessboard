// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingFeatures, readFeatureList, runVerify } from '../src/loop.js';
import { tempDir } from './helpers.js';

const withList = (content: string) => {
  const dir = tempDir('loop');
  writeFileSync(path.join(dir, 'feature_list.json'), content);
  return dir;
};

describe('readFeatureList', () => {
  it('returns the features', () => {
    const dir = withList('{"features":[{"id":"F1","description":"a","passes":false}]}');
    expect(readFeatureList(dir)).toEqual([{ id: 'F1', description: 'a', passes: false }]);
  });

  it('throws when the file is missing', () => {
    expect(() => readFeatureList(tempDir('loop'))).toThrow(/was not found/);
  });

  it('throws on invalid JSON', () => {
    expect(() => readFeatureList(withList('{'))).toThrow(/not valid JSON/);
  });

  it('throws on an empty list', () => {
    expect(() => readFeatureList(withList('{"features":[]}'))).toThrow(/non-empty/);
  });

  it('throws when a feature has no passes flag', () => {
    const dir = withList('{"features":[{"id":"F1","description":"a"}]}');
    expect(() => readFeatureList(dir)).toThrow(/F1 needs a boolean "passes"/);
  });
});

describe('missingFeatures', () => {
  it('lists baseline ids that were removed', () => {
    const f = (id: string) => ({ id, description: id, passes: false });
    expect(missingFeatures([f('F1'), f('F2'), f('F3')], [f('F1'), f('F3')])).toEqual(['F2']);
  });
});

describe('runVerify', () => {
  const never = new AbortController().signal;

  it('succeeds when the command exits 0', async () => {
    const result = await runVerify('node -e "process.exit(0)"', tempDir('v'), never, 10_000);
    expect(result.ok).toBe(true);
  });

  it('fails with the exit code and output of a failing command', async () => {
    const cmd = 'node -e "console.log(\'boom\'); process.exit(3)"';
    const result = await runVerify(cmd, tempDir('v'), never, 10_000);
    expect([result.ok, result.exitCode, result.output.trim()]).toEqual([false, 3, 'boom']);
  });

  it('kills a command that runs past the timeout', async () => {
    const cmd = 'node -e "setTimeout(() => {}, 60000)"';
    const result = await runVerify(cmd, tempDir('v'), never, 300);
    expect([result.ok, result.timedOut]).toEqual([false, true]);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const cmd = 'node -e "setTimeout(() => {}, 60000)"';
    const running = runVerify(cmd, tempDir('v'), controller.signal, 60_000);
    setTimeout(() => controller.abort(), 300);
    expect((await running).ok).toBe(false);
  });
});
