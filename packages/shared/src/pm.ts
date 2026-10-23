// SPDX-License-Identifier: Apache-2.0
import type { TaskUsage } from './usage.js';
/** PM configuration persists independently of the legacy role assignments. */
export interface PmConfig {
  agentId: string;
  model: string | null;
  effort: string | null;
  workers: PmWorkerProfile[];
}

export interface PmWorkerProfile {
  agentId: string;
  /** null permits the profile default; additional models must be explicitly listed. */
  models: (string | null)[];
}

/** PM-appointed coordinator; every batch uses a fresh conversation. */
export interface PmSecretary {
  id: string;
  parentSessionId: string;
  agentId: string;
  model: string | null;
  effort: string | null;
  status: 'waiting' | 'running' | 'failed';
  sessionIds: string[];
  summary: string | null;
  updatedAt: number;
  usage?: TaskUsage;
  provider?: string;
}

export type WorkStatus =
  | 'queued'
  | 'running'
  | 'awaiting_permission'
  | 'awaiting_children'
  | 'awaiting_pm'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'cancelled';

/** Latest durable snapshot of a delegated job; transcripts stay in session events. */
export interface PmWork {
  usage?: TaskUsage;
  /** Missing on historical snapshots: the PM is the parent. */
  parentWorkId?: string | null;
  sessionIds?: string[];
  provider?: string;
  reportedModel?: string | null;
  activity?: string | null;
  updatedAt?: number;
  observedHead?: string | null;
  id: string;
  parentSessionId: string;
  sessionId: string | null;
  agentId: string;
  model: string | null;
  effort: string | null;
  goal: string;
  acceptance: string;
  scope: string;
  access: 'edit' | 'readOnly';
  status: WorkStatus;
  summary: string | null;
  evidence: string | null;
  since: string | null;
  head: string | null;
  execution: 'managed';
}

export interface PmQuestion {
  message: string;
  kind: 'question' | 'spec';
}

/** PM inspection is tied to a concrete HEAD and to all completed child work. */
export interface PmAcceptance {
  head: string;
  architecture: string;
  functionality: string;
  verification: string;
  summary: string;
}
