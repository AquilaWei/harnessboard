// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

/** Longest tool output excerpt an event carries; the full output never enters events. */
export const RESULT_EXCERPT_CHARS = 2000;

/**
 * Digest of a tool call's exact arguments. Keys are sorted so the same arguments always give
 * the same digest, while any difference in a value gives a different one.
 */
export function argsKey(input: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(input ?? null)) ?? 'null')
    .digest('hex')
    .slice(0, 16);
}

/** Keeps the tail of long output: the error is usually at the end. */
export function excerpt(text: unknown): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > RESULT_EXCERPT_CHARS ? value.slice(-RESULT_EXCERPT_CHARS) : value;
}
