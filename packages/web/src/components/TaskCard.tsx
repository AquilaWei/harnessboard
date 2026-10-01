// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { primaryAction } from '../board';
import type { TaskAction } from '../board';
import { openTab } from '../notify';
import { Description } from './Description';
import { ContextMeter } from './Meter';
import type { DrawerTab } from './TaskDrawer';

interface Props {
  task: TaskView;
  onOpen: (tab?: DrawerTab) => void;
  onAction: (action: TaskAction) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}

export function TaskCard({ task, onOpen, onAction, onDragStart, onDragEnd, dragging }: Props) {
  const { t } = useTranslation();
  const primary = primaryAction(task);

  const runPrimary = () => {
    switch (primary) {
      case 'start':
      case 'retry':
        onAction('queue');
        return;
      case 'stop':
        onAction('stop');
        return;
      case 'review':
      case 'approvePlan':
      case 'approveCriteria':
      case 'answerPermission':
        onOpen(openTab(task));
        return;
    }
  };

  return (
    <article
      className={`card ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="card-open" onClick={() => onOpen()}>
        <span className="card-title">{task.title}</span>
        <span className="card-sub">
          <span className="card-id">#{task.id}</span>
          <span className={`status-chip ${task.status}`}>
            <span className={`status-dot ${task.status}`} aria-hidden />{' '}
            {t(`status.${task.status}`)}
          </span>
          {task.mode === 'loop' && <span className="badge">{t('loop.badge')}</span>}
        </span>
      </button>
      <Description task={task} />
      {task.status === 'running' && task.activity?.phase !== 'verifying' && (
        <ContextMeter context={task.context} />
      )}
      <div className="card-foot">
        <span className="card-meta">
          {task.loop && (
            <span>
              ✓ {t('card.features', { verified: task.loop.verified, total: task.loop.total })}
            </span>
          )}
          {task.agents.reviewer && (
            <span>👁 {t('card.reviewer', { agent: task.agents.reviewer })}</span>
          )}
        </span>
        {primary && (
          <button
            type="button"
            className={`btn small ${primary === 'stop' ? '' : 'primary'}`}
            onClick={runPrimary}
          >
            {t(`actions.${primary}`)}
          </button>
        )}
      </div>
    </article>
  );
}
