// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Sessions } from '../src/session.js';

describe('Sessions', () => {
  it('knows a session it opened for the device', () => {
    const sessions = new Sessions();
    const token = sessions.open(1);
    expect(sessions.has(1, token)).toBe(true);
  });

  it('does not accept a session of the device for another device', () => {
    const sessions = new Sessions();
    const token = sessions.open(1);
    expect(sessions.has(2, token)).toBe(false);
  });

  it('does not accept a missing token', () => {
    const sessions = new Sessions();
    sessions.open(1);
    expect(sessions.has(1, undefined)).toBe(false);
  });

  it('keeps an older session open when the device opens another', () => {
    const sessions = new Sessions();
    const first = sessions.open(1);
    sessions.open(1);
    expect(sessions.has(1, first)).toBe(true);
  });

  it('ends the oldest session when the device opens a ninth', () => {
    const sessions = new Sessions();
    const first = sessions.open(1);
    const second = sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    sessions.open(1);
    expect([sessions.has(1, first), sessions.has(1, second)]).toEqual([false, true]);
  });

  it('ends every session of the device', () => {
    const sessions = new Sessions();
    const token = sessions.open(1);
    sessions.end(1);
    expect(sessions.has(1, token)).toBe(false);
  });
});
