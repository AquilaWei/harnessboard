// SPDX-License-Identifier: Apache-2.0
// The Docker sandbox's command line, its refusal to run without docker, and (when docker
// is installed) a real container.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentCapabilities, SessionSpec } from '../src/agent.js';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { GeminiAdapter } from '../src/gemini.js';
import { output } from '../src/process.js';
import { createAdapter } from '../src/providers.js';
import { DockerSandbox } from '../src/sandbox.js';
import { makeRepo, tempDir } from './helpers.js';

const USER = { uid: 1000, gid: 1001, home: '/home/me' };

/** The repository's `.git` as git prints it: with forward slashes, also on Windows. */
const gitDirOf = (repo: string) => `${repo.replaceAll('\\', '/')}/.git`;

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

/** Points git's global config at a file with `content`, so this machine's own is not read. */
function globalGitConfig(content: string): void {
  const file = path.join(tempDir('gitconfig'), 'gitconfig');
  writeFileSync(file, content);
  vi.stubEnv('GIT_CONFIG_GLOBAL', file);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
}

const HOST_IDENTITY = '[user]\n  name = Host User\n  email = host@example.com\n';

/** A worktree whose repository has no identity of its own, so git takes the global one. */
function worktreeWithoutIdentity(): { repo: string; dir: string } {
  const { repo, dir } = worktree();
  execFileSync('git', ['config', '--unset', 'user.name'], { cwd: repo });
  execFileSync('git', ['config', '--unset', 'user.email'], { cwd: repo });
  return { repo, dir };
}

beforeEach(() => {
  globalGitConfig('');
});

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
      '--tmpfs',
      '/home/me:uid=1000,gid=1001,mode=0700,exec',
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
      `type=bind,source=${gitDirOf(repo)},target=${gitDirOf(repo)}`,
    );
  });

  it("mounts a worktree's git directory read-only for a read-only session", () => {
    const { repo, dir } = worktree();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(dir, { access: 'readOnly' }))).toContain(
      `type=bind,source=${gitDirOf(repo)},target=${gitDirOf(repo)},readonly`,
    );
  });

  it('mounts nothing more for a repository whose git directory is inside it', () => {
    const repo = makeRepo();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(repo)).filter((arg) => arg === '--mount')).toHaveLength(1);
  });

  it('mounts no empty home over a home that is the task folder', () => {
    const cwd = tempDir('sandbox-cwd');
    const user = { uid: 1000, gid: 1001, home: cwd };
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', user);
    expect(sandbox.buildArgs(spec(cwd))).not.toContain('--tmpfs');
  });

  it('mounts no empty home over a home inside a readable dir', () => {
    const cwd = tempDir('sandbox-cwd');
    const evidence = tempDir('sandbox-evidence');
    const user = { uid: 1000, gid: 1001, home: path.join(evidence, 'me') };
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', user);
    expect(sandbox.buildArgs(spec(cwd, { readableDirs: [evidence] }))).not.toContain('--tmpfs');
  });

  it('passes the git identity configured outside the repository', () => {
    globalGitConfig(HOST_IDENTITY);
    const { repo, dir } = worktreeWithoutIdentity();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    const gitDir = gitDirOf(repo);
    expect(sandbox.buildArgs(spec(dir))).toEqual([
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
      dir,
      '--tmpfs',
      '/home/me:uid=1000,gid=1001,mode=0700,exec',
      '--mount',
      `type=bind,source=${dir},target=${dir}`,
      '--env',
      'GIT_AUTHOR_NAME=Host User',
      '--env',
      'GIT_COMMITTER_NAME=Host User',
      '--env',
      'GIT_AUTHOR_EMAIL=host@example.com',
      '--env',
      'GIT_COMMITTER_EMAIL=host@example.com',
      '--mount',
      `type=bind,source=${gitDir},target=${gitDir}`,
      'agents:1',
      'agent',
      'exec',
      'do it',
    ]);
  });

  it("passes the repository's own git identity over the global one", () => {
    globalGitConfig(HOST_IDENTITY);
    const { dir } = worktree();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(dir))).toContain('GIT_AUTHOR_EMAIL=test@example.com');
  });

  it('passes no git identity when none is configured', () => {
    const { dir } = worktreeWithoutIdentity();
    const sandbox = new DockerSandbox(new ConfiguredAdapter([]), 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(dir)).some((arg) => arg.startsWith('GIT_'))).toBe(false);
  });

  it("empties Gemini's system policy folder for a read-only session", () => {
    const cwd = tempDir('sandbox-cwd');
    const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
    const sandbox = new DockerSandbox(gemini, 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(cwd, { access: 'readOnly' }))).toContain(
      'type=tmpfs,target=/etc/gemini-cli/policies,tmpfs-mode=0555',
    );
  });

  it("leaves Gemini's system policy folder alone for an editing session", () => {
    const cwd = tempDir('sandbox-cwd');
    const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
    const sandbox = new DockerSandbox(gemini, 'agents:1', 'linux', USER);
    expect(sandbox.buildArgs(spec(cwd)).some((arg) => arg.startsWith('type=tmpfs'))).toBe(false);
  });

  it('still refuses a read-only Gemini session when this machine has system policies', () => {
    const cwd = tempDir('sandbox-cwd');
    const hostPolicies = tempDir('host-policies');
    writeFileSync(path.join(hostPolicies, 'company.toml'), '');
    const sandbox = new DockerSandbox(
      new GeminiAdapter('gemini', hostPolicies),
      'agents:1',
      'linux',
      USER,
    );
    expect(() => sandbox.buildArgs(spec(cwd, { access: 'readOnly' }))).toThrow(
      /ignores --admin-policy/,
    );
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
      '--tmpfs',
      '/home/me:uid=1000,gid=1001,mode=0700,exec',
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

  it('gives a user whose home the image lacks a home it can write caches in', async () => {
    const cwd = tempDir('sandbox-real');
    chmodSync(cwd, 0o777); // the workdir, entered as a uid that does not own it
    const home = path.join(tempDir('sandbox-home'), 'home'); // a path the image does not have
    const config = path.join(home, '.agent');
    mkdirSync(config, { recursive: true });
    const user = { uid: 4321, gid: 4321, home };
    const sandbox = new DockerSandbox(new ShellAdapter([config]), IMAGE, 'linux', user);
    const script = 'mkdir -p ~/.npm/_cacache && test -d ~/.agent && echo written';
    const out = await output('docker', sandbox.buildArgs(spec(cwd, { prompt: script })), 60_000);
    expect(out).toBe('written\n');
  });
});

