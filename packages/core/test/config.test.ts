// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadProjectConfig, saveUserConfig } from '../src/config.js';
import { tempDir } from './helpers.js';

const missing = path.join(tempDir('cfg'), 'none.json');

describe('loadConfig', () => {
  it('uses HARNESSBOARD_HOME as the data directory', () => {
    const config = loadConfig({ env: { HARNESSBOARD_HOME: '/data/hb' }, configFile: missing });
    expect(config.dataDir).toBe('/data/hb');
  });

  it('lets the user config file override defaults', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ maxConcurrent: 3 }));
    expect(loadConfig({ env: {}, configFile: file }).maxConcurrent).toBe(3);
  });

  it('lets the environment override the user config file', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ maxConcurrent: 3 }));
    const env = { HARNESSBOARD_MAX_CONCURRENT: '2' };
    expect(loadConfig({ env, configFile: file }).maxConcurrent).toBe(2);
  });

  it('lets explicit overrides win over the environment', () => {
    const env = { HARNESSBOARD_PORT: '5000' };
    expect(loadConfig({ env, configFile: missing, overrides: { port: 6000 } }).port).toBe(6000);
  });

  it('rejects a non-numeric port from the environment', () => {
    expect(() => loadConfig({ env: { HARNESSBOARD_PORT: 'abc' }, configFile: missing })).toThrow(
      /port/,
    );
  });

  it('reports which config file has invalid JSON', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, '{ nope');
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(file);
  });
});

describe('loadProjectConfig', () => {
  it('returns an empty object when the repo has no .harnessboard.json', () => {
    expect(loadProjectConfig(tempDir('proj'))).toEqual({});
  });

  it('reads defaults from .harnessboard.json', () => {
    const repo = tempDir('proj');
    writeFileSync(path.join(repo, '.harnessboard.json'), JSON.stringify({ baseRef: 'develop' }));
    expect(loadProjectConfig(repo)).toEqual({ baseRef: 'develop' });
  });
});

describe('saveUserConfig', () => {
  it('keeps keys the patch does not mention', () => {
    const file = path.join(tempDir('cfg'), 'nested', 'config.json');
    saveUserConfig({ maxConcurrent: 2 }, file);
    saveUserConfig({ quotaPauseUtilization: 0.9 }, file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      maxConcurrent: 2,
      quotaPauseUtilization: 0.9,
    });
  });
});
