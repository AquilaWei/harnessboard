// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  agentsUpdate,
  profileInput,
  taskInput,
  withAgentOptions,
  withProfileOptions,
  withTaskOptions,
} from '../src/task-options.js';
import type { AddOptions, AgentsOptions, ModelsOptions } from '../src/task-options.js';

/** The request `hb add` would send for these arguments. */
const parse = (...args: string[]) => {
  const command = withTaskOptions(new Command('add').argument('<prompt...>')).exitOverride();
  command.parse([...args, 'fix the login'], { from: 'user' });
  return taskInput('fix the login', command.opts<AddOptions>());
};

/** The `PUT /tasks/:id/agents` body `hb models 3` would send for these arguments. */
const parseModels = (...args: string[]) => {
  const command = withAgentOptions(new Command('models').argument('<id>')).exitOverride();
  command.parse(['3', ...args], { from: 'user' });
  return agentsUpdate(command.opts<ModelsOptions>());
};

describe('task options', () => {
  it('ask for the base workspace with --on-base', () => {
    expect(parse('--on-base', '-C', '/repo').workspace).toBe('base');
  });

  it('leave the workspace to the server without --on-base', () => {
    expect(parse('-C', '/repo')).not.toHaveProperty('workspace');
  });

  it('keep --base as the branch a --on-base task works on', () => {
    expect(parse('--on-base', '--base', 'develop', '-C', '/repo')).toMatchObject({
      workspace: 'base',
      baseRef: 'develop',
    });
  });

  it('pass --designer and --designer-model on', () => {
    expect(parse('--designer', 'artist', '--designer-model', 'opus', '-C', '/repo')).toMatchObject({
      designer: 'artist',
      designerModel: 'opus',
    });
  });

  it('leave the designer to the server without --designer', () => {
    expect(parse('-C', '/repo')).not.toHaveProperty('designer');
  });

  it('pass --effort and --reviewer-effort on as the role efforts', () => {
    expect(parse('--effort', 'high', '--reviewer-effort', 'low', '-C', '/repo')).toMatchObject({
      implementerEffort: 'high',
      reviewerEffort: 'low',
    });
  });

  it('pass --spec-effort, --designer-effort and --tester-effort on', () => {
    expect(
      parse(
        '--spec-effort',
        'max',
        '--designer-effort',
        'medium',
        '--tester-effort',
        'xhigh',
        '-C',
        '/repo',
      ),
    ).toMatchObject({ specEffort: 'max', designerEffort: 'medium', testerEffort: 'xhigh' });
  });

  it('leave efforts to the server without effort options', () => {
    expect(parse('-C', '/repo')).not.toHaveProperty('implementerEffort');
  });
});

describe('hb models options', () => {
  it('clear the implementer effort with --effort default', () => {
    expect(parseModels('--effort', 'default')).toEqual({ implementerEffort: null });
  });

  it('set only the reviewer effort with --reviewer-effort', () => {
    expect(parseModels('--reviewer-effort', 'max')).toEqual({ reviewerEffort: 'max' });
  });

  it('send nothing without options', () => {
    expect(parseModels()).toEqual({});
  });

  it('still turn "default" models and "none" roles into null', () => {
    expect(parseModels('--model', 'default', '--tester', 'none')).toEqual({
      implementerModel: null,
      tester: null,
    });
  });
});

/** The `POST /agents` body `hb agents --add codex` would send for these arguments. */
const parseAdd = (...args: string[]) => {
  const command = withProfileOptions(new Command('agents')).exitOverride();
  command.parse(['--add', 'codex', ...args], { from: 'user' });
  const found = { provider: 'codex' as const, command: 'codex', version: '1', profileId: null };
  return profileInput(found, command.opts<AgentsOptions>());
};

describe('agents --add options', () => {
  it('send --effort as the profile effort', () => {
    expect(parseAdd('--effort', 'medium')).toEqual({
      id: 'codex',
      provider: 'codex',
      command: 'codex',
      model: null,
      effort: 'medium',
    });
  });

  it('leave the effort to the CLI without --effort', () => {
    expect(parseAdd('--id', 'cx', '--model', 'gpt-6-sol')).toEqual({
      id: 'cx',
      provider: 'codex',
      command: 'codex',
      model: 'gpt-6-sol',
      effort: null,
    });
  });
});
