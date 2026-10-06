// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { taskInput, withTaskOptions } from '../src/task-options.js';
import type { AddOptions } from '../src/task-options.js';

/** The request `hb add` would send for these arguments. */
const parse = (...args: string[]) => {
  const command = withTaskOptions(new Command('add').argument('<prompt...>')).exitOverride();
  command.parse([...args, 'fix the login'], { from: 'user' });
  return taskInput('fix the login', command.opts<AddOptions>());
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
});
