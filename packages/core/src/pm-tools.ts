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
    name: 'appoint_secretary',
    description:
      'Appoint one lightweight, permitted local model to handle routine approvals and progress while you sleep. Prefer a fast low-cost model from profiles; keep decisions, dispatch and acceptance yourself. Reappoint to replace a failed secretary.',
    inputSchema: fields(
      {
        agentId: string,
        model: { type: ['string', 'null'] },
        effort: { type: ['string', 'null'] },
      },
      ['agentId', 'model'],
    ),
  },
  {
    name: 'reply_worker',
    description:
      'Secretary only: answer a simple pending question using a verbatim quote from approved instructions. If uncertain or previously unanswered by a secretary quote, escalate_pm so the PM handles the worker directly.',
    inputSchema: fields({ ...id, quote: string }, ['id', 'quote']),
  },
  {
    name: 'finish_batch',
    description:
      'Secretary only: close this message batch after resolving its permissions and questions. Workers may still be running; do not wait for their assignment, CI or acceptance. Record a concise summary and end your turn.',
    inputSchema: fields({ summary: string }, ['summary']),
  },
  {
    name: 'escalate_pm',
    description:
      'Secretary only: summarize a decision, ambiguity or blocker requiring the PM. End your turn.',
    inputSchema: fields({ message: string }, ['message']),
  },
  {
    name: 'profiles',
    description:
      'Available permitted worker profiles/models with live subscription quota (0–1 utilization; null means unknown), blocked state, and provider-wide activeWork/dispatchedWork counts for this task. Inspect before dispatch to balance suitable work across providers.',
    inputSchema: fields({}),
  },
  {
    name: 'dispatch',
    description:
      'Start a managed worker only after planning its benefit, context cost, reuse decision and completed dependencies. Editing workers DEFAULT to private branch worktrees; provide explicit writePaths and commit local changes before dispatch. Start one primary implementer for a small or coupled task and continue it across sequential steps. Additional development workers should accelerate independent ready features with defined interfaces and disjoint writePaths; do not create a series of new workers for sequential phases. Separate read-only review or specialist work needs a concrete benefit; read-only workers inspect the parent workspace by default. Explicit workspace=shared is an exception for coupled handoffs or special build/install operations; shared writers queue for file safety. Returns immediately.',
    inputSchema: fields(
      {
        agentId: string,
        model: { type: ['string', 'null'] },
        effort: { type: ['string', 'null'] },
        goal: {
          ...string,
          description:
            'One clearly bounded feature; state dependencies and the interface contracts other workers can rely on.',
        },
        acceptance: {
          ...string,
          description:
            'Concrete behavior and test commands proving this feature, including integration expectations.',
        },
        scope: {
          ...string,
          description:
            'Responsibilities, exclusions and shared interface owner; do not split tightly coupled edits.',
        },
        access: { enum: ['edit', 'readOnly'] },
        plan: fields(
          {
            benefit: {
              ...string,
              description:
                'Concrete benefit of a new conversation: parallel speedup for independent ready work, first implementer, independent review or needed specialization. Do not spawn just to balance counts.',
            },
            contextCost: {
              ...string,
              description:
                'Repeated context loading and integration costs, and why the benefit exceeds them. Keep small or tightly coupled work together.',
            },
            reuse: {
              ...string,
              description:
                'Consider existing work IDs first. Explain why continue_work is insufficient; use it instead for the same job, fixes or sequential phases in the same area.',
            },
            dependencies: {
              type: 'array',
              items: string,
              description:
                'Prerequisite work IDs. They must already be completed and branch deliveries integrated; do not load contexts for blocked future phases. Empty for independent work.',
            },
          },
          ['benefit', 'contextCost', 'reuse', 'dependencies'],
        ),
        writePaths: {
          type: 'array',
          items: string,
          minItems: 1,
          description:
            'Required for branch development: explicit owned files or directories (trailing /), no globs. Sibling ownership must not overlap. Agree interfaces in goal and acceptance.',
        },
        workspace: {
          enum: ['branch', 'shared'],
          description:
            'Defaults to branch for edit access (private worktree) and shared for readOnly access. Choose shared explicitly only when the assignment needs the parent directory.',
        },
      },
      ['agentId', 'goal', 'acceptance', 'scope', 'access', 'plan'],
    ),
  },
  {
    name: 'integrate_work',
    description:
      'Integrate a completed direct child branch into your own clean workspace (PM: task workspace). Returns conflict paths without changing files on conflict. Continue the same child to merge the target commit, resolve and test; then retry. Verify the combined result before acceptance.',
    inputSchema: fields(id, ['id']),
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
      {
        requestId: string,
        sessionId: string,
        ts: { type: 'number' },
        behavior: { enum: ['allow', 'deny'] },
        reason: string,
      },
      ['requestId', 'sessionId', 'ts', 'behavior', 'reason'],
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
   if(!r.ok) throw new Error('PM tool bridge HTTP '+r.status+' '+r.statusText);
   result=await r.json();
  } else throw new Error('Unsupported MCP method');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 } catch(e) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:[e.message,e.cause?.code,e.cause?.message].filter(Boolean).join(': ')}})+'\\n')}
}
`;

/** Binds tools to one caller; workers see only delegation tools. Closing revokes access. */
export async function pmTools(
  dataDir: string,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  worker: boolean | 'secretary' = false,
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
      const tools = PM_TOOLS.filter((tool) =>
        worker === 'secretary'
          ? ['permission', 'reply_worker', 'finish_batch', 'escalate_pm'].includes(tool.name)
          : worker
            ? ![
                'propose_spec',
                'ask_user',
                'permission',
                'accept',
                'appoint_secretary',
                'reply_worker',
                'finish_batch',
                'escalate_pm',
              ].includes(tool.name)
            : !['ask_pm', 'reply_worker', 'finish_batch', 'escalate_pm'].includes(tool.name),
      ).map((tool) =>
        worker === 'secretary' && tool.name === 'permission'
          ? {
              ...tool,
              inputSchema: {
                ...tool.inputSchema,
                required: ['requestId', 'sessionId', 'ts', 'behavior', 'reason'],
              },
            }
          : tool,
      );
      if (body.method === 'tools/list')
        result = {
          tools,
        };
      else if (body.method === 'tools/call') {
        try {
          const tool = tools.find((tool) => tool.name === body.params?.name);
          if (!tool) throw new Error('Tool is not available to this role');
          const input = body.params?.arguments ?? {};
          const missing = tool.inputSchema.required.filter((key) => input[key] === undefined);
          if (missing.length)
            throw new Error(
              tool.name +
                ': missing required fields: ' +
                missing.join(', ') +
                '. Resubmit with all required fields; use tools/list for the schema.',
            );
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
