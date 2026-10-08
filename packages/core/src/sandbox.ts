// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, ModelInfo, QuotaInfo } from '@harnessboard/shared';
import type {
  AgentAdapter,
  AgentConnection,
  LineParser,
  PermissionReply,
  SessionAccess,
  SessionSpec,
} from './agent.js';
import { output } from './process.js';

type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

/** Where the sandbox looks for docker; a missing one fails the task (see `ensureReady`). */
export const DOCKER_COMMAND = 'docker';

/** Who the agent runs as in the container, so the files it writes stay the user's. */
export interface SandboxUser {
  uid: number;
  gid: number;
  home: string;
}

/**
 * Runs another adapter's CLI in a Docker container with `docker run`. Only the task's
 * folder, the git directory it commits to, the CLI's own config ({@link
 * AgentAdapter.configPaths}) and the session's `readableDirs` (read-only) are mounted,
 * each at the same path as on this machine, so every path in the arguments still works.
 *
 * The image must have the profile's command on its PATH. The agent runs as the user (the
 * same uid, gid and `HOME`), so it can use the mounted login and its files stay the
 * user's; that home is an empty one in memory, not the user's (see `emptyHome`). Environment variables are not passed in, apart from the git commit identity
 * resolved on this machine and `HOME`. The network is docker's default, so
 * the agent can reach its API. On SELinux hosts label confinement is turned off rather
 * than relabelling the user's folders, which `:z` mounts would do.
 */
export class DockerSandbox implements AgentAdapter {
  readonly command = DOCKER_COMMAND;
  // Optional members exist only when the inner adapter has them, because the runner and
  // the harness check for their presence.
  readonly encodePrompt?: (text: string) => string;
  readonly createParser?: () => LineParser;
  readonly createConnection?: (spec: SessionSpec, write: (data: string) => void) => AgentConnection;
  // Both run on this machine, not in the image: they read the CLI's records, which are
  // the mounted ones, and Codex's model list asks a codex installed here, if there is one.
  readonly listModels?: () => Promise<ModelInfo[]>;
  readonly readQuota?: () => Promise<QuotaInfo | null>;

  /**
   * `platform` and `user` stand in for this machine's in tests. Windows paths can not be
   * mounted at the same path in a Linux container, so there {@link ensureReady} refuses.
   */
  constructor(
    private readonly inner: AgentAdapter,
    private readonly image: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly user: SandboxUser = currentUser(),
  ) {
    if (inner.encodePrompt) this.encodePrompt = inner.encodePrompt.bind(inner);
    if (inner.createParser) this.createParser = inner.createParser.bind(inner);
    if (inner.createConnection) this.createConnection = inner.createConnection.bind(inner);
    if (inner.listModels) this.listModels = inner.listModels.bind(inner);
    if (inner.readQuota) this.readQuota = inner.readQuota.bind(inner);
  }

  get provider() {
    return this.inner.provider;
  }

  get capabilities() {
    return this.inner.capabilities;
  }

  /** Runs the CLI's own version command in the image, so a missing CLI shows up too. */
  get versionArgs(): string[] {
    return ['run', '--rm', this.image, this.inner.command, ...this.inner.versionArgs];
  }

  /**
   * Rejects when this is Windows, docker is not on PATH, or its daemon does not answer; the
   * agent then never starts, in or outside a container.
   */
  async ensureReady(): Promise<void> {
    if (this.platform === 'win32') {
      throw new Error('the Docker sandbox is not supported on Windows; the agent was not started');
    }
    try {
      await output(DOCKER_COMMAND, ['version', '--format', '{{.Server.Version}}']);
    } catch (err) {
      const reason =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'docker was not found on PATH'
          : `docker does not answer (${(err as Error).message})`;
      throw new Error(`the agent runs in a Docker sandbox, but ${reason}; it was not started`);
    }
  }

  buildArgs(spec: SessionSpec): string[] {
    const args = this.inner.buildArgs(spec);
    const mounts = this.mounts(spec.cwd, spec.access, spec.readableDirs ?? []);
    return ['run', '--rm', '-i', ...mounts, this.image, this.inner.command, ...args];
  }

  interactiveResumeArgs(agentSessionId: string, cwd: string): string[] {
    const args = this.inner.interactiveResumeArgs(agentSessionId, cwd);
    const mounts = this.mounts(cwd, 'edit', []);
    return ['run', '--rm', '-it', ...mounts, this.image, this.inner.command, ...args];
  }

  encodeMessage(text: string): string {
    return this.inner.encodeMessage(text);
  }

