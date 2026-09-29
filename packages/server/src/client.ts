// SPDX-License-Identifier: Apache-2.0
import type { CreateTaskInput, StoredEvent, WorktreeDiff } from '@harnessboard/core';
import type { Session, Task } from '@harnessboard/shared';
import { CLIENT_HEADER } from './api.js';
import type { TaskView } from './views.js';

export class ServerUnavailableError extends Error {}

/** Thin HTTP client used by the CLI; the server owns all state. */
export class ApiClient {
  constructor(private readonly base: string) {}

  status = () => this.get<Record<string, unknown>>('/status');
  listTasks = () => this.get<TaskView[]>('/tasks');
  getTask = (id: number) => this.get<TaskView & { sessions: Session[] }>(`/tasks/${id}`);
  createTask = (input: CreateTaskInput) => this.post<TaskView>('/tasks', input);
  queueTask = (id: number) => this.post<Task>(`/tasks/${id}/queue`);
  stopTask = (id: number) => this.post<Task>(`/tasks/${id}/stop`);
  completeTask = (id: number) => this.post<Task>(`/tasks/${id}/complete`);
  events = (id: number, after = 0) => this.get<StoredEvent[]>(`/tasks/${id}/events?after=${after}`);
  diff = (id: number) => this.get<WorktreeDiff>(`/tasks/${id}/diff`);

  private async get<T>(path: string): Promise<T> {
    return (await this.request(path)).json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'cli' },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }

  /** Throws {@link ServerUnavailableError} when nothing listens, or the API's error text. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api${path}`, init);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ServerUnavailableError(this.base);
    }
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // plain-text error body; use it as is
      }
      throw new Error(message);
    }
    return res;
  }
}
