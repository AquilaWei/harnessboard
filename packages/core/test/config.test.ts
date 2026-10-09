// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadConfig,
  loadProjectConfig,
  saveUserAgentEffort,
  saveUserConfig,
  userConfigFile,
  validate,
} from '../src/config.js';
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

  it('rejects a sandbox other than docker', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const boxed = { provider: 'codex', command: 'codex', model: null, sandbox: 'podman' };
    writeFileSync(file, JSON.stringify({ agents: { boxed } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config agents.boxed.sandbox must be "docker" or absent',
    );
  });

  it('rejects a docker sandbox without an image', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const boxed = { provider: 'codex', command: 'codex', model: null, sandbox: 'docker' };
    writeFileSync(file, JSON.stringify({ agents: { boxed } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config agents.boxed.sandboxImage must name an image for the sandbox',
    );
  });

  it('loads a profile with a reasoning effort', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const deep = { provider: 'codex', command: 'codex', model: 'gpt-6-sol', effort: 'high' };
    writeFileSync(file, JSON.stringify({ agents: { deep } }));
    expect(loadConfig({ env: {}, configFile: file }).agents.deep?.effort).toBe('high');
  });

  it('rejects a profile effort that could be read as an option, naming the profile', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const deep = { provider: 'codex', command: 'codex', model: null, effort: '-x' };
    writeFileSync(file, JSON.stringify({ agents: { deep } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config agents.deep.effort must be a reasoning effort such as "high", got "-x"',
    );
  });

  it('accepts a docker sandbox with an image', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const boxed = {
      provider: 'codex',
      command: 'codex',
      model: null,
      sandbox: 'docker',
      sandboxImage: 'agents:latest',
    };
    writeFileSync(file, JSON.stringify({ agents: { boxed } }));
    expect(loadConfig({ env: {}, configFile: file }).agents.boxed!.sandboxImage).toBe(
      'agents:latest',
    );
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

  it('allows no remote hosts by default', () => {
    expect(loadConfig({ env: {}, configFile: missing }).remoteHosts).toEqual([]);
  });

  it('rejects remote hosts that are not a list of host names', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ remoteHosts: 'box.tail1234.ts.net' }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config remoteHosts must be a list of host names',
    );
  });

  it('reports which config file has invalid JSON', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, '{ nope');
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(file);
  });
});

describe('androidAppFingerprints', () => {
  const FINGERPRINT_ERROR =
    'config androidAppFingerprints must be a list of SHA-256 fingerprints (32 hex bytes separated by colons)';
  const check = (androidAppFingerprints: unknown) => () =>
    validate({ ...defaultConfig({}), androidAppFingerprints } as never);

  it('is empty by default', () => {
    expect(loadConfig({ env: {}, configFile: missing }).androidAppFingerprints).toEqual([]);
  });

  it('accepts a fingerprint as keytool prints it', () => {
    expect(
      check([
        '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
      ]),
    ).not.toThrow();
  });

  it('accepts a fingerprint in lower case', () => {
    expect(
      check([
        '14:6d:e9:83:c5:73:06:50:d8:ee:b9:95:2f:34:fc:64:16:a0:83:42:e6:1d:be:a8:8a:04:96:b2:3f:cf:44:e5',
      ]),
    ).not.toThrow();
  });

  it('rejects a value that is not a list', () => {
    expect(
      check(
        '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
      ),
    ).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects an entry that is not a string', () => {
    expect(check([42])).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects an empty entry', () => {
    expect(check([''])).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects a SHA-1 fingerprint (20 bytes)', () => {
    expect(check(['14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42'])).toThrow(
      FINGERPRINT_ERROR,
    );
  });

  it('rejects 33 bytes', () => {
    expect(
      check([
        '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5:00',
      ]),
    ).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects bytes without colons', () => {
    expect(check(['146DE983C5730650D8EEB9952F34FC6416A08342E61DBEA88A0496B23FCF44E5'])).toThrow(
      FINGERPRINT_ERROR,
    );
  });

  it('rejects bytes separated by dashes', () => {
    expect(
      check([
        '14-6D-E9-83-C5-73-06-50-D8-EE-B9-95-2F-34-FC-64-16-A0-83-42-E6-1D-BE-A8-8A-04-96-B2-3F-CF-44-E5',
      ]),
    ).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects a byte that is not hex', () => {
    expect(
      check([
        'ZZ:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
      ]),
    ).toThrow(FINGERPRINT_ERROR);
  });

  it('rejects surrounding spaces', () => {
    expect(
      check([
        ' 14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
      ]),
    ).toThrow(FINGERPRINT_ERROR);
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

describe('saveUserAgentEffort', () => {
  it('drops environment overrides of the built-in profile once they are unset', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    const env = { HARNESSBOARD_MODEL: 'haiku', HARNESSBOARD_CLAUDE_PATH: '/tmp/claude' };
    const inEffect = loadConfig({ env, configFile: file }).agents.claude!;
    saveUserAgentEffort('claude', 'high', inEffect, file);
    expect(loadConfig({ env: {}, configFile: file }).agents.claude).toEqual({
      provider: 'claude-code',
      command: 'claude',
      model: null,
      effort: 'high',
    });
  });
});
