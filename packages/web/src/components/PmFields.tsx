// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const [modelText, setModelText] = useState<Record<string, string>>({});
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
                <label className="field">
                  <span>{t('pm.workerModels')}</span>
                  <input
                    value={
                      modelText[agent.id] ?? chosen.models.filter((m) => m !== null).join(', ')
                    }
                    placeholder={t('pm.profileDefault')}
                    onInput={(e) => {
                      const raw = e.currentTarget.value;
                      setModelText((current) => ({ ...current, [agent.id]: raw }));
                    }}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        workers: value.workers.map((w) =>
                          w.agentId === agent.id
                            ? {
                                ...w,
                                models: [
                                  null,
                                  ...e.target.value
                                    .split(',')
                                    .map((m) => m.trim())
                                    .filter(Boolean),
                                ],
                              }
                            : w,
                        ),
                      })
                    }
                  />
                </label>
              )}
            </div>
          );
        })}
      </fieldset>
    </>
  );
}
