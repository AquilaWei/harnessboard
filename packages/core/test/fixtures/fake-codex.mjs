#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// App-server stand-in: checks the handshake and waits for each RPC approval before acting.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const messages = [];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const threadId = 'codex-thread';
const turnId = 'codex-turn';
let ready = false;
let index = 0;

function next() {
  const request = scenario.requests?.[index];
  if (request) {
    if (request.item)
      send({ method: 'item/started', params: { threadId, turnId, item: request.item } });
    send({
      id: request.id,
      method: request.method,
      params: { threadId, turnId, ...request.params },
    });
  } else if (!scenario.hang) {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: 'answer', text: scenario.text ?? 'done' },
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId,
        turn: {
          id: turnId,
          status: scenario.error ? 'failed' : 'completed',
          error: scenario.error ?? null,
        },
      },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  messages.push(msg);
  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  else if (msg.method === 'initialized') ready = true;
  else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (!ready) throw new Error('thread requested before initialized');
    send({ id: msg.id, result: { thread: { id: threadId }, model: 'test-model' } });
  } else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    next();
  } else if (msg.id === scenario.requests?.[index]?.id) {
    const request = scenario.requests[index];
    if (msg.result?.decision === 'accept' && request.commit) {
      writeFileSync('report.txt', 'report\n');
      execFileSync('git', ['add', '--', 'report.txt']);
      execFileSync('git', ['commit', '-q', '-m', 'docs: add report']);
    }
    send({ method: 'serverRequest/resolved', params: { threadId, requestId: msg.id } });
    index++;
    next();
  }
});
rl.on('close', () => {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), messages }) + '\n',
  );
});
