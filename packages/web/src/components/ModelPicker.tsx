// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEL_SUGGESTIONS, isModelId } from '@harnessboard/shared';
import type { AgentInfo } from '@harnessboard/shared';

interface Props {
  /** The profile the model is for; its provider decides the suggestions. */
  agent: AgentInfo | undefined;
  /** `null` uses the profile's own model. */
  value: string | null;
  onChange: (model: string | null) => void;
  label: string;
}

const CUSTOM = '__custom';

/** The profile's model, one of the provider's suggestions, or any id typed by hand. */
export function ModelPicker({ agent, value, onChange, label }: Props) {
  const { t } = useTranslation();
  const suggestions = agent ? MODEL_SUGGESTIONS[agent.profile.provider] : [];
  const [custom, setCustom] = useState(value !== null && !suggestions.includes(value));
  const profileModel = agent?.profile.model ?? t('settingsForm.defaultModel');
  const invalid = custom && value !== null && !isModelId(value);

  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={custom ? CUSTOM : (value ?? '')}
        onChange={(e) => {
          const next = e.target.value;
          setCustom(next === CUSTOM);
          if (next !== CUSTOM) onChange(next === '' ? null : next);
        }}
      >
        <option value="">{t('models.profile', { model: profileModel })}</option>
        {suggestions.map((model) => (
          <option key={model} value={model}>
            {t(`models.names.${model}`, { defaultValue: model })}
          </option>
        ))}
        <option value={CUSTOM}>{t('models.custom')}</option>
      </select>
      {custom && (
        <input
          className="mono"
          value={value ?? ''}
          placeholder="claude-opus-5-5"
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value.trim() || null)}
        />
      )}
      {invalid && <small className="hint warn-text">{t('models.invalid')}</small>}
    </label>
  );
}
