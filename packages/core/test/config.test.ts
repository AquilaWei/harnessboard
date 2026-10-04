// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadProjectConfig, saveUserConfig, userConfigFile } from '../src/config.js';
import { tempDir } from './helpers.js';

const missing = path.join(tempDir('cfg'), 'none.json');

describe('userConfigFile', () => {
  it('lives in HARNESSBOARD_HOME when it is set', () => {
    expect(userConfigFile({ HARNESSBOARD_HOME: '/data/hb' })).toBe(
      path.join('/data/hb', 'config.json'),
    );
  });

  it('lives in the platform config folder without HARNESSBOARD_HOME', () => {
    expect(userConfigFile({})).toMatch(/harnessboard[/\\](Config[/\\])?config\.json$/);
  });
});

describe('loadConfig', () => {
  it('reads the config file in HARNESSBOARD_HOME', () => {
    const home = tempDir('cfg');
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ maxConcurrent: 4 }));
    expect(loadConfig({ env: { HARNESSBOARD_HOME: home } }).maxConcurrent).toBe(4);
  });

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

  it('applies HARNESSBOARD_CLAUDE_PATH to the claude profile', () => {
    const env = { HARNESSBOARD_CLAUDE_PATH: '/opt/claude' };
    expect(loadConfig({ env, configFile: missing }).agents.claude!.command).toBe('/opt/claude');
  });

  it('keeps the default claude profile when the file adds another', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const reviewer = { provider: 'claude-code', command: 'claude', model: 'opus' };
    writeFileSync(file, JSON.stringify({ agents: { reviewer } }));
    expect(Object.keys(loadConfig({ env: {}, configFile: file }).agents)).toEqual([
      'claude',
      'reviewer',
    ]);
  });

  it('rejects an agent profile with an unknown provider', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const bad = { provider: 'nope', command: 'x', model: null };
    writeFileSync(file, JSON.stringify({ agents: { bad } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(/agents.bad.provider/);
  });

  it('rejects a default reviewer that is not a profile', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ defaultReviewer: 'ghost' }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(/defaultReviewer "ghost"/);
  });

  it('rejects review guidelines that are not a list of paths', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ reviewGuidelines: '~/rules.md' }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config reviewGuidelines must be a list of file paths',
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
