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
  /** Writes the acceptance criteria; `null` lets the implementer do it. */
  spec: string | null;
  specModel: string | null;
  /** Writes a design note before the implementer starts; `null` skips it. */
  design: string | null;
  designModel: string | null;
  /** Tests each finished step before review; `null` skips testing. */
  tester: string | null;
  testerModel: string | null;
  /** Updates the docs after each step, before review; `null` skips it. */
  docs: string | null;
  docsModel: string | null;
}

interface Props {
  agents: AgentInfo[];
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  /** While a session is open only the models can change, not who runs it. */
  lockAgents?: boolean;
}

/** Profile and model for the spec author, the implementer, then the optional reviewer. */
export function AgentFields({ agents, value, onChange, lockAgents = false }: Props) {
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
          <span>{t('form.spec')}</span>
          <select
            value={value.spec ?? ''}
            disabled={lockAgents}
            onChange={(e) => set({ spec: e.target.value || null, specModel: null })}
          >
            <option value="">{t('form.specSame')}</option>
            {options}
          </select>
        </label>
        {value.spec && (
          <ModelPicker
            key={`spec-${value.spec}`}
            label={t('form.specModel')}
            agent={byId(value.spec)}
            value={value.specModel}
            onChange={(specModel) => set({ specModel })}
          />
        )}
      </div>
      <small className="hint">{t('form.specHint')}</small>
      <div className="row">
        <label className="field">
          <span>{t('form.design')}</span>
          <select
            value={value.design ?? ''}
            disabled={lockAgents}
            onChange={(e) => set({ design: e.target.value || null, designModel: null })}
          >
            <option value="">{t('form.designNone')}</option>
            {options}
          </select>
        </label>
        {value.design && (
          <ModelPicker
            key={`design-${value.design}`}
            label={t('form.designModel')}
            agent={byId(value.design)}
            value={value.designModel}
            onChange={(designModel) => set({ designModel })}
          />
        )}
      </div>
      <small className="hint">{t('form.designHint')}</small>
      <div className="row">
        <label className="field">
          <span>{t('form.implementer')}</span>
          {/* A model belongs to a provider, so switching profile resets it. */}
          <select
            value={value.implementer}
            disabled={lockAgents}
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
          <span>{t('form.tester')}</span>
          <select
            value={value.tester ?? ''}
            disabled={lockAgents}
            onChange={(e) => set({ tester: e.target.value || null, testerModel: null })}
          >
            <option value="">{t('form.testerNone')}</option>
            {options}
          </select>
        </label>
        {value.tester && (
          <ModelPicker
            key={`tester-${value.tester}`}
            label={t('form.testerModel')}
            agent={byId(value.tester)}
            value={value.testerModel}
            onChange={(testerModel) => set({ testerModel })}
          />
        )}
      </div>
      <small className="hint">{t('form.testerHint')}</small>
      <div className="row">
        <label className="field">
          <span>{t('form.docs')}</span>
          <select
            value={value.docs ?? ''}
            disabled={lockAgents}
            onChange={(e) => set({ docs: e.target.value || null, docsModel: null })}
          >
            <option value="">{t('form.docsNone')}</option>
            {options}
          </select>
        </label>
        {value.docs && (
          <ModelPicker
            key={`docs-${value.docs}`}
            label={t('form.docsModel')}
            agent={byId(value.docs)}
            value={value.docsModel}
            onChange={(docsModel) => set({ docsModel })}
          />
        )}
      </div>
      <small className="hint">{t('form.docsHint')}</small>
      <div className="row">
        <label className="field">
          <span>{t('form.reviewer')}</span>
          <select
            value={value.reviewer ?? ''}
            disabled={lockAgents}
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
