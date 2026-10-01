// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, TaskView } from '@harnessboard/shared';
import { api } from '../api';
import { AgentFields } from './AgentFields';
import type { AgentChoice } from './AgentFields';

interface Props {
  task: TaskView;
  onSaved: () => void;
  onError: (message: string) => void;
}

/** A task's agents and models, editable while no session runs. */
export function TaskAgentsEditor({ task, onSaved, onError }: Props) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const a = task.agents;
  const live = task.status === 'running' || task.status === 'awaiting_permission';
  const model = (m?: string | null) => m ?? t('models.profileShort');

  const edit = () => {
    setChoice({
      implementer: a.implementer,
      implementerModel: a.implementerModel ?? null,
      reviewer: a.reviewer,
      reviewerModel: a.reviewerModel ?? null,
    });
    api.agents().then(setAgents, (e: Error) => onError(e.message));
  };

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await api.setAgents(task.id, choice);
      setChoice(null);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!choice) {
    return (
      <div className="tool-rules">
        <span className="mono">
          {a.implementer} · {model(a.implementerModel)}
        </span>
        <span className="mono">
          {a.reviewer
            ? `${t('fields.reviewer')}: ${a.reviewer} · ${model(a.reviewerModel)}`
            : `${t('fields.reviewer')}: ${t('fields.none')}`}
        </span>
        {!live && (
          <button type="button" className="btn small" onClick={edit}>
            {t('rules.edit')}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="agents-editor">
      {agents ? (
        <AgentFields agents={agents} value={choice} onChange={setChoice} />
      ) : (
        <p className="empty">{t('commits.loading')}</p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !agents}
          onClick={() => void save()}
        >
          {t('rules.save')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setChoice(null)}>
          {t('rules.cancel')}
        </button>
      </div>
    </div>
  );
}
