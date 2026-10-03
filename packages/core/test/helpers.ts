// SPDX-License-Identifier: Apache-2.0
// Synthetic stream-json lines shaped like real Claude Code output (docs/stream-json-notes.md).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentCapabilities, SessionSpec } from '../src/agent.js';
import { ClaudeCodeAdapter } from '../src/claude-code.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

export const init = (sessionId = 'sess') => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'test-model',
});

export const assistantText = (text: string, contextTokens: number) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: contextTokens - 2,
      cache_creation_input_tokens: 0,
    },
  },
});

export const rateLimit = (status: string, fiveHour: number, resetsAtSec: number) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status,
    resetsAt: resetsAtSec,
    unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: resetsAtSec } },
  },
});

export const result = (text: string, contextWindow = 100_000) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  api_error_status: null,
  modelUsage: { 'test-model': { contextWindow } },
});

/** A result reporting the conversation's totals so far, as Claude Code does. */
export const usageResult = (text: string, input: number, output: number, costUsd: number) => ({
  ...result(text),
  total_cost_usd: costUsd,
  modelUsage: {
    'test-model': {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: costUsd,
      contextWindow: 100_000,
    },
  },
});

export const errorResult = (status: number) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: 'usage limit reached',
  api_error_status: status,
  modelUsage: {},
});

export const compactBoundary = (preTokens: number, postTokens: number) => ({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual', pre_tokens: preTokens, post_tokens: postTokens },
});

export const hang = { __hang: true };

export const exitWith = (code: number, stderr?: string) => ({ __exit: code, __stderr: stderr });

export const writeFile = (filePath: string, content: string) => ({
  __write: { path: filePath, content },
});

/** A `feature_list.json` write with one entry per `passes` flag, ids F1, F2, ... */
export const featureList = (...passes: boolean[]) =>
  writeFile(
    'feature_list.json',
    JSON.stringify({
      features: passes.map((p, i) => ({
        id: `F${i + 1}`,
        description: `feature ${i + 1}`,
        passes: p,
      })),
    }),
  );

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(realpathSync.native(tmpdir()), `hb-${prefix}-`));
}

/** A git repository with one commit on `main`. */
export function makeRepo(): string {
  const repo = tempDir('repo');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // Windows runners default to autocrlf=true, which would turn the files' \n into \r\n.
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return repo;
}

/**
 * A Claude Code `can_use_tool` request for a shell command. The fake CLI waits for the
 * harness's answer before emitting the next line.
 */
export function askBash(requestId: string, command: string, ruleContent: string) {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command },
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
      tool_use_id: `toolu_${requestId}`,
    },
  };
}

/** Writes a fake-claude scenario (one entry of turns per session run) and returns its path. */
export function writeScenario(dir: string, sessions: unknown[][][]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify({ sessions: sessions.map((turns) => ({ turns })) }));
  return file;
}

/**
 * Stands in for CLIs like `codex exec` or `gemini -p`: the prompt is an argument, stdin is
 * not read, and the CLI picks the session id. Output is parsed as Claude stream-json.
 */
export class PromptArgAdapter implements AgentAdapter {
  readonly provider = 'claude-code';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    midTurnInput: false,
    sessionIds: 'agent',
    permissionPrompts: false,
  };
  private readonly parser = new ClaudeCodeAdapter(FAKE_CLAUDE);

  constructor(readonly command: string) {}

  buildArgs(spec: SessionSpec): string[] {
    const resume = spec.resume && spec.sessionId ? ['--resume', spec.sessionId] : [];
    return [...resume, '--prompt', spec.prompt];
  }

  encodeMessage(): string {
    throw new Error('this CLI takes no stdin input');
  }

  encodePermissionReply(): string {
    throw new Error('this CLI cannot ask for permission');
  }

  parseLine(line: string) {
    return this.parser.parseLine(line);
  }

  interactiveResumeArgs(id: string): string[] {
    return ['--resume', id];
  }
}
