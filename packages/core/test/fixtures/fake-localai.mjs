#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stand-in for `localai run --json --model NAME` in tests.
// FAKE_LOCALAI_SCENARIO: JSON file
//   { "lines": [...], "exitCode": 0, "stderr": "text", "hang": false, "pidFile": "path" }
// Each entry of `lines` is printed as one stdout line: a string verbatim, an object as JSON
// with `version: 1` and a fixed `request_id` filled in unless the object sets them.
// `hang: true` keeps the process alive after the lines until it is killed.
// `pidFile` receives the process id at start so a test can check the process was reaped.
// `delayMs` delays completion; FAKE_LOCALAI_LIFECYCLE records start/end with the prompt.
// FAKE_LOCALAI_LOG: file that receives one JSON line per run with the args and the stdin text.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.FAKE_LOCALAI_SCENARIO, 'utf8'));
if (scenario.pidFile) writeFileSync(scenario.pidFile, String(process.pid));

if (process.argv[2] === 'models') {
  console.log(JSON.stringify({ models: [{ name: 'lfm2.5' }, { name: 'other' }] }));
  process.exit(0);
}
if (process.argv[2] === 'serve') {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const stdin = JSON.parse(body).messages[0].content;
    if (scenario.hang) return;
    if (process.env.FAKE_LOCALAI_LOG)
      appendFileSync(
        process.env.FAKE_LOCALAI_LOG,
        JSON.stringify({ args: process.argv.slice(2), stdin }) + '\n',
      );
    if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
    const text =
      scenario.lines
        ?.filter((line) => line?.data?.channel === 'answer')
        .map((line) => line.data.text)
        .join('') ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  server.listen(0, '127.0.0.1', () =>
    console.log(JSON.stringify({ event: 'ready', host: '127.0.0.1', port: server.address().port })),
  );
  process.on('SIGTERM', () => process.exit(0));
  await new Promise(() => {});
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_LOCALAI_LOG) {
  appendFileSync(
    process.env.FAKE_LOCALAI_LOG,
    JSON.stringify({ args: process.argv.slice(2), stdin }) + '\n',
  );
}

const lifecycle = (event) => {
  if (process.env.FAKE_LOCALAI_LIFECYCLE) {
    appendFileSync(process.env.FAKE_LOCALAI_LIFECYCLE, JSON.stringify({ event, stdin }) + '\n');
  }
};
lifecycle('start');
if (scenario.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));

for (const line of scenario.lines ?? []) {
  const text =
    typeof line === 'string'
      ? line
      : JSON.stringify({ version: 1, request_id: 'a'.repeat(32), ...line });
  process.stdout.write(text + '\n');
}
if (scenario.stderr) process.stderr.write(scenario.stderr + '\n');
if (scenario.hang)
  setInterval(() => {}, 1000); // keeps the event loop alive until killed
else {
  lifecycle('end');
  process.exit(scenario.exitCode ?? 0);
}
