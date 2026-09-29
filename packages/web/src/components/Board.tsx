// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { COLUMNS, columnOf, moveAction } from '../board';
import type { ColumnId, MoveAction } from '../board';
import { TaskCard } from './TaskCard';

interface Props {
  tasks: TaskView[];
  onOpen: (id: number) => void;
  onMove: (task: TaskView, action: MoveAction) => void;
  onInvalidMove: (task: TaskView, target: ColumnId) => void;
}

export function Board({ tasks, onOpen, onMove, onInvalidMove }: Props) {
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<TaskView | null>(null);
  const [over, setOver] = useState<ColumnId | null>(null);

  const drop = (target: ColumnId) => {
    setOver(null);
    if (!dragged || columnOf(dragged.status) === target) return;
    const action = moveAction(dragged, target);
    if (action) onMove(dragged, action);
    else onInvalidMove(dragged, target);
  };

  return (
    <main className="board">
      {COLUMNS.map((column) => {
        const items = tasks.filter((task) => columnOf(task.status) === column);
        const droppable = dragged !== null && moveAction(dragged, column) !== null;
        const title = column === 'halted' ? t('column.halted') : t(`status.${column}`);
        return (
          <section
            key={column}
            className={`column ${over === column && droppable ? 'drop-ok' : ''}`}
            aria-label={title}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(column);
            }}
            onDragLeave={() => setOver((c) => (c === column ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              drop(column);
            }}
          >
            <div className="column-head">
              <span>{title}</span>
              <span className="count">{items.length}</span>
            </div>
            {items.length === 0 && <div className="empty">{t('emptyColumn')}</div>}
            {items.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                dragging={dragged?.id === task.id}
                onOpen={() => onOpen(task.id)}
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
