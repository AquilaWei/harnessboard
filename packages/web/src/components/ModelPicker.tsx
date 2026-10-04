// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isModelId } from '@harnessboard/shared';
import type { AgentInfo, ModelInfo } from '@harnessboard/shared';
import { api } from '../api';

interface Props {
  /** The profile the model is for; its CLI decides which models are offered. */
  agent: AgentInfo | undefined;
  /** `null` uses the profile's own model. */
  value: string | null;
  onChange: (model: string | null) => void;
  label: string;
}

const CUSTOM = '__custom';

/** `Opus 5.5 — For complex work and everyday tasks (Requires usage credits)` */
function optionLabel(model: ModelInfo): string {
  const description = model.description ? ` — ${model.description}` : '';
  const note = model.note ? ` (${model.note})` : '';
  return `${model.name}${description}${note}`;
}

/** The profile's model, one of the models its platform offers, or any id typed by hand. */
export function ModelPicker({ agent, value, onChange, label }: Props) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [customChosen, setCustomChosen] = useState(false);
  const agentId = agent?.id;

  useEffect(() => {
    if (!agentId) return;
    let current = true;
    // A model list that can not be loaded leaves typing an id, which always works.
    api.agentModels(agentId).then(
      (list) => current && setModels(list),
      () => current && setModels([]),
    );
    return () => {
      current = false;
    };
  }, [agentId]);

  const known = models?.some((m) => m.id === value) ?? false;
  // A stored model the list does not offer is shown as typed, once the list is in.
  const custom = customChosen || (value !== null && models !== null && !known);
  const profileModel = agent?.profile.model ?? t('settingsForm.defaultModel');
  const invalid = custom && value !== null && !isModelId(value);
  const main = (models ?? []).filter((m) => !m.more);
  const more = (models ?? []).filter((m) => m.more);
  const selected = models?.find((m) => m.id === value);

  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={custom ? CUSTOM : (value ?? '')}
        onChange={(e) => {
          const next = e.target.value;
          setCustomChosen(next === CUSTOM);
          if (next !== CUSTOM) onChange(next === '' ? null : next);
        }}
      >
        <option value="">{t('models.profile', { model: profileModel })}</option>
        {/* Keeps the stored choice selectable while the list loads. */}
        {models === null && value !== null && <option value={value}>{value}</option>}
        {main.map((model) => (
          <option key={model.id} value={model.id}>
            {optionLabel(model)}
          </option>
        ))}
        {more.length > 0 && (
          <optgroup label={t('models.more')}>
            {more.map((model) => (
              <option key={model.id} value={model.id}>
                {optionLabel(model)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={CUSTOM}>{t('models.custom')}</option>
      </select>
      {custom && (
        <input
          className="mono"
          value={value ?? ''}
          placeholder={main[0]?.id ?? 'model-id'}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value.trim() || null)}
        />
      )}
      {invalid && <small className="hint warn-text">{t('models.invalid')}</small>}
      {selected && !custom && <small className="hint mono">{selected.id}</small>}
    </label>
  );
}
