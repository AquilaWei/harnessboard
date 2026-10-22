// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, PmConfig, TaskView } from '@harnessboard/shared';
import { api } from '../api';
import { Markdown } from './Markdown';
import { PmAgentUsage } from './PmAgentUsage';
import { PmFields } from './PmFields';

export function PmDetails({
  task,
  onSaved,
  onError,
}: {
  task: TaskView;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [choice, setChoice] = useState<PmConfig | null>(null);
  const idle =
    ['stopped', 'failed', 'backlog', 'review', 'done'].includes(task.status) && !task.activity;
  const edit = () => {
    setChoice(
      task.pm ?? {
        agentId: task.agents.implementer,
        model: null,
        effort: null,
        workers: [{ agentId: task.agents.implementer, models: [null] }],
      },
    );
    api.agents().then(setAgents, (e: Error) => onError(e.message));
  };
  const save = async () => {
    if (!choice) return;
    try {
      if (task.workflow === 'pm') await api.setPm(task.id, choice);
      else await api.convertToPm(task.id, choice);
      setChoice(null);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  return (
    <section>
      {task.workflow === 'pm' && <PmAgentUsage task={task} />}
      {task.workflow === 'pm' && task.status !== 'review' && task.pmAcceptance && (
        <details>
          <summary>{t('pm.accepted')}</summary>
          <p>
            <code>{task.pmAcceptance.head}</code>
          </p>
          {!task.pmAcceptanceCurrent && <p>{t('pm.reaccept')}</p>}
          <Markdown
            text={[
              task.pmAcceptance.summary,
              task.pmAcceptance.architecture,
              task.pmAcceptance.functionality,
              task.pmAcceptance.verification,
            ].join('\n\n')}
          />
        </details>
      )}
      {idle && !choice && (
        <button className="btn small" onClick={edit}>
          {t(task.workflow === 'pm' ? 'rules.edit' : 'pm.convert')}
        </button>
      )}
      {choice && agents && (
        <>
          <PmFields agents={agents} value={choice} onChange={setChoice} />
          <button className="btn" onClick={() => void save()}>
            {t('rules.save')}
          </button>
          <button className="btn" onClick={() => setChoice(null)}>
            {t('rules.cancel')}
          </button>
        </>
      )}
    </section>
  );
}
