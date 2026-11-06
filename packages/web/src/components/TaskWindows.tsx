// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode, type PointerEvent } from 'react';
import { resizeSplitter, snapTarget, snapRect, type SnapTarget, type Rect } from '../layout';
import type { DrawerTab } from './TaskDrawer';

type WindowTask = { id: number; tab: DrawerTab };

/** Keeps task content mounted while its floating frame moves or changes stacking order. */
export function TaskWindows({
  windows,
  onFocus,
  children,
  tiledRects,
  onRects,
}: {
  tiledRects?: Record<number, Rect> | undefined;
  onRects?: (rects: Record<number, Rect>) => void;
  windows: WindowTask[];
  onFocus: (id: number) => void;
  children: (task: WindowTask, active: boolean) => ReactNode;
}) {
  return (
    <>
      {windows.map((task, index) => (
        <TaskWindow
          key={task.id}
          index={index}
          onFocus={() => onFocus(task.id)}
          tiledRect={tiledRects?.[task.id]}
          onDetach={() => {
            if (tiledRects) {
              const next = { ...tiledRects };
              delete next[task.id];
              onRects?.(next);
            }
          }}
          onSplit={(edge, delta) => {
            const current = tiledRects?.[task.id];
            if (!current || !tiledRects) return false;
            const axis = edge === 'e' || edge === 'w' ? 'x' : 'y';
            const size = axis === 'x' ? 'width' : 'height';
            const otherAxis = axis === 'x' ? 'y' : 'x';
            const otherSize = axis === 'x' ? 'height' : 'width';
            const forward = edge === 'e' || edge === 's';
            const boundary = current[axis] + (forward ? current[size] : 0);
            const neighbours = Object.entries(tiledRects).filter(
              ([id, r]) =>
                Number(id) !== task.id &&
                Math.abs(r[axis] + (forward ? 0 : r[size]) - boundary) < 1 &&
                r[otherAxis] < current[otherAxis] + current[otherSize] &&
                r[otherAxis] + r[otherSize] > current[otherAxis],
            );
            if (!neighbours.length) return false;
            const next = { ...tiledRects };
            for (const [id, r] of neighbours) {
              const pair = forward
                ? resizeSplitter(current, r, axis, delta)
                : resizeSplitter(r, current, axis, delta);
              next[task.id] = pair[forward ? 0 : 1];
              next[Number(id)] = pair[forward ? 1 : 0];
            }
            onRects?.(next);
            return true;
          }}
        >
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
  tiledRect,
  onDetach,
  onSplit,
}: {
  tiledRect?: Rect | undefined;
  onDetach: () => void;
  onSplit: (edge: string, delta: number) => boolean;
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
        y: Math.max(0, Math.min(r.y, innerHeight - Math.min(r.height, innerHeight))),
      }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  useEffect(() => {
    if (tiledRect) setRect(tiledRect);
  }, [tiledRect]);
  const [preview, setPreview] = useState<SnapTarget>(null);
  const [restore, setRestore] = useState<Rect | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    onFocus();
    const target = event.target as HTMLElement;
    const resize = target.classList.contains('task-resize');
    const edge = target.dataset.edge ?? 'se';
    if (!resize && (!target.closest('.drawer-title') || target.closest('button, input, textarea')))
      return;
    if (innerWidth <= 640) return;
    event.preventDefault();
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    const initial = restore ? { ...restore, x: event.clientX - restore.width / 2, y: 0 } : rect;
    const x = event.clientX,
      y = event.clientY;
    let snap: SnapTarget = null;
    let detached = false;
    const move = (e: globalThis.PointerEvent) => {
      snap = !resize
        ? snapTarget(e.clientX, e.clientY, { width: innerWidth, height: innerHeight })
        : null;
      if (
        resize &&
        tiledRect &&
        edge.length === 1 &&
        onSplit(edge, edge === 'e' || edge === 'w' ? e.clientX - x : e.clientY - y)
      )
        return;
      if (!detached) {
        onDetach();
        detached = true;
      }
      setPreview(snap);
      setRect(
        resize
          ? (() => {
              const left = edge.includes('w')
                ? Math.max(0, Math.min(initial.x + initial.width - 320, initial.x + e.clientX - x))
                : initial.x;
              const top = edge.includes('n')
                ? Math.max(0, Math.min(initial.y + initial.height - 240, initial.y + e.clientY - y))
                : initial.y;
              const right = edge.includes('e')
                ? Math.min(
                    innerWidth,
                    Math.max(initial.x + 320, initial.x + initial.width + e.clientX - x),
                  )
                : initial.x + initial.width;
              const bottom = edge.includes('s')
                ? Math.min(
                    innerHeight,
                    Math.max(initial.y + 240, initial.y + initial.height + e.clientY - y),
                  )
                : initial.y + initial.height;
              return { x: left, y: top, width: right - left, height: bottom - top };
            })()
          : {
              ...initial,
              x: Math.max(0, Math.min(innerWidth - initial.width, initial.x + e.clientX - x)),
              y: Math.max(0, Math.min(innerHeight - initial.height, initial.y + e.clientY - y)),
            },
      );
    };
    const finish = () => {
      if (snap) {
        setRestore(initial);
        setRect(snapRect(snap, { width: innerWidth, height: innerHeight }));
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
        {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
          <div key={edge} className={`task-resize resize-${edge}`} data-edge={edge} />
        ))}
      </div>
      {preview && (
        <div
          className={`task-snap-preview ${preview}`}
          style={(() => {
            const r = snapRect(preview, { width: innerWidth, height: innerHeight });
            return { left: r.x, top: r.y, width: r.width, height: r.height };
          })()}
        />
      )}
    </>
  );
}
