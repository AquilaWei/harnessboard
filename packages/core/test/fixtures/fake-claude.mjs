#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stand-in for `claude -p --input-format stream-json` in tests.
// FAKE_CLAUDE_SCENARIO: JSON file { "sessions": [{ "turns": [[...lines], ...] }, ...] }.
// The n-th run of the fake plays sessions[n] (counted in a sibling `.count` file); within it,
// the i-th user message on stdin emits turns[i]. A line {"__hang": true} waits until killed;
// {"__exit": code} writes {"__stderr"}'s text (if any) to stderr and exits with that code.
// {"__write": {"path", "content"}} writes a file relative to the working directory.
// {"__commit": message} commits every change in the working directory, as an agent would.
// A {"type": "control_request"} line is printed, then the fake waits for the matching
// control_response on stdin and records its answer in `received` as { answer }.
// With `--prompt <text>` it acts like a CLI without stdin input: it answers that one prompt
// with turns[0] and exits (`--resume <id>` is only logged).
// FAKE_CLAUDE_LOG: file that receives one JSON line per run with the args and messages.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const scenarioFile = process.env.FAKE_CLAUDE_SCENARIO;
const countFile = `${scenarioFile}.count`;
const run = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(run + 1));
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')).sessions[run] ?? { turns: [] };
const received = [];
const log = () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(
      process.env.FAKE_CLAUDE_LOG,
      JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), received }) + '\n',
    );
  }
};

let contextTokens = 0;
const promptAt = process.argv.indexOf('--prompt');
if (promptAt !== -1) {
  received.push(process.argv[promptAt + 1]);
  await emit(scenario.turns[0] ?? []);
  log();
  process.exit(0);
}

let turn = 0;
let queue = Promise.resolve();
const answers = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') {
    received.push({ answer: msg.response.response });
    answers.get(msg.response.request_id)?.();
    return;
  }
  received.push(msg.message.content);
  const scripted = scenario.turns[turn++];
  const lines =
    scripted ??
    (msg.message.content === '/compact'
      ? [
          {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: {
              pre_tokens: contextTokens,
              post_tokens: Math.min(contextTokens, 1000),
            },
          },
          { type: 'result', subtype: 'success', is_error: false, result: '' },
        ]
      : []);
  queue = queue.then(() => emit(lines));
});
process.stdin.on('end', () =>
  queue.then(() => {
    log();
    process.exit(0);
  }),
);

async function emit(lines) {
  for (const line of lines) {
    if (line.type === 'assistant' && line.message?.usage) {
      const usage = line.message.usage;
      contextTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    }
    if (line.__exit !== undefined) {
      if (line.__stderr) process.stderr.write(line.__stderr + '\n');
      log();
      process.exit(line.__exit);
    }
    if (line.__write) {
      mkdirSync(dirname(line.__write.path), { recursive: true });
      writeFileSync(line.__write.path, line.__write.content);
      continue;
    }
    if (line.__commit !== undefined) {
      execFileSync('git', ['add', '-A'], { stdio: 'pipe' });
      if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
        execFileSync('git', ['commit', '-q', '-m', line.__commit], { stdio: 'pipe' });
      }
      continue;
    }
    if (line.__hang) {
      log();
      await new Promise(() => {});
    }
    process.stdout.write(JSON.stringify(line) + '\n');
    if (line.type === 'control_request') {
      await new Promise((resolve) => answers.set(line.request_id, resolve));
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
