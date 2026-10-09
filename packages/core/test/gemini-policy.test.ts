// SPDX-License-Identifier: Apache-2.0
// Puts the policy a read-only Gemini session gets through Gemini's own policy engine, next to
// the allowances a user may already have. Needs `@google/gemini-cli-core` installed outside
// the workspace (CI does this); set HARNESSBOARD_TEST_GEMINI_CORE to its package folder.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../src/gemini.js';
import { tempDir } from './helpers.js';

const CORE = process.env.HARNESSBOARD_TEST_GEMINI_CORE;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
interface PolicyEngine {
  check(call: ToolCall, serverName: string | undefined): Promise<{ decision: string }>;
}
interface PolicySettings {
  adminPolicyPaths?: string[];
  tools?: { allowed?: string[] };
}
interface Gemini {
  createPolicyEngineConfig(
    settings: PolicySettings,
    mode: string,
    defaultPoliciesDir: undefined,
    interactive: boolean,
  ): Promise<object>;
  PolicyEngine: new (config: object) => PolicyEngine;
  Storage: { getSystemPoliciesDir(): string };
}

let gemini: Gemini;
let systemPolicies: string;
const previousHome = process.env.GEMINI_CLI_HOME;

async function load(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path.join(CORE!, 'dist', 'src', file)).href)) as Record<
    string,
    unknown
  >;
}

beforeAll(async () => {
  if (!CORE) return;
  gemini = {
    ...(await load('policy/config.js')),
    ...(await load('policy/policy-engine.js')),
    ...(await load('config/storage.js')),
  } as unknown as Gemini;
  // The user's own policies: everything a reviewer must not do is allowed outright.
  const home = tempDir('gemini-home');
  mkdirSync(path.join(home, '.gemini', 'policies'), { recursive: true });
  writeFileSync(
    path.join(home, '.gemini', 'policies', 'mine.toml'),
    `[[rule]]
toolName = ["write_file", "replace", "run_shell_command", "exit_plan_mode"]
decision = "allow"
priority = 999
`,
  );
  process.env.GEMINI_CLI_HOME = home;
  // Gemini reads its system policies from a fixed folder; point it at one of the test's own.
  gemini.Storage.getSystemPoliciesDir = () => systemPolicies;
});

beforeEach(() => {
  systemPolicies = tempDir('gemini-system-policies');
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = previousHome;
});

/** The policy file a read-only session is started with. */
function readOnlyPolicy(): string {
  const args = new GeminiAdapter('gemini', systemPolicies).buildArgs({
    cwd: '/work',
    sessionId: null,
    resume: false,
    prompt: 'review',
    model: null,
    effort: null,
    access: 'readOnly',
    allowedTools: [],
    skipPermissions: false,
    askPermission: false,
  });
  return args[args.indexOf('--admin-policy') + 1]!;
}

/** Gemini's decision for one tool call in a headless plan-mode session. */
async function decide(
  settings: PolicySettings,
  name: string,
  args: Record<string, unknown>,
  serverName?: string,
): Promise<string> {
  const config = await gemini.createPolicyEngineConfig(settings, 'plan', undefined, false);
  const engine = new gemini.PolicyEngine({ ...config, approvalMode: 'plan', nonInteractive: true });
  return (await engine.check({ name, args }, serverName)).decision;
}

describe.skipIf(!CORE)("Gemini's policy engine with the read-only policy", () => {
  it('refuses a file write the user allows', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'write_file', {
      file_path: 'src/app.ts',
      content: 'x',
    });
    expect(decision).toBe('deny');
  });

  it('refuses an edit the user allows', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'replace', {
      file_path: 'src/app.ts',
    });
    expect(decision).toBe('deny');
  });

  it('refuses a shell command the user allows', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'run_shell_command', {
      command: 'git commit -am x',
    });
    expect(decision).toBe('deny');
  });

  it('refuses a shell command the settings allow', async () => {
    const decision = await decide(
      { adminPolicyPaths: [readOnlyPolicy()], tools: { allowed: ['run_shell_command'] } },
      'run_shell_command',
      { command: 'rm -rf src' },
    );
    expect(decision).toBe('deny');
  });

  it('refuses leaving plan mode', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'exit_plan_mode', {});
    expect(decision).toBe('deny');
  });

  it('refuses an MCP tool', async () => {
    const decision = await decide(
      { adminPolicyPaths: [readOnlyPolicy()] },
      'mcp_github_create_issue',
      {},
      'github',
    );
    expect(decision).toBe('deny');
  });

  it('allows reading a file', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'read_file', {
      file_path: 'src/app.ts',
    });
    expect(decision).toBe('allow');
  });

  it('allows searching files', async () => {
    const decision = await decide({ adminPolicyPaths: [readOnlyPolicy()] }, 'grep_search', {
      pattern: 'TODO',
    });
    expect(decision).toBe('allow');
  });
});

describe.skipIf(!CORE)("Gemini's policy engine without the read-only policy", () => {
  it('lets plan mode write a file the user allows, which is what the policy prevents', async () => {
    const decision = await decide({}, 'write_file', { file_path: 'src/app.ts', content: 'x' });
    expect(decision).toBe('allow');
  });
});

describe.skipIf(!CORE)('a machine with Gemini system policies', () => {
  it('has Gemini ignore the read-only policy', async () => {
    const policy = readOnlyPolicy();
    writeFileSync(path.join(systemPolicies, 'company.toml'), '');
    const decision = await decide({ adminPolicyPaths: [policy] }, 'write_file', {
      file_path: 'src/app.ts',
      content: 'x',
    });
    expect(decision).toBe('allow');
  });

  it('gets no read-only session started', () => {
    writeFileSync(path.join(systemPolicies, 'company.toml'), '');
    expect(() => readOnlyPolicy()).toThrow(/ignores --admin-policy/);
  });
});
