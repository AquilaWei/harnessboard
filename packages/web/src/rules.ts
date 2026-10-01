// SPDX-License-Identifier: Apache-2.0
import { isToolRule } from '@harnessboard/shared';

/** Rules typed one per line: the valid ones without duplicates, and the lines that are not rules. */
export function parseRules(text: string): { rules: string[]; invalid: string[] } {
  const lines = [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  return {
    rules: lines.filter(isToolRule),
    invalid: lines.filter((line) => !isToolRule(line)),
  };
}
