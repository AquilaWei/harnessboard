// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TaskDetail } from '@harnessboard/shared';
import { ContextMeter } from './Meter';

/** Where the task lives and how it is configured; kept out of the way of the status. */
export function Details({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const extraTools = task.permission.allowedTools.filter((rule) => !rule.startsWith('Bash(git '));
  return (
    <>
      <dl className="facts">
        <dt>{t('fields.mode')}</dt>
        <dd>{t(`form.modes.${task.mode}`)}</dd>
        <dt>{t('fields.implementer')}</dt>
        <dd className="mono">{task.agents.implementer}</dd>
        <dt>{t('fields.reviewer')}</dt>
        <dd className="mono">{task.agents.reviewer ?? t('fields.none')}</dd>
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
        <dd className="mono">{extraTools.length > 0 ? extraTools.join(', ') : t('fields.none')}</dd>
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
