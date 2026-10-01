// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TaskDetail } from '@harnessboard/shared';
import { ContextMeter } from './Meter';
import { TaskAgentsEditor } from './TaskAgentsEditor';
import { ToolRules } from './ToolRules';
import { UsageSummary } from './UsageSummary';

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
      {task.sessionCount > 0 && <UsageSummary usage={task.usage} />}
      <dl className="facts">
        <dt>{t('fields.mode')}</dt>
        <dd>{t(`form.modes.${task.mode}`)}</dd>
        <dt>{t('fields.agents')}</dt>
        <dd>
          <TaskAgentsEditor task={task} onSaved={onSaved} onError={onError} />
        </dd>
        {task.verifyCommand && (
          <>
            <dt>{t('fields.verify')}</dt>
            <dd className="mono">{task.verifyCommand}</dd>
          </>
        )}
        <dt>{t('fields.repo')}</dt>
        <dd className="mono">{task.repoPath}</dd>
        <dt>{t('fields.base')}</dt>
        <dd className="mono">{task.baseRef}</dd>
        <dt>{t('fields.branch')}</dt>
        <dd className="mono">{task.branch ?? '-'}</dd>
        <dt>{t('fields.worktree')}</dt>
        <dd className="mono">{task.worktreePath ?? '-'}</dd>
        <dt>{t('fields.tools')}</dt>
        <dd>
          <ToolRules task={task} onSaved={onSaved} onError={onError} />
        </dd>
        <dt>{t('fields.skip')}</dt>
        <dd>{task.permission.skipPermissions ? `⚠ ${t('fields.skipOff')}` : t('fields.skipOn')}</dd>
      </dl>
      {task.sessionCount > 0 && (
        <section className="detail-section">
          <h3>{t('fields.budget')}</h3>
          <ContextMeter context={task.context} />
        </section>
      )}
    </>
  );
}
