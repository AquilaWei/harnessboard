// SPDX-License-Identifier: Apache-2.0
export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { width: number; height: number };
export type SnapTarget =
  'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null;

/** Reduces the requested grid until every cell fits the minimum usable task size. */
export function gridRects(count: number, viewport: Viewport): { rects: Rect[]; hidden: number } {
  let visible = count;
  while (visible > 0) {
    const cols = visible === 1 ? 1 : visible <= 4 ? 2 : Math.ceil(Math.sqrt(visible));
    const rows = Math.ceil(visible / cols);
    if (viewport.width / cols >= 320 && viewport.height / rows >= 240) {
      return {
        rects: Array.from({ length: visible }, (_, i) => ({
          x: ((i % cols) * viewport.width) / cols,
          y: (Math.floor(i / cols) * viewport.height) / rows,
          width: viewport.width / cols,
          height: viewport.height / rows,
        })),
        hidden: count - visible,
      };
    }
    visible--;
  }
  return { rects: [], hidden: count };
}

/** Corners take priority over side snapping within the 24px edge zone. */
export function snapTarget(x: number, y: number, viewport: Viewport): SnapTarget {
  const side = x <= 24 ? 'left' : x >= viewport.width - 24 ? 'right' : null;
  if (!side) return null;
  return y <= 24 ? `top-${side}` : y >= viewport.height - 24 ? `bottom-${side}` : side;
}

/** Converts a snap target to its viewport rectangle for both preview and release. */
export function snapRect(target: Exclude<SnapTarget, null>, viewport: Viewport): Rect {
  return {
    x: target.endsWith('right') ? viewport.width / 2 : 0,
    y: target.startsWith('bottom') ? viewport.height / 2 : 0,
    width: viewport.width / 2,
    height: target.includes('-') ? viewport.height / 2 : viewport.height,
  };
}

/** Moves a shared edge while preserving the pair's outer bounds and minimum sizes. */
export function resizeSplitter(
  first: Rect,
  second: Rect,
  axis: 'x' | 'y',
  delta: number,
): [Rect, Rect] {
  const size = axis === 'x' ? 'width' : 'height';
  const min = axis === 'x' ? 320 : 240;
  const change = Math.max(min - first[size], Math.min(second[size] - min, delta));
  return [
    { ...first, [size]: first[size] + change },
    { ...second, [axis]: second[axis] + change, [size]: second[size] - change },
  ];
}
