// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_PM_WORKERS, MAX_PM_WORKERS, isEffortId, isModelId } from '@harnessboard/shared';
import type { AgentInfo, ModelInfo, PmConfig } from '@harnessboard/shared';

export const LAST_PM_CONFIG_KEY = 'harnessboard.lastPmConfig';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
type Catalogs = Record<string, ModelInfo[]>;

/** Fresh defaults keep callers from sharing mutable worker arrays. */
export function defaultPmConfig(): PmConfig {
  return {
    agentId: 'claude',
    model: null,
    effort: null,
    workers: [{ agentId: 'claude', models: [null] }],
    dispatchPolicy: {
      strategy: 'costFirst',
      maxWorkers: DEFAULT_PM_WORKERS,
      maxExtraTokenRatio: 0.2,
    },
  };
}

/** Treat storage as untrusted input and remove choices no longer offered by available profiles. */
export function sanitizePmConfig(
  value: unknown,
  agents: AgentInfo[],
  catalogs: Catalogs,
): PmConfig {
  const defaults = defaultPmConfig();
  if (!value || typeof value !== 'object') return defaults;
  const stored = value as Partial<PmConfig>;
  const agent = agents.find(
    (a) =>
      a.id === stored.agentId &&
      a.ok &&
      a.profile.provider !== 'gemini' &&
      a.profile.sandbox !== 'docker',
  );
  if (!agent) return defaults;
  const known = (id: string, model: unknown): model is string | null =>
    model === null ||
    (typeof model === 'string' && isModelId(model) && !!catalogs[id]?.some((m) => m.id === model));
  const model = known(agent.id, stored.model) ? stored.model : null;
  const workers = Array.isArray(stored.workers)
    ? stored.workers.flatMap((worker) => {
        if (!worker || !agents.some((a) => a.id === worker.agentId && a.ok)) return [];
        const models = Array.isArray(worker.models)
          ? [...new Set(worker.models.filter((m) => known(worker.agentId, m)))]
          : [];
        return [{ agentId: worker.agentId, models: models.length ? models : [null] }];
      })
    : [];
  const policy = stored.dispatchPolicy;
  return {
    agentId: agent.id,
    model,
    effort:
      model === stored.model && typeof stored.effort === 'string' && isEffortId(stored.effort)
        ? stored.effort
        : null,
    workers: workers.length ? workers : [{ agentId: agent.id, models: [null] }],
    dispatchPolicy: {
      strategy: 'costFirst',
      maxWorkers: Number.isFinite(policy?.maxWorkers)
        ? Math.min(MAX_PM_WORKERS, Math.max(1, Math.trunc(policy!.maxWorkers)))
        : DEFAULT_PM_WORKERS,
      maxExtraTokenRatio: Number.isFinite(policy?.maxExtraTokenRatio)
        ? Math.max(0, policy!.maxExtraTokenRatio)
        : 0.2,
    },
  };
}

/** Optional browser storage failures must not prevent task creation. */
export function saveLastPmConfig(storage: Storage, config: PmConfig): void {
  try {
    storage.setItem(LAST_PM_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* Preferences are optional when storage is unavailable. */
  }
}

/** Missing, corrupt or inaccessible preferences use the current defaults. */
export function loadLastPmConfig(
  storage: Storage,
  agents: AgentInfo[],
  catalogs: Catalogs,
): PmConfig {
  try {
    return sanitizePmConfig(
      JSON.parse(storage.getItem(LAST_PM_CONFIG_KEY) ?? 'null'),
      agents,
      catalogs,
    );
  } catch {
    return defaultPmConfig();
  }
}
