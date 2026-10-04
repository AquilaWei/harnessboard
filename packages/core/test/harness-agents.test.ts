// SPDX-License-Identifier: Apache-2.0
// Finding agent CLIs on this machine and adding profiles for them.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { tempDir } from './helpers.js';

// `node --version` stands in for an installed agent CLI's version command.
const INSTALLED = process.execPath;
const MISSING = 'hb-no-such-agent-cli';

let settingsFile: string;
let harness: Harness;

function open(detectCommands: { 'claude-code': string; codex: string }, claude = 'claude'): void {
  const dir = tempDir('agents');
  settingsFile = path.join(dir, 'config.json');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code' as const, command: claude, model: null } },
  };
  harness = Harness.open(config, { settingsFile, detectCommands });
}

afterEach(() => harness.store.close());

describe('detectAgents', () => {
  it('reports a CLI that runs and has no profile yet', async () => {
    open({ 'claude-code': MISSING, codex: INSTALLED });
    expect(await harness.detectAgents()).toEqual([
      { provider: 'codex', command: INSTALLED, version: process.version, profileId: null },
    ]);
  });

  it('names the profile that already runs the CLI', async () => {
    open({ 'claude-code': INSTALLED, codex: MISSING }, INSTALLED);
    expect((await harness.detectAgents())[0]?.profileId).toBe('claude');
  });

  it('leaves out CLIs that are not installed', async () => {
    open({ 'claude-code': MISSING, codex: MISSING });
    expect(await harness.detectAgents()).toEqual([]);
  });
});

describe('addAgent', () => {
  beforeEach(() => open({ 'claude-code': MISSING, codex: MISSING }));

  it('makes the profile available to tasks at once', () => {
    harness.addAgent({ id: 'codex', provider: 'codex', command: 'codex', model: null });
    expect(harness.config.agents.codex).toEqual({
      provider: 'codex',
      command: 'codex',
      model: null,
    });
  });

  it('saves only the new profile next to the keys the file already has', () => {
    writeFileSync(settingsFile, JSON.stringify({ maxConcurrent: 3 }));
    harness.addAgent({ id: 'codex', provider: 'codex', command: 'codex', model: 'gpt-6-sol' });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      maxConcurrent: 3,
      agents: { codex: { provider: 'codex', command: 'codex', model: 'gpt-6-sol' } },
    });
  });

  it('rejects an id that is already used', () => {
    expect(() =>
      harness.addAgent({ id: 'claude', provider: 'codex', command: 'codex', model: null }),
    ).toThrow('agent profile "claude" already exists');
  });

  it('rejects an id that is not a profile id', () => {
    expect(() =>
      harness.addAgent({ id: 'my agent', provider: 'codex', command: 'codex', model: null }),
    ).toThrow('invalid agent profile id: "my agent"');
  });

  it('rejects a model that could be read as an option', () => {
    expect(() =>
      harness.addAgent({ id: 'codex', provider: 'codex', command: 'codex', model: '--yolo' }),
    ).toThrow('invalid model id: "--yolo"');
  });

  it('rejects an empty command', () => {
    expect(() =>
      harness.addAgent({ id: 'codex', provider: 'codex', command: ' ', model: null }),
    ).toThrow('config agents.codex.command must be a non-empty string');
  });

  it('changes nothing when it rejects the profile', () => {
    expect(() =>
      harness.addAgent({ id: 'codex', provider: 'codex', command: 'codex', model: '--yolo' }),
    ).toThrow();
    expect(harness.config.agents.codex).toBeUndefined();
  });
});
