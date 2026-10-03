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

/** A task's agents and models; while a session is open only the models can change. */
export function TaskAgentsEditor({ task, onSaved, onError }: Props) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const a = task.agents;
  // An answered tool use waiting for quota is queued with its agent still open.
  const live =
    task.activity !== null || task.status === 'running' || task.status === 'awaiting_permission';
  const model = (m?: string | null) => m ?? t('models.profileShort');

  const edit = () => {
    setChoice({
      implementer: a.implementer,
      implementerModel: a.implementerModel ?? null,
      reviewer: a.reviewer,
      reviewerModel: a.reviewerModel ?? null,
      spec: a.spec ?? null,
      specModel: a.specModel ?? null,
      design: a.design ?? null,
      designModel: a.designModel ?? null,
      tester: a.tester ?? null,
      testerModel: a.testerModel ?? null,
      docs: a.docs ?? null,
      docsModel: a.docsModel ?? null,
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
          {t('fields.spec')}: {a.spec ? `${a.spec} · ${model(a.specModel)}` : t('form.specSame')}
        </span>
        <span className="mono">
          {t('fields.design')}:{' '}
          {a.design ? `${a.design} · ${model(a.designModel)}` : t('fields.none')}
        </span>
        <span className="mono">
          {a.implementer} · {model(a.implementerModel)}
        </span>
        <span className="mono">
          {t('fields.tester')}:{' '}
          {a.tester ? `${a.tester} · ${model(a.testerModel)}` : t('fields.none')}
        </span>
        <span className="mono">
          {t('fields.docs')}: {a.docs ? `${a.docs} · ${model(a.docsModel)}` : t('fields.none')}
        </span>
        <span className="mono">
          {a.reviewer
            ? `${t('fields.reviewer')}: ${a.reviewer} · ${model(a.reviewerModel)}`
            : `${t('fields.reviewer')}: ${t('fields.none')}`}
        </span>
        <button type="button" className="btn small" onClick={edit}>
          {t('rules.edit')}
        </button>
      </div>
    );
  }
  return (
    <div className="agents-editor">
      {agents ? (
        <>
          <AgentFields agents={agents} value={choice} onChange={setChoice} lockAgents={live} />
          {live && <small className="hint">{t('models.liveHint')}</small>}
        </>
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
