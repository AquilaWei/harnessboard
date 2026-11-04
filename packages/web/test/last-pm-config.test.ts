// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import type { AgentInfo, ModelInfo } from '@harnessboard/shared';
import {
  defaultPmConfig,
  loadLastPmConfig,
  saveLastPmConfig,
  sanitizePmConfig,
} from '../src/lastPmConfig';

const agents = [
  { id: 'claude', ok: true, profile: { provider: 'claude-code' } },
  { id: 'codex', ok: true, profile: { provider: 'codex' } },
] as AgentInfo[];
const catalogs = {
  claude: [
    {
      id: 'opus',
      name: 'Opus',
      description: null,
      note: null,
      more: false,
      efforts: [],
      defaultEffort: null,
    },
  ],
  codex: [
    {
      id: 'gpt',
      name: 'GPT',
      description: null,
      note: null,
      more: false,
      efforts: [],
      defaultEffort: null,
    },
  ],
} as Record<string, ModelInfo[]>;

it('roundtrips the complete last successful configuration', () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  };
  const config = {
    ...defaultPmConfig(),
    model: 'opus',
    effort: 'high',
    workers: [{ agentId: 'codex', models: [null, 'gpt'] }],
    dispatchPolicy: { strategy: 'costFirst' as const, maxWorkers: 5, maxExtraTokenRatio: 0.4 },
  };
  saveLastPmConfig(storage, config);
  expect(loadLastPmConfig(storage, agents, catalogs)).toEqual(config);
});
it.each([null, '{broken'])('uses defaults for missing or corrupt storage: %s', (value) => {
  expect(loadLastPmConfig({ getItem: () => value, setItem: () => {} }, agents, catalogs)).toEqual(
    defaultPmConfig(),
  );
});
it('drops unavailable worker profiles and unknown models', () => {
  expect(
    sanitizePmConfig(
      {
        ...defaultPmConfig(),
        workers: [
          { agentId: 'missing', models: [null] },
          { agentId: 'codex', models: ['obsolete', 'gpt'] },
          { agentId: 'claude', models: ['obsolete'] },
        ],
      },
      agents,
      catalogs,
    ).workers,
  ).toEqual([
    { agentId: 'codex', models: ['gpt'] },
    { agentId: 'claude', models: [null] },
  ]);
});
it.each(['missing', 'gemini', 'docker', 'offline'])(
  'falls back for unsupported PM %s',
  (agentId) => {
    const available = [
      ...agents,
      { id: 'gemini', ok: true, profile: { provider: 'gemini' } },
      { id: 'docker', ok: true, profile: { provider: 'codex', sandbox: 'docker' } },
      { id: 'offline', ok: false, profile: { provider: 'codex' } },
    ] as AgentInfo[];
    expect(sanitizePmConfig({ ...defaultPmConfig(), agentId }, available, catalogs)).toEqual(
      defaultPmConfig(),
    );
  },
);
it('resets an unknown PM model and its effort', () => {
  expect(
    sanitizePmConfig({ ...defaultPmConfig(), model: 'obsolete', effort: 'high' }, agents, catalogs),
  ).toMatchObject({ model: null, effort: null });
});
it.each([
  [99, 6],
  [0, 1],
  [-2, 1],
])('clamps worker limit %s to %s', (input, expected) => {
  expect(
    sanitizePmConfig(
      {
        ...defaultPmConfig(),
        dispatchPolicy: {
          strategy: 'costFirst',
          maxWorkers: input,
          maxExtraTokenRatio: -1,
        },
      },
      agents,
      catalogs,
    ).dispatchPolicy,
  ).toEqual({
    strategy: 'costFirst',
    maxWorkers: expected,
    maxExtraTokenRatio: 0,
  });
});
