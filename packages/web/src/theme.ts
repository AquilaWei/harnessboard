// SPDX-License-Identifier: Apache-2.0

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
const STORAGE_KEY = 'harnessboard.theme';

/** The viewer's saved theme; `system` follows the operating system. */
export function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // storage unavailable (private mode); follow the system
  }
  return 'system';
}

/** Applies a theme to the page and remembers it for this browser. */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // not persisted; the choice still applies to this page
  }
}
