// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { PHONE_TABS, STAGES, dropAction, groupByPhoneTab, stageOfTask } from '../board';
import type { PhoneTab, Stage, TaskAction } from '../board';
import { gridRects } from '../layout';
import { usePhoneWidth } from '../media';
import type { DrawerTab } from './TaskDrawer';
import { TaskCard } from './TaskCard';

interface Props {
  tasks: TaskView[];
  tiledStage?: Stage | null | undefined;
  onTile?: (stage: Stage, ids: number[]) => void;
  /** The one tab shown at phone width; kept by the caller so the header can switch it. */
  phoneTab: PhoneTab;
  onPhoneTab: (tab: PhoneTab) => void;
  onOpen: (id: number, tab?: DrawerTab) => void;
  onAction: (task: TaskView, action: TaskAction) => void;
  onInvalidMove: (task: TaskView, target: Stage) => void;
  onReorder?: (task: TaskView, beforeId: number | null) => void;
  onNewTask: () => void;
}

/** The five stages side by side, or one tab at a time at phone width. */
export function Board(props: Props) {
  return usePhoneWidth() ? <PhoneBoard {...props} /> : <StageBoard {...props} />;
}

/** Five stages that fit one screen; cards carry their own buttons, dragging is optional. */
function StageBoard({
  tasks,
  onOpen,
  onAction,
  onInvalidMove,
  onReorder,
  onNewTask,
  onTile,
  tiledStage,
}: Props) {
  const { t } = useTranslation();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [dragged, setDragged] = useState<TaskView | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const drop = (target: Stage) => {
    setOver(null);
    if (!dragged) return;
    if (target === 'pending' && dragged.status === 'pending') {
      onReorder?.(dragged, null);
      return;
    }
    if (stageOfTask(dragged) === target) return;
    const action = dropAction(dragged, target);
    if (action) onAction(dragged, action);
    else onInvalidMove(dragged, target);
  };

  return (
    <main className="board">
      {STAGES.map((stage) => {
        // Newest first, so fresh work is at the top of each stage.
        const items = tasks.filter((task) => stageOfTask(task) === stage);
        if (stage === 'pending')
          items.sort((a, b) => (a.queueOrder ?? a.id) - (b.queueOrder ?? b.id) || a.id - b.id);
        else items.reverse();
        const droppable = dragged !== null && dropAction(dragged, stage) !== null;
        return (
          <section
            key={stage}
            id={`stage-${stage}`}
            className={`stage stage-${stage} ${items.length > 0 ? 'has-items' : ''} ${over === stage && droppable ? 'drop-ok' : ''} ${
              dragged && !droppable && stageOfTask(dragged) !== stage ? 'drop-no' : ''
            }`}
            onMouseEnter={() => stage === 'done' && setDoneExpanded(true)}
            onMouseLeave={() => stage === 'done' && setDoneExpanded(false)}
            onFocusCapture={() => stage === 'done' && setDoneExpanded(true)}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setDoneExpanded(false);
            }}
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
              {stage !== 'draft' && stage !== 'done' ? (
                <button
                  type="button"
                  aria-pressed={tiledStage === stage}
                  aria-label={t(
                    tiledStage === stage ? 'boardLayout.collapseAll' : 'boardLayout.tileAll',
                    { stage: t(`stage.${stage}`) },
                  )}
                  onClick={() =>
                    onTile?.(
                      stage,
                      items.map((task) => task.id),
                    )
                  }
                >
                  {t(`stage.${stage}`)}
                </button>
              ) : (
                <span>{t(`stage.${stage}`)}</span>
              )}
              {tiledStage === stage &&
                gridRects(items.length, { width: innerWidth, height: innerHeight }).hidden > 0 && (
                  <small>
                    {t('boardLayout.moreHidden', {
                      count: gridRects(items.length, { width: innerWidth, height: innerHeight })
                        .hidden,
                    })}
                  </small>
                )}
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
            <div
              className={stage === 'done' ? `done-stack ${doneExpanded ? 'expanded' : ''}` : ''}
              aria-label={
                stage === 'done' ? t('boardLayout.doneStack', { count: items.length }) : undefined
              }
            >
              {items.map((task, index) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  dragging={dragged?.id === task.id}
                  onOpen={(tab) => onOpen(task.id, tab)}
                  onAction={(action) => onAction(task, action)}
                  onReorderDrop={
                    stage === 'pending' && task.status === 'pending' && dragged?.id !== task.id
                      ? (beforeId) => {
                          if (dragged) onReorder?.(dragged, beforeId);
                        }
                      : undefined
                  }
                  afterId={items[index + 1]?.id ?? null}
                  onDragStart={() => setDragged(task)}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                />
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}

/** One tab at a time, since only one column fits; phones have no drag and drop. */
function PhoneBoard({ tasks, phoneTab, onPhoneTab, onOpen, onAction, onNewTask }: Props) {
  const { t } = useTranslation();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const groups = groupByPhoneTab(tasks);
  // Newest first, as in the stages.
  const items = phoneTab === 'pending' ? groups[phoneTab] : [...groups[phoneTab]].reverse();

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
        {phoneTab === 'done' && (
          <button
            type="button"
            className="done-stack-toggle"
            aria-expanded={doneExpanded}
            onClick={() => setDoneExpanded(!doneExpanded)}
          >
            {t('boardLayout.doneStackTap', { count: items.length })}
          </button>
        )}
        <div className={phoneTab === 'done' ? `done-stack ${doneExpanded ? 'expanded' : ''}` : ''}>
          {items.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              dragging={false}
              onOpen={(tab) => onOpen(task.id, tab)}
              onAction={(action) => onAction(task, action)}
              afterId={null}
              onDragStart={() => {}}
              onDragEnd={() => {}}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
