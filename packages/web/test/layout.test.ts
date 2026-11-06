// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { gridRects, snapTarget, resizeSplitter } from '../src/layout';

it('fills the viewport for one task', () => {
  expect(gridRects(1, { width: 960, height: 720 })).toEqual({
    rects: [{ x: 0, y: 0, width: 960, height: 720 }],
    hidden: 0,
  });
});
it('limits cells to those meeting minimum dimensions', () => {
  expect(gridRects(6, { width: 640, height: 480 }).hidden).toBe(2);
});
it('prioritizes the bottom right corner over the right side', () => {
  expect(snapTarget(950, 710, { width: 960, height: 720 })).toBe('bottom-right');
});
it('does not snap away from edges', () => {
  expect(snapTarget(400, 400, { width: 960, height: 720 })).toBeNull();
});
it('clamps a shared edge at the neighbour minimum', () => {
  expect(
    resizeSplitter(
      { x: 0, y: 0, width: 480, height: 720 },
      { x: 480, y: 0, width: 480, height: 720 },
      'x',
      300,
    ),
  ).toEqual([
    { x: 0, y: 0, width: 640, height: 720 },
    { x: 640, y: 0, width: 320, height: 720 },
  ]);
});

it('places two tasks in full-height halves', () => {
  expect(gridRects(2, { width: 960, height: 720 }).rects).toEqual([
    { x: 0, y: 0, width: 480, height: 720 },
    { x: 480, y: 0, width: 480, height: 720 },
  ]);
});

it('places the third task in the lower left quadrant', () => {
  expect(gridRects(3, { width: 960, height: 720 }).rects[2]).toEqual({
    x: 0,
    y: 360,
    width: 480,
    height: 360,
  });
});

it('places six tasks in three columns', () => {
  expect(gridRects(6, { width: 960, height: 720 }).rects[5]).toEqual({
    x: 640,
    y: 360,
    width: 320,
    height: 360,
  });
});
