// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import type { SessionMcpServer } from './agent.js';

const fields = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const id = { id: string };
export const PM_TOOLS = [
  {
    name: 'profiles',
    description: 'Available permitted worker profiles and models.',
    inputSchema: fields({}),
  },
  {
    name: 'dispatch',
    description:
      'Start a managed worker. Delegate only when the benefit exceeds context and integration costs. Writers queue for the shared worktree. A worker delegating edits must yield before its child can start. Returns immediately.',
    inputSchema: fields(
      {
        agentId: string,
        model: { type: ['string', 'null'] },
        effort: { type: ['string', 'null'] },
        goal: string,
        acceptance: string,
        scope: string,
        access: { enum: ['edit', 'readOnly'] },
      },
      ['agentId', 'goal', 'acceptance', 'scope', 'access'],
    ),
  },
  {
    name: 'continue_work',
    description: 'Continue the same worker conversation with incremental instructions.',
    inputSchema: fields({ ...id, message: string }, ['id', 'message']),
  },
  {
    name: 'cancel_work',
    description: 'Cancel a child job and preserve its files and evidence.',
    inputSchema: fields(id, ['id']),
  },
  {
    name: 'work_status',
    description: 'Fetch child summaries and evidence locations; do not poll.',
    inputSchema: fields({}),
  },
  {
    name: 'wait',
    description:
      'Yield to active children. Fails when no child can produce a result. End this turn immediately; the harness releases your write access and resumes you after child results.',
    inputSchema: fields({}),
  },
  {
    name: 'report_progress',
    description:
      'Report a concise milestone, current activity or blocker. Do not repeatedly report unchanged status.',
    inputSchema: fields({ message: string }, ['message']),
  },
  {
    name: 'ask_pm',
    description:
      'Workers only: report missing information or authorization to the PM. End this turn and wait for the PM to continue this work.',
    inputSchema: fields({ message: string }, ['message']),
  },
  {
    name: 'propose_spec',
    description:
      'Propose complete direction, scope and acceptance criteria for explicit user approval. Cannot dispatch until approved. End this turn.',
    inputSchema: fields({ criteria: string, message: string }, ['criteria', 'message']),
  },
  {
    name: 'ask_user',
    description:
      'Escalate an ambiguity, permission or execution problem you cannot resolve. End this turn.',
    inputSchema: fields({ message: string }, ['message']),
  },
  {
    name: 'permission',
    description:
      'Allow once or deny a currently pending worker permission. Never grants permanent rules.',
    inputSchema: fields(
      { requestId: string, behavior: { enum: ['allow', 'deny'] }, reason: string },
      ['requestId', 'behavior', 'reason'],
    ),
  },
  {
    name: 'accept',
    description:
      'Submit a completion report and wait for user review after inspecting actual code, architecture, functionality and verification evidence. This does not mark the task done. Requires no unfinished children and current clean HEAD.',
    inputSchema: fields(
      {
        head: string,
        architecture: string,
        functionality: string,
        verification: string,
        summary: string,
      },
      ['head', 'architecture', 'functionality', 'verification', 'summary'],
    ),
  },
];

// This stdio process has only a task-scoped capability; it cannot select another task.
const BRIDGE = `import {createInterface} from 'node:readline';
const rl=createInterface({input:process.stdin});
for await (const line of rl) {
 let m; try {m=JSON.parse(line)} catch {continue}
 if(m.id===undefined) continue;
 try {
  let result;
  if(m.method==='initialize') result={protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'harnessboard',version:'1'}};
  else if(m.method==='ping') result={};
  else if(m.method==='tools/list'||m.method==='tools/call') {
   const r=await fetch(process.env.HB_PM_ENDPOINT,{method:'POST',headers:{authorization:'Bearer '+process.env.HB_PM_CAPABILITY,'content-type':'application/json'},body:JSON.stringify({method:m.method,params:m.params})});
   if(!r.ok) throw new Error('PM tool bridge refused request');
   result=await r.json();
  } else throw new Error('Unsupported MCP method');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 } catch(e) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}})+'\\n')}
}
`;

/** Binds tools to one caller; workers see only delegation tools. Closing revokes access. */
export async function pmTools(
  dataDir: string,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  worker = false,
): Promise<{ server: SessionMcpServer; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const file = path.join(dataDir, `pm-bridge-${randomBytes(8).toString('hex')}.mjs`);
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, BRIDGE, { mode: 0o600 });
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128_000) throw new Error('Tool input too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result: unknown;
      if (body.method === 'tools/list')
        result = {
          tools: PM_TOOLS.filter((tool) =>
            worker
              ? !['propose_spec', 'ask_user', 'permission', 'accept'].includes(tool.name)
              : tool.name !== 'ask_pm',
          ),
        };
      else if (body.method === 'tools/call') {
        try {
          const value = await call(body.params?.name, body.params?.arguments ?? {});
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (err) {
          result = { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
        }
      } else throw new Error('Unsupported method');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No PM bridge address');
  return {
    server: {
      command: process.execPath,
      args: [file],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HB_PM_ENDPOINT: `http://127.0.0.1:${address.port}`,
        HB_PM_CAPABILITY: token,
      },
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
        http.closeAllConnections();
      });
      await rm(file, { force: true });
    },
  };
}
