// SPDX-License-Identifier: Apache-2.0
import type {
  AgentInfo,
  CreateTaskInput,
  HarnessStatus,
  Settings,
  StoredEvent,
  TaskDetail,
  TaskView,
  TimelineEntry,
  WorktreeDiff,
} from '@harnessboard/shared';

// Required by the server on every state-changing request (see server/src/api.ts).
const CLIENT_HEADER = 'x-harnessboard-client';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain-text error body; use it as is
    }
    throw new Error(message || res.statusText);
  }
  return JSON.parse(text) as T;
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'web' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

export const api = {
  status: () => request<HarnessStatus>('/status'),
  tasks: () => request<TaskView[]>('/tasks'),
  task: (id: number) => request<TaskDetail>(`/tasks/${id}`),
  events: (id: number, after: number) =>
    request<StoredEvent[]>(`/tasks/${id}/events?after=${after}`),
  diff: (id: number) => request<WorktreeDiff>(`/tasks/${id}/diff`),
  timeline: (id: number) => request<TimelineEntry[]>(`/tasks/${id}/timeline`),
  agents: () => request<AgentInfo[]>('/agents'),
  createTask: (input: CreateTaskInput) => send<TaskView>('POST', '/tasks', input),
  queue: (id: number) => send<unknown>('POST', `/tasks/${id}/queue`),
  stop: (id: number) => send<unknown>('POST', `/tasks/${id}/stop`),
  complete: (id: number) => send<unknown>('POST', `/tasks/${id}/complete`),
  settings: () => request<Settings>('/settings'),
  saveSettings: (patch: Partial<Settings>) => send<Settings>('PUT', '/settings', patch),
};
