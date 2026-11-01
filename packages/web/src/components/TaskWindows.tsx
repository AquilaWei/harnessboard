// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode, type PointerEvent } from 'react';
import type { DrawerTab } from './TaskDrawer';

type WindowTask = { id: number; tab: DrawerTab };
type Rect = { x: number; y: number; width: number; height: number };

/** Keeps task content mounted while its floating frame moves or changes stacking order. */
export function TaskWindows({
  windows,
  onFocus,
  children,
}: {
  windows: WindowTask[];
  onFocus: (id: number) => void;
  children: (task: WindowTask, active: boolean) => ReactNode;
}) {
  return (
    <>
      {windows.map((task, index) => (
        <TaskWindow key={task.id} index={index} onFocus={() => onFocus(task.id)}>
          {children(task, index === windows.length - 1)}
        </TaskWindow>
      ))}
    </>
  );
}

function TaskWindow({
  index,
  onFocus,
  children,
}: {
  index: number;
  onFocus: () => void;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<Rect>(() => ({
    x: 24 + index * 24,
    y: 30 + index * 24,
    width: Math.max(360, innerWidth * 0.48),
    height: innerHeight * 0.85,
  }));
  useEffect(() => {
    const clamp = () =>
      setRect((r) => ({
        ...r,
        width: Math.min(r.width, innerWidth),
        height: Math.min(r.height, innerHeight),
        x: Math.max(0, Math.min(r.x, innerWidth - Math.min(r.width, innerWidth))),
        y: Math.max(0, Math.min(r.y, innerHeight - 48)),
      }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  const [preview, setPreview] = useState<'left' | 'right' | null>(null);
  const [restore, setRestore] = useState<Rect | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    onFocus();
    const target = event.target as HTMLElement;
    const resize = target.classList.contains('task-resize');
    if (!resize && (!target.closest('.drawer-title') || target.closest('button, input, textarea')))
      return;
    if (innerWidth <= 640) return;
    event.preventDefault();
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    const initial = restore ? { ...restore, x: event.clientX - restore.width / 2, y: 0 } : rect;
    const x = event.clientX,
      y = event.clientY;
    let snap: 'left' | 'right' | null = null;
    const move = (e: globalThis.PointerEvent) => {
      snap =
        !resize && e.clientX < 24
          ? 'left'
          : !resize && e.clientX > innerWidth - 24
            ? 'right'
            : null;
      setPreview(snap);
      setRect(
        resize
          ? {
              ...initial,
              width: Math.min(innerWidth - initial.x, Math.max(360, initial.width + e.clientX - x)),
              height: Math.min(
                innerHeight - initial.y,
                Math.max(320, initial.height + e.clientY - y),
              ),
            }
          : {
              ...initial,
              x: Math.max(0, Math.min(innerWidth - initial.width, initial.x + e.clientX - x)),
              y: Math.max(0, Math.min(innerHeight - 48, initial.y + e.clientY - y)),
            },
      );
    };
    const finish = () => {
      if (snap) {
        setRestore(initial);
        setRect({
          x: snap === 'left' ? 0 : innerWidth / 2,
          y: 0,
          width: innerWidth / 2,
          height: innerHeight,
        });
      } else setRestore(null);
      setPreview(null);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', finish);
      node.removeEventListener('pointercancel', finish);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
  };
  return (
    <>
      <div
        className="task-window"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          zIndex: 6 + index / (index + 1),
        }}
        onPointerDown={start}
        onFocusCapture={onFocus}
      >
        {children}
        <div className="task-resize" />
      </div>
      {preview && <div className={`task-snap-preview ${preview}`} />}
    </>
  );
}
