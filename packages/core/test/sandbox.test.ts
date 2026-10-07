// SPDX-License-Identifier: Apache-2.0
// The Docker sandbox's command line, its refusal to run without docker, and (when docker
// is installed) a real container.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentCapabilities, SessionSpec } from '../src/agent.js';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { GeminiAdapter } from '../src/gemini.js';
import { output } from '../src/process.js';
import { createAdapter } from '../src/providers.js';
import { DockerSandbox } from '../src/sandbox.js';
import { makeRepo, tempDir } from './helpers.js';

const USER = { uid: 1000, gid: 1001, home: '/home/me' };

/** An agent CLI that needs one config folder and one config file that is not there. */
class ConfiguredAdapter implements AgentAdapter {
  readonly provider = 'codex';
  readonly command: string = 'agent';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    midTurnInput: false,
    sessionIds: 'agent',
    permissionPrompts: false,
    readOnlyGit: true,
  };

  constructor(private readonly config: string[]) {}

  buildArgs(spec: SessionSpec): string[] {
    return ['exec', spec.prompt];
  }

  configPaths(): string[] {
    return this.config;
  }

  encodeMessage(): string {
    throw new Error('no stdin');
  }

  encodePermissionReply(): string {
    throw new Error('no permission prompts');
  }

  parseLine() {
    return [];
  }

  interactiveResumeArgs(id: string): string[] {
    return ['resume', id];
  }
}

function spec(cwd: string, overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    cwd,
    sessionId: null,
    resume: false,
    prompt: 'do it',
    model: null,
    access: 'edit',
    allowedTools: [],
    skipPermissions: false,
    askPermission: false,
    ...overrides,
  };
}

/** A worktree of a fresh repository; its git directory is the repository's `.git`. */
function worktree(): { repo: string; dir: string } {
  const repo = makeRepo();
  const dir = path.join(tempDir('sandbox-wt'), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'task', dir], { cwd: repo, stdio: 'pipe' });
  return { repo, dir };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DockerSandbox command line', () => {
  it('mounts only the folder, the config that exists and the readable dirs', () => {
    const cwd = tempDir('sandbox-cwd');
    const config = tempDir('sandbox-config');
    const evidence = tempDir('sandbox-evidence');
    const missing = path.join(config, 'missing.json');
    const sandbox = new DockerSandbox(
      new ConfiguredAdapter([config, missing]),
      'agents:1',
      'linux',
      USER,
    );
    expect(sandbox.buildArgs(spec(cwd, { readableDirs: [evidence] }))).toEqual([
      'run',
      '--rm',
      '-i',
      '--init',
      '--security-opt',
      'label=disable',
      '--user',
      '1000:1001',
      '--env',
      'HOME=/home/me',
      '--workdir',
      cwd,
      '--mount',
      `type=bind,source=${cwd},target=${cwd}`,
      '--mount',
      `type=bind,source=${config},target=${config}`,
      '--mount',
      `type=bind,source=${evidence},target=${evidence},readonly`,
      'agents:1',
      'agent',
      'exec',
      'do it',
    ]);
  });

  it("mounts a worktree's git directory so the agent can commit", () => {
    const { repo, dir } = worktree();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(dir))).toContain(
      `type=bind,source=${path.join(repo, '.git')},target=${path.join(repo, '.git')}`,
    );
  });

  it("mounts a worktree's git directory read-only for a read-only session", () => {
    const { repo, dir } = worktree();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(dir, { access: 'readOnly' }))).toContain(
      `type=bind,source=${path.join(repo, '.git')},target=${path.join(repo, '.git')},readonly`,
    );
  });

  it('mounts nothing more for a repository whose git directory is inside it', () => {
    const repo = makeRepo();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(repo)).filter((arg) => arg === '--mount')).toHaveLength(1);
  });

  it('opens a session interactively with a terminal', () => {
    const cwd = tempDir('sandbox-cwd');
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.interactiveResumeArgs('s-1', cwd)).toEqual([
      'run',
      '--rm',
      '-it',
      '--init',
      '--security-opt',
      'label=disable',
      '--user',
      '1000:1001',
      '--env',
      'HOME=/home/me',
      '--workdir',
      cwd,
      '--mount',
      `type=bind,source=${cwd},target=${cwd}`,
      'agents:1',
      'agent',
      'resume',
      's-1',
    ]);
  });

  it("checks the CLI's version inside the image", () => {
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.versionArgs).toEqual(['run', '--rm', 'agents:1', 'agent', '--version']);
  });

  it("passes Gemini's prompt on stdin like Gemini itself", () => {
    const sandbox = new DockerSandbox(new GeminiAdapter('gemini'), 'agents:1', 'linux', USER);
    expect(sandbox.encodePrompt?.('review this')).toBe('review this');
  });

  it('has no stdin prompt for a CLI that takes it as an argument', () => {
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.encodePrompt).toBeUndefined();
  });

  it('keeps the capabilities of the CLI it runs', () => {
    const sandbox = new DockerSandbox(new ClaudeCodeAdapter('claude'), 'agents:1', 'linux', USER);
    expect(sandbox.capabilities.midTurnInput).toBe(true);
  });
});

