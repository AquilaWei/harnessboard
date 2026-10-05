// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentRole,
  ContextPolicy,
  Device,
  PermissionPolicy,
  PushSubscriptionInfo,
  Session,
  SessionEndReason,
  StoredEvent,
  Task,
  TaskAgents,
  TaskMode,
  TaskStatus,
} from '@harnessboard/shared';

export interface NewTask {
  title: string;
  prompt: string;
  repoPath: string;
  baseRef: string;
  mode: TaskMode;
  verifyCommand: string | null;
  acceptance: string | null;
  confirmPlan: boolean;
  contextPolicy: ContextPolicy;
  permission: PermissionPolicy;
  agents: TaskAgents;
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
  `ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'single';
   ALTER TABLE tasks ADD COLUMN verify_command TEXT;`,
  `ALTER TABLE tasks ADD COLUMN agents TEXT NOT NULL
     DEFAULT '{"implementer":"claude","reviewer":null,"maxReviewRounds":2}';
   ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'implementer';
   ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'claude';
   ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;
   UPDATE sessions SET agent_session_id = id;`,
  `ALTER TABLE tasks ADD COLUMN confirm_plan INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
  `ALTER TABLE tasks ADD COLUMN acceptance TEXT;`,
  // AUTOINCREMENT so a revoked device's id never names a newer device in a stale list.
  `CREATE TABLE devices (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   );`,
  // The device's passkey, and when it last passed a passkey check or made a request after one.
  `ALTER TABLE devices ADD COLUMN credential_id TEXT;
   ALTER TABLE devices ADD COLUMN public_key BLOB;
   ALTER TABLE devices ADD COLUMN sign_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE devices ADD COLUMN verified_at INTEGER;
   ALTER TABLE devices ADD COLUMN last_active_at INTEGER;`,
  // The device's Web Push subscription as JSON; on the device row so revoking removes it.
  `ALTER TABLE devices ADD COLUMN push_subscription TEXT;`,
];

/** A device's Web Push subscription, with the device it reaches. */
export interface DevicePush {
  deviceId: number;
  subscription: PushSubscriptionInfo;
}

/** A device's registered passkey: what the server needs to check its signatures. */
export interface Passkey {
  /** base64url credential id, as WebAuthn reports it. */
  credentialId: string;
  /** COSE-encoded public key. */
  publicKey: Uint8Array<ArrayBuffer>;
  /** The authenticator's signature counter; many passkeys always report 0. */
  counter: number;
}

/** A paired device with what the access check needs; never sent to the web as is. */
export interface DeviceRecord extends Device {
  /** Null until the device registers a passkey right after pairing. */
  passkey: Passkey | null;
  /** Time of the last passkey check the device passed, or null for none. */
  verifiedAt: number | null;
  /** Time of the device's last activity after a passkey check, or null for none. */
  lastActiveAt: number | null;
}

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
        `INSERT INTO tasks (id, title, prompt, repo_path, base_ref, mode, verify_command,
                            acceptance, confirm_plan, status, context_policy, permission,
                            agents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nextTaskId(),
        input.title,
        input.prompt,
        input.repoPath,
        input.baseRef,
        input.mode,
        input.verifyCommand,
        input.acceptance,
        input.confirmPlan ? 1 : 0,
        JSON.stringify(input.contextPolicy),
        JSON.stringify(input.permission),
        JSON.stringify(input.agents),
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
    fields: Partial<
      Pick<
        Task,
        | 'status'
        | 'branch'
        | 'worktreePath'
        | 'resumeAt'
        | 'verifyCommand'
        | 'acceptance'
        | 'permission'
        | 'agents'
      >
    >,
    now = Date.now(),
  ): Task {
    const columns: Record<string, string> = {
      status: 'status',
      branch: 'branch',
      worktreePath: 'worktree_path',
      resumeAt: 'resume_at',
      verifyCommand: 'verify_command',
      acceptance: 'acceptance',
      permission: 'permission',
      agents: 'agents',
    };
    // Objects are stored as JSON, like on insert.
    const entries = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]): [string, unknown] => [
        k,
        v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
      ]);
    const sets = entries.map(([k]) => `${columns[k]} = ?`);
    this.db
      .prepare(`UPDATE tasks SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), now, id);
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  /** Removes a task with its sessions and events, all or nothing. */
  deleteTask(id: number): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO counters (name, value) VALUES ('deleted_task_id', ?)
           ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)`,
        )
        .run(id);
      this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE task_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  startSession(
    id: string,
    taskId: number,
    role: AgentRole,
    agentId: string,
    agentSessionId: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, role, agent_id, agent_session_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, role, agentId, agentSessionId, now);
  }

  /** Records the id a CLI assigned to a session once it reports it. */
  setAgentSessionId(id: string, agentSessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET agent_session_id = ? WHERE id = ?')
      .run(agentSessionId, id);
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

  /** True when any session of the task recorded an event after event `afterId`. */
  hasSessionEventsAfter(taskId: number, afterId: number): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM events WHERE task_id = ? AND id > ? AND session_id IS NOT NULL LIMIT 1',
      )
      .get(taskId, afterId);
    return row !== undefined;
  }

  /** Most recent event of one kind within a session, e.g. its final result. */
  lastSessionEvent(sessionId: string, kind: string): StoredEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId, kind);
    return row ? toEvent(row) : undefined;
  }

  /** All events of one kind for a task, oldest first. */
  eventsOfKind(taskId: number, kind: string): StoredEvent[] {
    return this.eventsOfKinds(taskId, [kind]);
  }

  /** Every event of the given kinds for a task, in order; `afterId` skips earlier ones. */
  eventsOfKinds(taskId: number, kinds: string[], afterId = 0): StoredEvent[] {
    const marks = kinds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM events WHERE task_id = ? AND id > ? AND kind IN (${marks}) ORDER BY id`,
      )
      .all(taskId, afterId, ...kinds)
      .map(toEvent);
  }

  /**
   * Most recent event of one kind from sessions run by any of `agentIds`, across all tasks;
   * e.g. the last quota snapshot a provider reported.
   */
  lastAgentEvent(kind: string, agentIds: string[]): StoredEvent | undefined {
    if (agentIds.length === 0) return undefined;
    const placeholders = agentIds.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT e.* FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE e.kind = ? AND s.agent_id IN (${placeholders}) ORDER BY e.id DESC LIMIT 1`,
      )
      .get(kind, ...agentIds);
    return row ? toEvent(row) : undefined;
  }

  /** Context window most recently reported for an agent profile, if a session got that far. */
  lastKnownContextWindow(agentId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT context_window FROM sessions WHERE context_window IS NOT NULL AND agent_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(agentId);
    return row ? Number(row.context_window) : null;
  }

  /**
   * Registers a paired device. Only the SHA-256 of `token` is kept, so a copy of the
   * database does not let anyone sign in as the device. Throws if the token is already used.
   */
  addDevice(name: string, token: string, now = Date.now()): Device {
    const result = this.db
      .prepare(
        'INSERT INTO devices (name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, hashToken(token), now, now);
    return toDevice(
      this.db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(result.lastInsertRowid))!,
    );
  }

  /** The device a cookie token belongs to; undefined for an unknown or revoked token. */
  findDeviceByToken(token: string): DeviceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hashToken(token));
    return row ? toDeviceRecord(row) : undefined;
  }

  /**
   * Stores the device's passkey and counts its registration as a passkey check. False when the
   * device is gone or already has a passkey: a stolen cookie must not replace the owner's passkey.
   */
  setDevicePasskey(id: number, passkey: Passkey, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE devices SET credential_id = ?, public_key = ?, sign_count = ?, verified_at = ?,
                            last_active_at = ?
         WHERE id = ? AND credential_id IS NULL`,
      )
      .run(passkey.credentialId, passkey.publicKey, passkey.counter, now, now, id);
    return Number(result.changes) > 0;
  }

  /**
   * Records a passed passkey check and the authenticator's new signature counter. False, with
   * nothing changed, when the counter is not above the stored one, as it can mean a cloned
   * authenticator; a counter that stays at 0 passes, since many passkeys never count. The check
   * is part of the update, so a slower check that finishes after a newer one cannot roll the
   * counter back.
   */
  markDeviceVerified(id: number, counter: number, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE devices SET sign_count = ?, verified_at = ?, last_active_at = ?
         WHERE id = ? AND credential_id IS NOT NULL
           AND (sign_count < ? OR (sign_count = 0 AND ? = 0))`,
      )
      .run(counter, now, now, id, counter, counter);
    return Number(result.changes) > 0;
  }

  listDevices(): Device[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY id').all().map(toDevice);
  }

  /** Deletes the device, so its token stops working at once. False when there was none. */
  revokeDevice(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes) > 0;
  }

  touchDevice(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  /**
   * Records activity of an unlocked device, which keeps it from locking after being idle. The
   * caller decides that the device is unlocked; this does not check it.
   */
  markDeviceActive(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE devices SET last_active_at = ? WHERE id = ?').run(now, id);
  }

  /**
   * Sets the device's push subscription, replacing any earlier one, or clears it with null. A
   * device has one subscription: subscribing again from a new browser on the phone replaces it.
   * False when the device is gone.
   */
  setPushSubscription(id: number, subscription: PushSubscriptionInfo | null): boolean {
    const json = subscription === null ? null : JSON.stringify(subscription);
    const result = this.db
      .prepare('UPDATE devices SET push_subscription = ? WHERE id = ?')
      .run(json, id);
    return Number(result.changes) > 0;
  }

  /** Every paired device's push subscription, oldest device first. */
  listPushSubscriptions(): DevicePush[] {
    return this.db
      .prepare(
        'SELECT id, push_subscription FROM devices WHERE push_subscription IS NOT NULL ORDER BY id',
      )
      .all()
      .map((row) => ({
        deviceId: Number(row.id),
        subscription: JSON.parse(String(row.push_subscription)) as PushSubscriptionInfo,
      }));
  }

  /**
   * Ids are never reused, even after the newest task is deleted: its branch is kept and is
   * named after the id, so a new task with the same id could collide with it.
   */
  private nextTaskId(): number {
    const row = this.db
      .prepare(
        `SELECT max(COALESCE((SELECT max(id) FROM tasks), 0),
                    COALESCE((SELECT value FROM counters WHERE name = 'deleted_task_id'), 0)) AS top`,
      )
      .get() as { top: number };
    return Number(row.top) + 1;
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
    mode: row.mode as TaskMode,
    verifyCommand: (row.verify_command as string | null) ?? null,
    acceptance: (row.acceptance as string | null) ?? null,
    confirmPlan: Number(row.confirm_plan) === 1,
    contextPolicy: JSON.parse(String(row.context_policy)) as ContextPolicy,
    permission: JSON.parse(String(row.permission)) as PermissionPolicy,
    agents: JSON.parse(String(row.agents)) as TaskAgents,
    resumeAt: row.resume_at == null ? null : Number(row.resume_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSession(row: Row): Session {
  return {
    id: String(row.id),
    taskId: Number(row.task_id),
    role: row.role as AgentRole,
    agentId: String(row.agent_id),
    agentSessionId: (row.agent_session_id as string | null) ?? null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    endReason: (row.end_reason as SessionEndReason | null) ?? null,
    contextTokens: Number(row.context_tokens),
    contextWindow: row.context_window == null ? null : Number(row.context_window),
  };
}

function toDevice(row: Row): Device {
  return {
    id: Number(row.id),
    name: String(row.name),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function toDeviceRecord(row: Row): DeviceRecord {
  return {
    ...toDevice(row),
    passkey:
      row.credential_id == null
        ? null
        : {
            credentialId: String(row.credential_id),
            publicKey: new Uint8Array(row.public_key as Uint8Array),
            counter: Number(row.sign_count),
          },
    verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
    lastActiveAt: row.last_active_at == null ? null : Number(row.last_active_at),
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
