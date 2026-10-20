// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isModelId } from '@harnessboard/shared';
import type { AgentInfo, PmConfig } from '@harnessboard/shared';
import { ModelPicker } from './ModelPicker';

interface Props {
  agents: AgentInfo[];
  value: PmConfig;
  onChange: (value: PmConfig) => void;
}

/** PM model and the explicit worker model pool, without fixed role assignments. */
export function PmFields({ agents, value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <label className="field">
        <span>{t('pm.profile')}</span>
        <select
          value={value.agentId}
          onChange={(e) =>
            onChange({ ...value, agentId: e.target.value, model: null, effort: null })
          }
        >
          {agents
            .filter((a) => a.profile.provider !== 'gemini' && a.profile.sandbox !== 'docker')
            .map((a) => (
              <option key={a.id} value={a.id} disabled={!a.ok}>
                {a.id} · {a.profile.provider}
              </option>
            ))}
        </select>
      </label>
      <ModelPicker
        agent={agents.find((a) => a.id === value.agentId)}
        value={value.model}
        effort={value.effort}
        onChange={(model, effort) => onChange({ ...value, model, effort })}
        label={t('pm.model')}
      />
      <fieldset>
        <legend>{t('pm.workers')}</legend>
        <p className="hint">{t('pm.workerHint')}</p>
        {agents.map((agent) => {
          const chosen = value.workers.find((w) => w.agentId === agent.id);
          return (
            <div key={agent.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!chosen}
                  disabled={!agent.ok}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      workers: e.target.checked
                        ? [...value.workers, { agentId: agent.id, models: [null] }]
                        : value.workers.filter((w) => w.agentId !== agent.id),
                    })
                  }
                />
                {agent.id} · {agent.profile.provider}
              </label>
              {chosen && (
                <WorkerModels
                  agent={agent}
                  models={chosen.models}
                  onChange={(models) =>
                    onChange({
                      ...value,
                      workers: value.workers.map((w) =>
                        w.agentId === agent.id ? { ...w, models } : w,
                      ),
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </fieldset>
    </>
  );
}

/** Select models from the platform catalog before adding them to the allowed pool. */
function WorkerModels({
  agent,
  models,
  onChange,
}: {
  agent: AgentInfo;
  models: (string | null)[];
  onChange: (models: (string | null)[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div>
      <ul>
        {models.map((model) => (
          <li key={model ?? '__default'}>
            {model ?? t('pm.profileDefault')}{' '}
            <button
              type="button"
              onClick={() => onChange(models.filter((m) => m !== model))}
              disabled={models.length === 1}
              aria-label={t('pm.removeWorkerModel', { model: model ?? t('pm.profileDefault') })}
            >
              {t('pm.removeModel')}
            </button>
          </li>
        ))}
      </ul>
      <ModelPicker
        agent={agent}
        value={selected}
        effort={null}
        onChange={(model) => setSelected(model)}
        label={t('pm.workerModels')}
        hideEffort
      />
      <button
        type="button"
        disabled={models.includes(selected) || (selected !== null && !isModelId(selected))}
        onClick={() => onChange([...models, selected])}
      >
        {t('pm.addModel')}
      </button>
    </div>
  );
}
