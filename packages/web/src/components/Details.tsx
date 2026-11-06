// SPDX-License-Identifier: Apache-2.0
import { PmDetails } from './PmDetails';
import { useTranslation } from 'react-i18next';
import type { TaskDetail } from '@harnessboard/shared';
import { TaskContextEditor } from './TaskContextEditor';
import { TaskRepositoryEditor } from './TaskRepositoryEditor';
import { ContextMeter } from './Meter';
import { TaskAgentsEditor } from './TaskAgentsEditor';
import { ModelUsage } from './UsageSummary';

interface Props {
  task: TaskDetail;
  onSaved: () => void;
  onError: (message: string) => void;
}

/** Where the task lives and how it is configured; kept out of the way of the status. */
export function Details({ task, onSaved, onError }: Props) {
  const { t } = useTranslation();
  return (
    <>
      {/* The safety limit is a setting of this task, so it is read here rather than in the status. */}
      <p className="hint">{t('safety.monitoringLimit')}</p>
      <ModelUsage usage={task.usage} />
      <details className="agent-settings">
        <summary>
          {t('rules.edit')} · {t('fields.agents')}
        </summary>
        <PmDetails task={task} onSaved={onSaved} onError={onError} showUsage={false} />
        {task.workflow !== 'pm' && (
          <TaskAgentsEditor task={task} onSaved={onSaved} onError={onError} />
        )}
      </details>
      <dl className="facts">
        {task.workflow !== 'pm' && (
          <>
            <dt>{t('fields.mode')}</dt>
            <dd>{t(`form.modes.${task.mode}`)}</dd>
          </>
        )}
        {task.verifyCommand && (
          <>
            <dt>{t('fields.verify')}</dt>
            <dd className="mono">{task.verifyCommand}</dd>
          </>
        )}
        <dt>{t('fields.workspace')}</dt>
        <dd>{t(`fields.workspaces.${task.workspace}`, { base: task.baseRef })}</dd>
        <dt>{t('fields.repo')}</dt>
        <dd className="mono">{task.repoPath}</dd>
        <dt>{t('fields.base')}</dt>
        <dd className="mono">{task.baseRef}</dd>
        <dt>{t('fields.branch')}</dt>
        <dd className="mono">{task.branch ?? '-'}</dd>
        <dt>{t('fields.worktree')}</dt>
        <dd className="mono">{task.worktreePath ?? '-'}</dd>
        <dt>{t('fields.skip')}</dt>
        <dd>{task.permission.skipPermissions ? `⚠ ${t('fields.skipOff')}` : t('fields.skipOn')}</dd>
      </dl>
      <TaskRepositoryEditor task={task} onSaved={onSaved} onError={onError} />
      <TaskContextEditor task={task} onSaved={onSaved} onError={onError} />
      {task.sessionCount > 0 && (
        <section className="detail-section">
          <h3>{t('fields.budget')}</h3>
          <ContextMeter context={task.context} />
        </section>
      )}
    </>
  );
}
