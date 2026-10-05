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
  PasskeySession,
} from '@harnessboard/shared';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

// Required by the server on every state-changing request (see server/src/api.ts).
const CLIENT_HEADER = 'x-harnessboard-client';

// Carries the board session a passkey check hands out (see server/src/session.ts).
const SESSION_HEADER = 'x-harnessboard-session';

/**
 * A failed API call. `status` 401 comes in three kinds: `locked` (the device needs a passkey
 * check to go on), `reauth` (this action needs a recent passkey check) and not paired.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly locked: boolean;
  readonly reauth: boolean;

  constructor(message: string, status: number, flags: { locked?: boolean; reauth?: boolean } = {}) {
    super(message);
    this.status = status;
    this.locked = flags.locked === true;
    this.reauth = flags.reauth === true;
  }
}

/** True for the 401 a remote device gets until it is paired, or after it was revoked. */
export function isNotPaired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && !err.locked && !err.reauth;
}

/** True for the 401 of a locked device, which the unlock screen handles. */
export function isLocked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.locked;
}

/** True for an action refused because its passkey prompt was cancelled or failed. */
export function isReauthRefused(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.reauth;
}

// Module-level on purpose: a device can be revoked or locked while any panel or dialog is
// open, and each of them reports its own errors as text. Telling the app here, where every
// call passes, means none of them can leave the board on screen after a 401.
const notPairedListeners = new Set<() => void>();
const lockedListeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();

// Page memory only, never storage: opening the board again must start a new, locked session.
let session: string | null = null;
// Counts session changes. A 401 to a call sent before the latest change answered the old
// session, e.g. a board read still in flight while the phone paired or unlocked: it must not
// put the not-paired or locked screen back over the board the new session just opened.
let generation = 0;

/**
 * Asks for a passkey check before a refused action is retried. Resolves false when the user
 * cancelled it or it failed; the action then fails with its own 401.
 */
export type ReauthPrompt = () => Promise<boolean>;
let reauthPrompt: ReauthPrompt | null = null;
// Actions refused together share one prompt instead of asking once each.
let prompting: Promise<boolean> | null = null;

function subscribe(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Calls `listener` whenever any API call gets a 401 that is neither a lock nor a reauth, so
 * the app can swap the board for the "not paired" screen. The call itself still fails as
 * usual. Returns the unsubscribe.
 */
export function onNotPaired(listener: () => void): () => void {
  return subscribe(notPairedListeners, listener);
}

/** Calls `listener` whenever any API call gets 401 `{locked: true}`. Returns the unsubscribe. */
export function onLocked(listener: () => void): () => void {
  return subscribe(lockedListeners, listener);
}

/** Calls `listener` after {@link setSession}, e.g. to reopen the event stream with the new token. */
export function onSessionChange(listener: () => void): () => void {
  return subscribe(sessionListeners, listener);
}

/** Sends `token` with every later call; `null` sends none (a computer needs none). */
export function setSession(token: string | null): void {
  session = token;
  generation += 1;
  for (const listener of sessionListeners) listener();
}

/** Sets what runs when an action gets 401 `{reauth: true}`; `null` retries nothing. */
export function setReauthPrompt(prompt: ReauthPrompt | null): void {
  reauthPrompt = prompt;
}

/**
 * The event stream's address. EventSource cannot send headers, so the session goes in the
 * query, which the server accepts on this path only.
 */
export function eventsUrl(): string {
  return session ? `/api/events?session=${encodeURIComponent(session)}` : '/api/events';
}

function confirmPasskey(): Promise<boolean> {
  if (!reauthPrompt) return Promise.resolve(false);
  prompting ??= reauthPrompt().finally(() => {
    prompting = null;
  });
  return prompting;
}

function errorOf(res: Response, text: string): ApiError {
  let body: { error?: string; locked?: boolean; reauth?: boolean } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // plain-text error body; use it as is
  }
  return new ApiError(body.error ?? (text || res.statusText), res.status, body);
}

/**
 * Calls the API. An action refused for reauth is retried once after a passed passkey prompt,
 * and a call refused under a session that has since changed is retried once with the new one.
 */
async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (session) headers.set(SESSION_HEADER, session);
  const sentIn = generation;
  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  if (res.ok) return JSON.parse(text) as T;
  const err = errorOf(res, text);
  if (err.status === 401 && sentIn !== generation) {
    // A stale 401 answered the old session: ask once again with the new one, and tell no
    // listener about it.
    if (!retried) return request<T>(path, init, true);
  } else if (err.status === 401) {
    if (err.reauth && !retried && (await confirmPasskey())) return request<T>(path, init, true);
    if (err.locked) for (const listener of lockedListeners) listener();
    else if (!err.reauth) for (const listener of notPairedListeners) listener();
  }
  throw err;
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
  passkeyOptions: () => send<PublicKeyCredentialCreationOptionsJSON>('POST', '/passkey/options'),
  registerPasskey: (response: RegistrationResponseJSON) =>
    send<PasskeySession>('POST', '/passkey', response),
  passkeyChallenge: () => send<PublicKeyCredentialRequestOptionsJSON>('POST', '/auth/challenge'),
  verifyPasskey: (response: AuthenticationResponseJSON) =>
    send<PasskeySession>('POST', '/auth/verify', response),
};
