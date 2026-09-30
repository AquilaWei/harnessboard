// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { STAGES, dropAction, stageOf } from '../board';
import type { Stage, TaskAction } from '../board';
import type { DrawerTab } from './TaskDrawer';
import { TaskCard } from './TaskCard';

interface Props {
  tasks: TaskView[];
  onOpen: (id: number, tab?: DrawerTab) => void;
  onAction: (task: TaskView, action: TaskAction) => void;
  onInvalidMove: (task: TaskView, target: Stage) => void;
  onNewTask: () => void;
}

/** Four stages that fit one screen; cards carry their own buttons, dragging is optional. */
export function Board({ tasks, onOpen, onAction, onInvalidMove, onNewTask }: Props) {
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<TaskView | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const drop = (target: Stage) => {
    setOver(null);
    if (!dragged || stageOf(dragged.status) === target) return;
    const action = dropAction(dragged, target);
    if (action) onAction(dragged, action);
    else onInvalidMove(dragged, target);
  };

  return (
    <main className="board">
      {STAGES.map((stage) => {
        // Newest first, so fresh work is at the top of each stage.
        const items = tasks.filter((task) => stageOf(task.status) === stage).reverse();
        const droppable = dragged !== null && dropAction(dragged, stage) !== null;
        return (
          <section
            key={stage}
            id={`stage-${stage}`}
            className={`stage stage-${stage} ${items.length > 0 ? 'has-items' : ''} ${over === stage && droppable ? 'drop-ok' : ''} ${
              dragged && !droppable && stageOf(dragged.status) !== stage ? 'drop-no' : ''
            }`}
            aria-label={t(`stage.${stage}`)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(stage);
            }}
            onDragLeave={() => setOver((s) => (s === stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              drop(stage);
            }}
          >
            <h2 className="stage-head">
              <span>{t(`stage.${stage}`)}</span>
              <span className="count">{items.length}</span>
            </h2>
            {items.length === 0 && (
              <div className="empty">
                <p>{t(`stageEmpty.${stage}`)}</p>
                {stage === 'draft' && (
                  <button type="button" className="btn" onClick={onNewTask}>
                    + {t('newTask')}
                  </button>
                )}
              </div>
            )}
            {items.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                dragging={dragged?.id === task.id}
                onOpen={(tab) => onOpen(task.id, tab)}
                onAction={(action) => onAction(task, action)}
                onDragStart={() => setDragged(task)}
                onDragEnd={() => {
                  setDragged(null);
                  setOver(null);
                }}
              />
            ))}
          </section>
        );
      })}
    </main>
  );
}