// An image with git, a Gemini system policy that allows everything, and a `gemini` that runs
// its stdin (where Gemini's prompt goes) as a shell script. Building it needs the network.
const AGENT_IMAGE = 'harnessboard-test-sandbox:1';
const AGENT_DOCKERFILE = `FROM ${IMAGE}
RUN apk add --no-cache git \\
 && mkdir -p /etc/gemini-cli/policies \\
 && printf '[[rule]]\\ntoolName = "*"\\ndecision = "allow"\\npriority = 999\\n' > /etc/gemini-cli/policies/company.toml \\
 && printf '#!/bin/sh\\nexec sh -s\\n' > /usr/local/bin/gemini \\
 && chmod +x /usr/local/bin/gemini
`;

/** Runs a session's `docker run` with `stdin`, returning what it printed. */
function run(args: string[], stdin = ''): string {
  return execFileSync('docker', args, { input: stdin, encoding: 'utf8', timeout: 60_000 });
}

describe.runIf(process.platform === 'linux' && dockerRuns())(
  'DockerSandbox with docker and an agent image',
  () => {
    beforeAll(() => {
      execFileSync('docker', ['build', '-q', '-t', AGENT_IMAGE, '-'], {
        input: AGENT_DOCKERFILE,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    }, 300_000);

    afterAll(() => {
      execFileSync('docker', ['image', 'rm', AGENT_IMAGE], { stdio: 'ignore' });
    });

    it("shows a read-only Gemini session none of the image's system policies", () => {
      const cwd = tempDir('sandbox-real');
      const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
      const sandbox = new DockerSandbox(gemini, AGENT_IMAGE);
      const args = sandbox.buildArgs(spec(cwd, { access: 'readOnly' }));
      expect(run(args, 'ls -A /etc/gemini-cli/policies; echo end')).toBe('end\n');
    });

    it('lets a read-only Gemini session read its admin policy', () => {
      const cwd = tempDir('sandbox-real');
      const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
      const sandbox = new DockerSandbox(gemini, AGENT_IMAGE);
      const args = sandbox.buildArgs(spec(cwd, { access: 'readOnly' }));
      const policy = args[args.indexOf('--admin-policy') + 1]!;
      expect(run(args, `head -n 1 ${policy}`)).toBe(
        '# Written by Harnessboard for read-only (reviewer) sessions.\n',
      );
    });

    it('keeps a read-only Gemini session from adding a system policy', () => {
      const cwd = tempDir('sandbox-real');
      const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
      const sandbox = new DockerSandbox(gemini, AGENT_IMAGE);
      const args = sandbox.buildArgs(spec(cwd, { access: 'readOnly' }));
      const script =
        'touch /etc/gemini-cli/policies/mine.toml 2>/dev/null; ls -A /etc/gemini-cli/policies; echo end';
      expect(run(args, script)).toBe('end\n');
    });

    it("leaves an editing Gemini session the image's system policies", () => {
      const cwd = tempDir('sandbox-real');
      const gemini = new GeminiAdapter('gemini', tempDir('host-policies'));
      const sandbox = new DockerSandbox(gemini, AGENT_IMAGE);
      const args = sandbox.buildArgs(spec(cwd));
      expect(run(args, 'ls -A /etc/gemini-cli/policies')).toBe('company.toml\n');
    });

    it('commits from a worktree with the identity configured only on this machine', () => {
      globalGitConfig(HOST_IDENTITY);
      const { dir } = worktreeWithoutIdentity();
      const script = 'echo x > new.txt && git add new.txt && git commit -qm sandboxed';
      const sandbox = new DockerSandbox(new ShellAdapter([]), AGENT_IMAGE);
      run(sandbox.buildArgs(spec(dir, { prompt: script })));
      const author = execFileSync('git', ['log', '-1', '--format=%an <%ae> / %cn <%ce>'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(author).toBe('Host User <host@example.com> / Host User <host@example.com>\n');
    });
  },
);
