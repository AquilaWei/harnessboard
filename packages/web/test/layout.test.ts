// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { gridRects, snapTarget, resizeSplitter, tileStage } from '../src/layout';

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

it('opens only the stage windows that fit', () => {
  expect(tileStage(null, 'active', [1, 2, 3], { width: 640, height: 240 })).toEqual({
    stage: 'active',
    ids: [1, 2],
    rects: {
      1: { x: 0, y: 0, width: 320, height: 240 },
      2: { x: 320, y: 0, width: 320, height: 240 },
    },
  });
});

it('replaces all previous stage windows with the requested ids', () => {
  expect(
    tileStage(
      { stage: 'pending', ids: [9], rects: { 9: { x: 0, y: 0, width: 960, height: 720 } } },
      'active',
      [1],
      { width: 960, height: 720 },
    ),
  ).toEqual({
    stage: 'active',
    ids: [1],
    rects: { 1: { x: 0, y: 0, width: 960, height: 720 } },
  });
});

it('toggles off when the same stage is selected', () => {
  expect(
    tileStage(
      { stage: 'active', ids: [1], rects: { 1: { x: 0, y: 0, width: 960, height: 720 } } },
      'active',
      [1],
      { width: 960, height: 720 },
    ),
  ).toBeNull();
});

it('retiles when switching to a different stage', () => {
  expect(
    tileStage(
      { stage: 'pending', ids: [9], rects: { 9: { x: 0, y: 0, width: 960, height: 720 } } },
      'active',
      [1, 2],
      { width: 960, height: 720 },
    ),
  ).toEqual({
    stage: 'active',
    ids: [1, 2],
    rects: {
      1: { x: 0, y: 0, width: 480, height: 720 },
      2: { x: 480, y: 0, width: 480, height: 720 },
    },
  });
});

it('preserves the layout when an empty stage is selected', () => {
  expect(
    tileStage(
      { stage: 'active', ids: [1], rects: { 1: { x: 0, y: 0, width: 960, height: 720 } } },
      'pending',
      [],
      { width: 960, height: 720 },
    ),
  ).toEqual({
    stage: 'active',
    ids: [1],
    rects: { 1: { x: 0, y: 0, width: 960, height: 720 } },
  });
});
