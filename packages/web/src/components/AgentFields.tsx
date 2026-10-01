// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { AgentInfo } from '@harnessboard/shared';
import { ModelPicker } from './ModelPicker';

/** Who works on a task and with which model; `reviewer` is `null` for no review. */
export interface AgentChoice {
  implementer: string;
  implementerModel: string | null;
  reviewer: string | null;
  reviewerModel: string | null;
}

interface Props {
  agents: AgentInfo[];
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
}

/** Profile and model for the implementer, then for the optional reviewer. */
export function AgentFields({ agents, value, onChange }: Props) {
  const { t } = useTranslation();
  const set = (patch: Partial<AgentChoice>) => onChange({ ...value, ...patch });
  const byId = (id: string | null) => agents.find((a) => a.id === id);
  const options = agents.map((a) => (
    <option key={a.id} value={a.id} disabled={!a.ok}>
      {a.id} · {a.profile.provider}
      {a.ok ? '' : ` ${t('form.agentMissing')}`}
    </option>
  ));

  return (
    <>
      <div className="row">
        <label className="field">
          <span>{t('form.implementer')}</span>
          {/* A model belongs to a provider, so switching profile resets it. */}
          <select
            value={value.implementer}
            onChange={(e) => set({ implementer: e.target.value, implementerModel: null })}
          >
            {options}
          </select>
        </label>
        <ModelPicker
          key={`impl-${value.implementer}`}
          label={t('form.implementerModel')}
          agent={byId(value.implementer)}
          value={value.implementerModel}
          onChange={(implementerModel) => set({ implementerModel })}
        />
      </div>
      <div className="row">
        <label className="field">
          <span>{t('form.reviewer')}</span>
          <select
            value={value.reviewer ?? ''}
            onChange={(e) => set({ reviewer: e.target.value || null, reviewerModel: null })}
          >
            <option value="">{t('form.reviewerNone')}</option>
            {options}
          </select>
        </label>
        {value.reviewer && (
          <ModelPicker
            key={`rev-${value.reviewer}`}
            label={t('form.reviewerModel')}
            agent={byId(value.reviewer)}
            value={value.reviewerModel}
            onChange={(reviewerModel) => set({ reviewerModel })}
          />
        )}
      </div>
      <small className="hint">{t('form.reviewerHint')}</small>
    </>
  );
}