describe('createAdapter', () => {
  it('runs a profile with sandbox docker through docker', () => {
    const adapter = createAdapter({
      provider: 'claude-code',
      command: 'claude',
      model: null,
      sandbox: 'docker',
      sandboxImage: 'agents:1',
    });
    expect(adapter.command).toBe('docker');
  });

  it('runs a profile without a sandbox directly', () => {
    const adapter = createAdapter({ provider: 'claude-code', command: 'claude', model: null });
    expect(adapter.command).toBe('claude');
  });
});

describe('DockerSandbox.ensureReady', () => {
  it('refuses to start when docker is not on PATH', async () => {
    vi.stubEnv('PATH', tempDir('empty-path'));
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    await expect(sandbox.ensureReady()).rejects.toThrow(
      'the agent runs in a Docker sandbox, but docker was not found on PATH; it was not started',
    );
  });

  it('refuses to start on Windows', async () => {
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'win32', USER);
    await expect(sandbox.ensureReady()).rejects.toThrow(
      'the Docker sandbox is not supported on Windows; the agent was not started',
    );
  });
});

/** True when a docker daemon answers here; the tests below need one. */
function dockerRuns(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Linux only: Docker Desktop on macOS is not on CI runners, and Windows ones run Windows
// containers. The image is pulled when it is missing, which needs the network.
const IMAGE = 'alpine:3';

/** A shell in the image standing in for an agent CLI: `sh -c <script>`. */
class ShellAdapter extends ConfiguredAdapter {
  override readonly command = 'sh';

  override buildArgs(spec: SessionSpec): string[] {
    return ['-c', spec.prompt];
  }
}

describe.runIf(process.platform === 'linux' && dockerRuns())('DockerSandbox with docker', () => {
  beforeAll(() => {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    } catch {
      execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' }); // not here yet
    }
  }, 120_000);

  it('lets the agent write in the task folder as the user', async () => {
    const cwd = tempDir('sandbox-real');
    const sandbox = new DockerSandbox(new ShellAdapter([]), IMAGE);
    await output('docker', sandbox.buildArgs(spec(cwd, { prompt: 'echo hi > out.txt' })), 60_000);
    expect(statSync(path.join(cwd, 'out.txt')).uid).toBe(process.getuid!());
  });

  it('hides folders that are not mounted', async () => {
    const cwd = tempDir('sandbox-real');
    const outside = tempDir('sandbox-outside');
    writeFileSync(path.join(outside, 'secret.txt'), 'no\n');
    const script = `test -e ${outside}/secret.txt && echo seen || echo hidden`;
    const sandbox = new DockerSandbox(new ShellAdapter([]), IMAGE);
    const out = await output('docker', sandbox.buildArgs(spec(cwd, { prompt: script })), 60_000);
    expect(out.trim()).toBe('hidden');
  });

  it('refuses writes to a readable dir', async () => {
    const cwd = tempDir('sandbox-real');
    const evidence = tempDir('sandbox-evidence');
    const script = `touch ${evidence}/new.txt 2>/dev/null; echo done`;
    const sandbox = new DockerSandbox(new ShellAdapter([]), IMAGE);
    const args = sandbox.buildArgs(spec(cwd, { prompt: script, readableDirs: [evidence] }));
    await output('docker', args, 60_000);
    expect(existsSync(path.join(evidence, 'new.txt'))).toBe(false);
  });

  it('reads a mounted config folder', async () => {
    const cwd = tempDir('sandbox-real');
    const config = tempDir('sandbox-config');
    mkdirSync(path.join(config, 'sub'));
    writeFileSync(path.join(config, 'sub', 'login.json'), 'token\n');
    const sandbox = new DockerSandbox(new ShellAdapter([config]), IMAGE);
    const args = sandbox.buildArgs(spec(cwd, { prompt: `cat ${config}/sub/login.json` }));
    expect(await output('docker', args, 60_000)).toBe('token\n');
  });
});
