// SPDX-License-Identifier: Apache-2.0
import type {
  Settings,
  MergeResult,
  ChatEntry,
  AgentInfo,
  AgentsUpdate,
  CommitInfo,
  CreateTaskInput,
  DeletedTask,
  PermissionDecision,
  StoredEvent,
  Task,
  TaskDetail,
  TaskView,
  PlanView,
  TimelineEntry,
  WorktreeDiff,
} from '@harnessboard/shared';
import { CLIENT_HEADER } from './api.js';

export class ServerUnavailableError extends Error {}

/** Thin HTTP client used by the CLI; the server owns all state. */
export class ApiClient {
  constructor(private readonly base: string) {}

  status = () => this.get<Record<string, unknown>>('/status');
  agents = () => this.get<AgentInfo[]>('/agents');
  timeline = (id: number) => this.get<TimelineEntry[]>(`/tasks/${id}/timeline`);
  plan = (id: number) => this.get<PlanView>(`/tasks/${id}/plan`);
  planFeedback = (id: number, message: string) =>
    this.post<Task>(`/tasks/${id}/plan/feedback`, { message });
  approvePlan = (id: number, verifyCommand?: string) =>
    this.post<Task>(`/tasks/${id}/plan/approve`, verifyCommand ? { verifyCommand } : {});
  approveCriteria = (id: number, criteria?: string) =>
    this.post<Task>(`/tasks/${id}/criteria/approve`, criteria ? { criteria } : {});
  listTasks = () => this.get<TaskView[]>('/tasks');
  getTask = (id: number) => this.get<TaskDetail>(`/tasks/${id}`);
  createTask = (input: CreateTaskInput) => this.post<TaskView>('/tasks', input);
  queueTask = (id: number) => this.post<Task>(`/tasks/${id}/queue`);
  stopTask = (id: number) => this.post<Task>(`/tasks/${id}/stop`);
  completeTask = (id: number) => this.post<Task>(`/tasks/${id}/complete`);
  setAutoApprove = (id: number, on: boolean) =>
    this.send<Task>('PUT', `/tasks/${id}/auto-approve`, { on });
  settings = () => this.get<Settings>('/settings');
  saveSettings = (patch: Partial<Settings>) => this.send<Settings>('PUT', '/settings', patch);
  mergeTask = (id: number) => this.post<MergeResult>(`/tasks/${id}/merge`);
  answerPermission = (id: number, decision: PermissionDecision) =>
    this.post<Task>(`/tasks/${id}/permission`, decision);
  setAgents = (id: number, update: AgentsUpdate) =>
    this.send<Task>('PUT', `/tasks/${id}/agents`, update);
  setAllowedTools = (id: number, rules: string[]) =>
    this.send<Task>('PUT', `/tasks/${id}/allowed-tools`, { rules });
  deleteTask = (id: number) => this.send<DeletedTask>('DELETE', `/tasks/${id}`);
  events = (id: number, after = 0) => this.get<StoredEvent[]>(`/tasks/${id}/events?after=${after}`);
  chat = (id: number) => this.get<ChatEntry[]>(`/tasks/${id}/chat`);
  sendChat = (id: number, message: string) => this.post<Task>(`/tasks/${id}/chat`, { message });
  cancelChat = (id: number) => this.send<Task>('DELETE', `/tasks/${id}/chat/pending`);
  commits = (id: number) => this.get<CommitInfo[]>(`/tasks/${id}/commits`);
  diff = (id: number) => this.get<WorktreeDiff>(`/tasks/${id}/diff`);

  private async get<T>(path: string): Promise<T> {
    return (await this.request(path)).json() as Promise<T>;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method,
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