  encodePermissionReply(request: PermissionRequestEvent, reply: PermissionReply): string {
    return this.inner.encodePermissionReply(request, reply);
  }

  parseLine(line: string): AgentEvent[] {
    return this.inner.parseLine(line);
  }

  /**
   * The `docker run` options up to the image. A read-only session gets its git directory
   * read-only too; its folder stays writable, because a check it may run (the task's
   * verify command) can write build output. The commit identity git resolves for `cwd`
   * here is passed in, because the user's `~/.gitconfig` is not mounted.
   */
  private mounts(cwd: string, access: SessionAccess, readableDirs: string[]): string[] {
    const { uid, gid, home } = this.user;
    const args = ['--init', '--security-opt', 'label=disable', '--user', `${uid}:${gid}`];
    args.push('--env', `HOME=${home}`, '--workdir', cwd);
    const gitDir = outsideGitDir(cwd);
    // Docker would create a missing source as a root-owned folder, even for a file.
    const config = (this.inner.configPaths?.(access) ?? []).filter((file) => existsSync(file));
    const bound = [cwd, ...(gitDir ? [gitDir] : []), ...config, ...readableDirs];
    if (!bound.some((dir) => isWithin(home, dir))) args.push(...emptyHome(this.user));
    args.push(...bind(cwd, false));
    for (const variable of gitIdentity(cwd)) args.push('--env', variable);
    if (gitDir) args.push(...bind(gitDir, access === 'readOnly'));
    for (const file of config) args.push(...bind(file, false));
    for (const dir of readableDirs) args.push(...bind(dir, true));
    for (const dir of this.inner.containerEmptyDirs?.(access) ?? []) {
      // Mode 0555 on a root-owned tmpfs: the agent, which is not root, can not fill it.
      args.push('--mount', `type=tmpfs,target=${dir},tmpfs-mode=0555`);
    }
    return args;
  }
}

function bind(dir: string, readOnly: boolean): string[] {
  return ['--mount', `type=bind,source=${dir},target=${dir}${readOnly ? ',readonly' : ''}`];
}

/**
 * An empty home owned by the agent, in memory and gone with the container, so tools can
 * write caches such as `~/.npm` without the user's own home being mounted. Without it the
 * image rarely has the user's home path, and docker would create it, and every folder
 * above a config mount, as root. The config mounts land inside it, because docker mounts
 * a parent path first. `--tmpfs` rather than `--mount type=tmpfs`, which can not set the
 * owner; `exec` because by default it forbids running the tools a cache installs.
 */
function emptyHome({ uid, gid, home }: SandboxUser): string[] {
  return ['--tmpfs', `${home}:uid=${uid},gid=${gid},mode=0700,exec`];
}

/** True when `dir` is `parent` or lies inside it. */
function isWithin(dir: string, parent: string): boolean {
  const inside = path.relative(parent, dir);
  return !inside.startsWith('..') && !path.isAbsolute(inside);
}

/**
 * `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to the `user.name` and `user.email` git uses in
 * `cwd`, wherever they are configured, so commits in the container carry the user's
 * identity. Only those two settings are passed; signing and the rest of the user's git
 * config stay outside. Unset ones are left out, and git in the container then refuses to
 * commit as it would here. Blocks on `git` like {@link outsideGitDir}.
 */
function gitIdentity(cwd: string): string[] {
  const vars: string[] = [];
  for (const [key, suffix] of [
    ['user.name', 'NAME'],
    ['user.email', 'EMAIL'],
  ] as const) {
    const value = gitConfig(cwd, key);
    if (value) vars.push(`GIT_AUTHOR_${suffix}=${value}`, `GIT_COMMITTER_${suffix}=${value}`);
  }
  return vars;
}

function gitConfig(cwd: string, key: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // unset (exit 1), or no git here
  }
}

/**
 * The git directory `cwd` commits to when it lies outside `cwd`, as a worktree's does, or
 * `null`. Without it git in the container would not see a repository. Blocks on `git`,
 * because `buildArgs` is synchronous; it answers from local files in milliseconds.
 */
function outsideGitDir(cwd: string): string | null {
  let dir: string;
  try {
    dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git repository: there is nothing more to mount
  }
  const inside = path.relative(cwd, dir);
  return inside.startsWith('..') || path.isAbsolute(inside) ? dir : null;
}

function currentUser(): SandboxUser {
  const { uid, gid } = os.userInfo();
  return { uid, gid, home: os.homedir() };
}
