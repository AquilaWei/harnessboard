// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isModelId } from '@harnessboard/shared';
import type { AgentInfo, EffortInfo, ModelInfo } from '@harnessboard/shared';
import { api } from '../api';

interface Props {
  /** The profile the model is for; its CLI decides which models are offered. */
  agent: AgentInfo | undefined;
  /** `null` uses the profile's own model. */
  value: string | null;
  /** `null` leaves the effort to the CLI. */
  effort: string | null;
  /** Called with both, since a model that does not offer the chosen effort resets it. */
  onChange: (model: string | null, effort: string | null) => void;
  label: string;
}

const CUSTOM = '__custom';

/** `Opus 5.5 — For complex work and everyday tasks (Requires usage credits)` */
function optionLabel(model: ModelInfo): string {
  const description = model.description ? ` — ${model.description}` : '';
  const note = model.note ? ` (${model.note})` : '';
  return `${model.name}${description}${note}`;
}

/** `Max`; Codex names its efforts by their lowercase id, so the first letter is raised. */
export function effortName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `Max (3.5× or more usage)` */
function effortLabel(effort: EffortInfo): string {
  const note = effort.note ? ` (${effort.note})` : '';
  return `${effortName(effort.name)}${note}`;
}

/**
 * The profile's model, one of the models its platform offers, or any id typed by hand; and
 * next to it the reasoning efforts the chosen model offers, when it offers any.
 */
export function ModelPicker({ agent, value, effort, onChange, label }: Props) {
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
  /** The model a choice runs: the profile's own one for the default, unknown when typed. */
  const effective = (id: string | null) =>
    models?.find((m) => m.id === (id ?? agent?.profile.model));
  const efforts = custom ? [] : (effective(value)?.efforts ?? []);
  const defaultEffort = custom ? null : (effective(value)?.defaultEffort ?? null);
  const defaultName = efforts.find((e) => e.id === defaultEffort)?.name ?? defaultEffort;

  /** Keeps the effort only when the newly chosen model offers it too. */
  const chooseModel = (next: string | null, typed: boolean) => {
    const offered = typed ? [] : (effective(next)?.efforts ?? []);
    onChange(next, offered.some((e) => e.id === effort) ? effort : null);
  };

  return (
    <>
      <label className="field">
        <span>{label}</span>
        <select
          value={custom ? CUSTOM : (value ?? '')}
          onChange={(e) => {
            const next = e.target.value;
            setCustomChosen(next === CUSTOM);
            // The typed id starts as the current one; its efforts are unknown either way.
            if (next === CUSTOM) chooseModel(value, true);
            else chooseModel(next === '' ? null : next, false);
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
            onChange={(e) => chooseModel(e.target.value.trim() || null, true)}
          />
        )}
        {invalid && <small className="hint warn-text">{t('models.invalid')}</small>}
        {selected && !custom && <small className="hint mono">{selected.id}</small>}
      </label>
      {efforts.length > 0 && (
        <label className="field">
          <span>{t('models.effort')}</span>
          <select value={effort ?? ''} onChange={(e) => onChange(value, e.target.value || null)}>
            <option value="">
              {defaultName
                ? t('models.effortDefaultKnown', { effort: effortName(defaultName) })
                : t('models.effortDefault')}
            </option>
            {efforts.map((option) => (
              <option key={option.id} value={option.id} title={option.description ?? undefined}>
                {effortLabel(option)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
