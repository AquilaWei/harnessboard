// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { format, messagesFor, statusPage } from '../src/messages.js';

describe('messagesFor', () => {
  it('uses Traditional Chinese for zh-TW', () => {
    expect(messagesFor('zh-TW').quit).toBe('結束 Harnessboard');
  });

  it('uses English for other locales', () => {
    expect(messagesFor('fr-FR').quit).toBe('Quit Harnessboard');
  });
});

describe('format', () => {
  it('fills placeholders', () => {
    expect(format('port {port} is taken', { port: 4317 })).toBe('port 4317 is taken');
  });

  it('leaves unknown placeholders as they are', () => {
    expect(format('see {log}', {})).toBe('see {log}');
  });
});

describe('statusPage', () => {
  it('escapes the text', () => {
    expect(decodeURIComponent(statusPage('<b>'))).toContain('&lt;b&gt;');
  });
});
