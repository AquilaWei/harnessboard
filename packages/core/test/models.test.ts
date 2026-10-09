// SPDX-License-Identifier: Apache-2.0
// The models each platform offers, read from its own model catalog.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, ModelInfo } from '@harnessboard/shared';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  CLAUDE_ALIASES,
  parseClaudeCatalog,
  parseCodexModels,
  readClaudeModels,
} from '../src/models.js';
import { tempDir } from './helpers.js';

const catalog = (fetchedAt: number, models: unknown[]) => ({
  version: 2,
  fetchedAt,
  catalog: { surface: 'cc', config: { id: 'cc', models } },
});

const opus = {
  id: 'claude-opus-5-5',
  name: 'Opus 5.5',
  description: 'For complex work',
  section: 'main',
};

describe('parseClaudeCatalog', () => {
  it('reads id, name and description', () => {
    expect(parseClaudeCatalog(catalog(1, [opus]))).toEqual([
      {
        id: 'claude-opus-5-5',
        name: 'Opus 5.5',
        description: 'For complex work',
        note: null,
        more: false,
        efforts: [],
        defaultEffort: null,
      },
    ]);
  });

  it('keeps the badge as a note', () => {
    const fable = { id: 'claude-fable-5-1', name: 'Fable 5.1', badge: { message: 'Credits' } };
    expect(parseClaudeCatalog(catalog(1, [fable]))[0]!.note).toBe('Credits');
  });

  it('marks overflow models as more', () => {
    const older = { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow' };
    expect(parseClaudeCatalog(catalog(1, [older]))[0]!.more).toBe(true);
  });

  it('throws when there is no model list', () => {
    expect(() => parseClaudeCatalog({ catalog: {} })).toThrow('no model list');
  });

  const thinking = {
    type: 'effort',
    effort_options: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium', badge: { message: 'Recommended', variant: 'neutral' } },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra' },
      {
        id: 'max',
        name: 'Max',
        badge: { message: '3.5× or more usage', variant: 'warning' },
        tooltip: { content: 'Thinks longer' },
      },
    ],
  };

  it('reads the effort options in order, with their badges as notes', () => {
    expect(parseClaudeCatalog(catalog(1, [{ ...opus, thinking }]))[0]!.efforts).toEqual([
      { id: 'low', name: 'Low', description: null, note: null },
      { id: 'medium', name: 'Medium', description: null, note: 'Recommended' },
      { id: 'high', name: 'High', description: null, note: null },
      { id: 'xhigh', name: 'Extra', description: null, note: null },
      { id: 'max', name: 'Max', description: 'Thinks longer', note: '3.5× or more usage' },
    ]);
  });

  it('leaves the default effort unknown even when one effort is recommended', () => {
    expect(parseClaudeCatalog(catalog(1, [{ ...opus, thinking }]))[0]!.defaultEffort).toBeNull();
  });

  it('offers no efforts for a model without thinking options', () => {
    expect(parseClaudeCatalog(catalog(1, [opus]))[0]!.efforts).toEqual([]);
  });
});

describe('readClaudeModels', () => {
  it('reads the most recently fetched catalog', () => {
    const dir = tempDir('claude-config');
    mkdirSync(path.join(dir, 'cache', 'model-catalog'), { recursive: true });
    const write = (name: string, body: unknown) =>
      writeFileSync(path.join(dir, 'cache', 'model-catalog', name), JSON.stringify(body));
    write('old.json', catalog(1, [{ id: 'old-model', name: 'Old' }]));
    write('new.json', catalog(2, [opus]));
    expect(readClaudeModels(dir).map((m) => m.id)).toEqual(['claude-opus-5-5']);
  });

  it('offers no efforts on the aliases', () => {
    expect(CLAUDE_ALIASES.map((m) => [m.efforts, m.defaultEffort])).toEqual([
      [[], null],
      [[], null],
      [[], null],
      [[], null],
    ]);
  });

  it('falls back to the aliases without a catalog', () => {
    expect(readClaudeModels(tempDir('claude-config'))).toEqual(CLAUDE_ALIASES);
  });

  it('falls back to the aliases when the catalog can not be read', () => {
    const dir = tempDir('claude-config');
    mkdirSync(path.join(dir, 'cache', 'model-catalog'), { recursive: true });
    writeFileSync(path.join(dir, 'cache', 'model-catalog', 'x.json'), '{not json');
    expect(readClaudeModels(dir)).toEqual(CLAUDE_ALIASES);
  });
});

