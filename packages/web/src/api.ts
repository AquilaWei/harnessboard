// SPDX-License-Identifier: Apache-2.0
import type {
  MergeResult,
  ChatEntry,
  AgentInfo,
  AgentProfile,
  DetectedAgent,
  ModelInfo,
  NewAgentProfile,
  AgentsUpdate,
  CommitInfo,
  CreateTaskInput,
  DeletedTask,
  Device,
  FolderInfo,
  FolderListing,
  PairingCode,
  PairingSetup,
  PairRequest,
  PermissionDecision,
  PlanView,
  HarnessStatus,
  Settings,
  StoredEvent,
  VersionInfo,
  TaskDetail,
  TaskView,
  TaskNotes,
  TimelineEntry,
  WorktreeDiff,
} from '@harnessboard/shared';

// Required by the server on every state-changing request (see server/src/api.ts).
const CLIENT_HEADER = 'x-harnessboard-client';

/** A failed API call; `status` tells a device that is not paired (401) from other errors. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** True for the 401 a remote device gets until it is paired, or after it was revoked. */
export function isNotPaired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

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
    throw new ApiError(message || res.statusText, res.status);
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
  version: () => request<VersionInfo>('/version'),
  tasks: () => request<TaskView[]>('/tasks'),
  task: (id: number) => request<TaskDetail>(`/tasks/${id}`),
  events: (id: number, after: number) =>
    request<StoredEvent[]>(`/tasks/${id}/events?after=${after}`),
  commits: (id: number) => request<CommitInfo[]>(`/tasks/${id}/commits`),
  commit: (id: number, hash: string) =>
    request<{ show: string }>(`/tasks/${id}/commits/${encodeURIComponent(hash)}`),
  diff: (id: number) => request<WorktreeDiff>(`/tasks/${id}/diff`),
  timeline: (id: number) => request<TimelineEntry[]>(`/tasks/${id}/timeline`),
  notes: (id: number) => request<TaskNotes>(`/tasks/${id}/notes`),
  agents: () => request<AgentInfo[]>('/agents'),
  agentModels: (id: string) => request<ModelInfo[]>(`/agents/${encodeURIComponent(id)}/models`),
  detectAgents: () => request<DetectedAgent[]>('/agents/detect'),
  addAgent: (input: NewAgentProfile) => send<AgentProfile>('POST', '/agents', input),
  folders: (path?: string) =>
    request<FolderListing>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  inspectFolder: (path: string) =>
    request<FolderInfo>(`/folders/inspect?path=${encodeURIComponent(path)}`),
  createTask: (input: CreateTaskInput) => send<TaskView>('POST', '/tasks', input),
  queue: (id: number) => send<unknown>('POST', `/tasks/${id}/queue`),
  stop: (id: number) => send<unknown>('POST', `/tasks/${id}/stop`),
  complete: (id: number) => send<unknown>('POST', `/tasks/${id}/complete`),
  answerPermission: (id: number, decision: PermissionDecision) =>
    send<unknown>('POST', `/tasks/${id}/permission`, decision),
  setAgents: (id: number, update: AgentsUpdate) =>
    send<unknown>('PUT', `/tasks/${id}/agents`, update),
  setAllowedTools: (id: number, rules: string[]) =>
    send<unknown>('PUT', `/tasks/${id}/allowed-tools`, { rules }),
  deleteTask: (id: number) => send<DeletedTask>('DELETE', `/tasks/${id}`),
  plan: (id: number) => request<PlanView>(`/tasks/${id}/plan`),
  planFeedback: (id: number, message: string) =>
    send<unknown>('POST', `/tasks/${id}/plan/feedback`, { message }),
  approvePlan: (id: number, verifyCommand: string) =>
    send<unknown>('POST', `/tasks/${id}/plan/approve`, { verifyCommand }),
  approveCriteria: (id: number, criteria: string) =>
    send<unknown>('POST', `/tasks/${id}/criteria/approve`, { criteria }),
  setAutoApprove: (id: number, on: boolean) =>
    send<unknown>('PUT', `/tasks/${id}/auto-approve`, { on }),
  mergeTask: (id: number) => send<MergeResult>('POST', `/tasks/${id}/merge`),
  chat: (id: number) => request<ChatEntry[]>(`/tasks/${id}/chat`),
  sendChat: (id: number, message: string) =>
    send<unknown>('POST', `/tasks/${id}/chat`, { message }),
  cancelChat: (id: number) => send<unknown>('DELETE', `/tasks/${id}/chat/pending`),
  settings: () => request<Settings>('/settings'),
  saveSettings: (patch: Partial<Settings>) => send<Settings>('PUT', '/settings', patch),
  pairingSetup: () => request<PairingSetup>('/pairing/setup'),
  createPairing: () => send<PairingCode>('POST', '/pairing'),
  pair: (input: PairRequest) => send<Device>('POST', '/pair', input),
  devices: () => request<Device[]>('/devices'),
  revokeDevice: (id: number) => send<{ id: number }>('DELETE', `/devices/${id}`),
};
