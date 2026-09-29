// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContextPolicy,
  PermissionPolicy,
  Session,
  SessionEndReason,
  Task,
  TaskStatus,
} from '@harnessboard/shared';

export interface NewTask {
  title: string;
  prompt: string;
  repoPath: string;
  baseRef: string;
  contextPolicy: ContextPolicy;
  permission: PermissionPolicy;
}

export interface StoredEvent {
  id: number;
  taskId: number;
  sessionId: string | null;
  ts: number;
  kind: string;
  data: unknown;
}

// Each entry upgrades the schema by one version; never edit a shipped entry.
const MIGRATIONS = [
  `CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     repo_path TEXT NOT NULL,
     base_ref TEXT NOT NULL,
     branch TEXT,
     worktree_path TEXT,
     status TEXT NOT NULL,
     context_policy TEXT NOT NULL,
     permission TEXT NOT NULL,
     resume_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id),
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     end_reason TEXT,
     context_tokens INTEGER NOT NULL DEFAULT 0,
     context_window INTEGER
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     task_id INTEGER NOT NULL REFERENCES tasks(id),
     session_id TEXT,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX events_task ON events(task_id, id);`,
];

/**
 * SQLite persistence for tasks, sessions and the event log.
 * Uses the built-in `node:sqlite`, so there is no native module to compile per platform.
 * Calls are synchronous; each is a single small statement.
 */
export class Store {
  private readonly db: DatabaseSync;

  /** Opens (creating if needed) the database; `:memory:` is accepted for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createTask(input: NewTask, now = Date.now()): Task {
    const result = this.db
      .prepare(
        `INSERT INTO tasks (title, prompt, repo_path, base_ref, status, context_policy,
                            permission, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?)`,
      )
      .run(
        input.title,
        input.prompt,
        input.repoPath,
        input.baseRef,
        JSON.stringify(input.contextPolicy),
        JSON.stringify(input.permission),
        now,
        now,
      );
    return this.getTask(Number(result.lastInsertRowid))!;
  }

  getTask(id: number): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? toTask(row) : undefined;
  }

  listTasks(): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY id').all().map(toTask);
  }

  updateTask(
    id: number,
    fields: Partial<Pick<Task, 'status' | 'branch' | 'worktreePath' | 'resumeAt'>>,
    now = Date.now(),
  ): Task {
    const columns: Record<string, string> = {
      status: 'status',
      branch: 'branch',
      worktreePath: 'worktree_path',
      resumeAt: 'resume_at',
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    const sets = entries.map(([k]) => `${columns[k]} = ?`);
    this.db
      .prepare(`UPDATE tasks SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), now, id);
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  startSession(id: string, taskId: number, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)')
      .run(id, taskId, now);
  }

  updateSessionContext(id: string, tokens: number, window: number | null): void {
    this.db
      .prepare(
        'UPDATE sessions SET context_tokens = ?, context_window = COALESCE(?, context_window) WHERE id = ?',
      )
      .run(tokens, window, id);
  }

  endSession(id: string, reason: SessionEndReason, now = Date.now()): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
      .run(now, reason, id);
  }

  listSessions(taskId: number): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at, rowid')
      .all(taskId)
      .map(toSession);
  }

  appendEvent(
    taskId: number,
    sessionId: string | null,
    kind: string,
    data: unknown,
    now = Date.now(),
  ): number {
    const result = this.db
      .prepare('INSERT INTO events (task_id, session_id, ts, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, sessionId, now, kind, JSON.stringify(data));
    return Number(result.lastInsertRowid);
  }

  /** Events of a task with id greater than `afterId`, oldest first. */
  listEvents(taskId: number, afterId = 0, limit = 1000): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(taskId, afterId, limit)
      .map(toEvent);
  }

  /** Most recent event of one kind for a task, e.g. the latest handoff note. */
  lastEvent(taskId: number, kind: string): StoredEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(taskId, kind);
    return row ? toEvent(row) : undefined;
  }

  /** Most recent event of one kind across all tasks, e.g. the last quota snapshot. */
  lastEventOfKind(kind: string): StoredEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind);
    return row ? toEvent(row) : undefined;
  }

  /** Context window most recently reported by the agent, if any session got that far. */
  lastKnownContextWindow(): number | null {
    const row = this.db
      .prepare(
        'SELECT context_window FROM sessions WHERE context_window IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get();
    return row ? Number(row.context_window) : null;
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

type Row = Record<string, unknown>;

function toTask(row: Row): Task {
  return {
    id: Number(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    repoPath: String(row.repo_path),
    baseRef: String(row.base_ref),
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    status: row.status as TaskStatus,
    contextPolicy: JSON.parse(String(row.context_policy)) as ContextPolicy,
    permission: JSON.parse(String(row.permission)) as PermissionPolicy,
    resumeAt: row.resume_at == null ? null : Number(row.resume_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSession(row: Row): Session {
  return {
    id: String(row.id),
    taskId: Number(row.task_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    endReason: (row.end_reason as SessionEndReason | null) ?? null,
    contextTokens: Number(row.context_tokens),
    contextWindow: row.context_window == null ? null : Number(row.context_window),
  };
}

function toEvent(row: Row): StoredEvent {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    sessionId: row.session_id as string | null,
    ts: Number(row.ts),
    kind: String(row.kind),
    data: JSON.parse(String(row.data)) as unknown,
  };
}