describe('parseCodexModels', () => {
  const luna = {
    slug: 'gpt-6-luna',
    display_name: 'GPT-6-Luna',
    description: 'Fast',
    visibility: 'list',
  };

  it('reads slug, display name and description', () => {
    expect(parseCodexModels({ models: [luna] })).toEqual([
      {
        id: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        description: 'Fast',
        note: null,
        more: false,
        efforts: [],
        defaultEffort: null,
      },
    ]);
  });

  it('reads the reasoning levels and the default level', () => {
    const sol = {
      ...luna,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Deeper' },
      ],
      default_reasoning_level: 'medium',
    };
    expect(parseCodexModels({ models: [sol] })[0]).toMatchObject({
      efforts: [
        { id: 'low', name: 'low', description: 'Fast responses', note: null },
        { id: 'medium', name: 'medium', description: 'Balanced', note: null },
        { id: 'high', name: 'high', description: 'Deeper', note: null },
      ],
      defaultEffort: 'medium',
    });
  });

  it('leaves out models Codex hides from its picker', () => {
    const hidden = { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' };
    expect(parseCodexModels({ models: [luna, hidden] }).map((m) => m.id)).toEqual(['gpt-6-luna']);
  });

  it('throws when there is no model list', () => {
    expect(() => parseCodexModels({})).toThrow('no model list');
  });
});

describe('Harness.models', () => {
  const listed: ModelInfo[] = [
    {
      id: 'm1',
      name: 'Model 1',
      description: null,
      note: null,
      more: false,
      efforts: [],
      defaultEffort: null,
    },
  ];
  let calls = 0;
  let harness: Harness;

  function open(listModels?: () => Promise<ModelInfo[]>, effort = true): void {
    const dir = tempDir('models');
    const config = { ...defaultConfig({}), dataDir: path.join(dir, 'data') };
    const adapterFactory = (profile: AgentProfile) => {
      const adapter = new ClaudeCodeAdapter(profile.command);
      return Object.assign(adapter, {
        listModels,
        capabilities: { ...adapter.capabilities, effort },
      });
    };
    harness = Harness.open(config, { adapterFactory });
  }

  afterEach(() => harness.store.close());

  it("returns the profile CLI's models", async () => {
    open(() => Promise.resolve(listed));
    expect(await harness.models('claude')).toEqual(listed);
  });

  it("drops the models' efforts when the CLI can not take an effort", async () => {
    const withEfforts: ModelInfo[] = [
      {
        id: 'm1',
        name: 'Model 1',
        description: null,
        note: null,
        more: false,
        efforts: [{ id: 'high', name: 'High', description: null, note: null }],
        defaultEffort: 'high',
      },
    ];
    open(() => Promise.resolve(withEfforts), false);
    expect(await harness.models('claude')).toEqual(listed);
  });

  it('asks the CLI only once while the list is fresh', async () => {
    calls = 0;
    open(() => {
      calls += 1;
      return Promise.resolve(listed);
    });
    await harness.models('claude');
    await harness.models('claude');
    expect(calls).toBe(1);
  });

  it('is empty when the CLI can not list its models', async () => {
    open(undefined);
    expect(await harness.models('claude')).toEqual([]);
  });

  it('is empty when listing fails', async () => {
    open(() => Promise.reject(new Error('unknown command debug')));
    expect(await harness.models('claude')).toEqual([]);
  });

  it('throws for a profile that is not configured', async () => {
    open(() => Promise.resolve(listed));
    await expect(harness.models('nope')).rejects.toThrow('agent profile "nope" is not configured');
  });
});
