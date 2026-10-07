#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stand-in for `gemini --output-format stream-json`, prompt on stdin, in tests.
// FAKE_GEMINI_SCENARIO: JSON file { "runs": [[...lines], ...] }. The n-th run of the fake
// prints runs[n] (counted in a sibling `.count` file), one JSON line each, and exits 0.
// A line {"__exit": code} writes {"__stderr"}'s text (if any) to stderr and exits with that code.
// FAKE_GEMINI_LOG: file that receives one JSON line per run with the args and stdin.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const scenarioFile = process.env.FAKE_GEMINI_SCENARIO;
const countFile = `${scenarioFile}.count`;
const run = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(run + 1));
const lines = JSON.parse(readFileSync(scenarioFile, 'utf8')).runs[run] ?? [];

// Read stdin to its end, as Gemini does; not readFileSync(0), which can fail on Windows pipes.
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_GEMINI_LOG) {
  appendFileSync(
    process.env.FAKE_GEMINI_LOG,
    JSON.stringify({ args: process.argv.slice(2), stdin }) + '\n',
  );
}

for (const line of lines) {
  if (line.__exit !== undefined) {
    if (line.__stderr) process.stderr.write(line.__stderr + '\n');
    // Not process.exit(): on Windows a pipe write is async and the last lines could be lost.
    process.exitCode = line.__exit;
    break;
  }
  process.stdout.write(JSON.stringify(line) + '\n');
}
