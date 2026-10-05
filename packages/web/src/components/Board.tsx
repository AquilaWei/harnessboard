// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { PHONE_TABS, STAGES, dropAction, groupByPhoneTab, stageOf } from '../board';
import type { PhoneTab, Stage, TaskAction } from '../board';
import { usePhoneWidth } from '../media';
import type { DrawerTab } from './TaskDrawer';
import { TaskCard } from './TaskCard';

interface Props {
  tasks: TaskView[];
  /** The one tab shown at phone width; kept by the caller so the header can switch it. */
  phoneTab: PhoneTab;
  onPhoneTab: (tab: PhoneTab) => void;
  onOpen: (id: number, tab?: DrawerTab) => void;
  onAction: (task: TaskView, action: TaskAction) => void;
  onInvalidMove: (task: TaskView, target: Stage) => void;
  onNewTask: () => void;
}

/** The four stages side by side, or one tab at a time at phone width. */
export function Board(props: Props) {
  return usePhoneWidth() ? <PhoneBoard {...props} /> : <StageBoard {...props} />;
}

/** Four stages that fit one screen; cards carry their own buttons, dragging is optional. */
function StageBoard({ tasks, onOpen, onAction, onInvalidMove, onNewTask }: Props) {
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

/** One tab at a time, since only one column fits; phones have no drag and drop. */
function PhoneBoard({ tasks, phoneTab, onPhoneTab, onOpen, onAction, onNewTask }: Props) {
  const { t } = useTranslation();
  const groups = groupByPhoneTab(tasks);
  // Newest first, as in the stages.
  const items = [...groups[phoneTab]].reverse();

  return (
    <main className="board">
      <div className="tabs board-tabs" role="tablist">
        {PHONE_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={phoneTab === id}
            onClick={() => onPhoneTab(id)}
          >
            {t(`phoneTab.${id}`)} <span className="count">{groups[id].length}</span>
          </button>
        ))}
      </div>
      <section
        className={`stage ${phoneTab === 'waiting' && items.length > 0 ? 'stage-attention has-items' : ''}`}
        role="tabpanel"
        aria-label={t(`phoneTab.${phoneTab}`)}
      >
        {items.length === 0 && (
          <div className="empty">
            <p>{t(`phoneTabEmpty.${phoneTab}`)}</p>
            {phoneTab === 'waiting' && (
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
            dragging={false}
            onOpen={(tab) => onOpen(task.id, tab)}
            onAction={(action) => onAction(task, action)}
            onDragStart={() => {}}
            onDragEnd={() => {}}
          />
        ))}
      </section>
    </main>
  );
}
