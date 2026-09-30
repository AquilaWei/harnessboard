// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { ContextMeter, FeatureProgress } from './Meter';

interface Props {
  task: TaskView;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}

export function TaskCard({ task, onOpen, onDragStart, onDragEnd, dragging }: Props) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`card ${dragging ? 'dragging' : ''}`}
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-top">
        <span className="card-id">#{task.id}</span>
        <span className="card-title">{task.title}</span>
        {task.mode === 'loop' && <span className="badge">{t('loop.badge')}</span>}
      </div>
      {task.mode === 'loop' && task.sessionCount > 0 && <FeatureProgress loop={task.loop} />}
      {task.sessionCount > 0 && <ContextMeter context={task.context} />}
      <div className="card-meta">
        <span>
          <span className={`status-dot ${task.status}`} aria-hidden /> {t(`status.${task.status}`)}
        </span>
        {task.sessionCount > 0 && <span>{t('sessions', { count: task.sessionCount })}</span>}
      </div>
    </button>
  );
}
