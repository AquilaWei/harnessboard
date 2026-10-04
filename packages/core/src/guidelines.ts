// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { expandHome } from './folders.js';

/** A file of rules the reviewer checks the work against, with its text. */
export interface Guideline {
  /** As configured, so the reviewer and the user see the same name. */
  file: string;
  text: string;
}

/**
 * Reads the configured guideline files. Throws when one can not be read, because a review
 * that silently skips the user's rules would look like one that followed them.
 */
export function readGuidelines(files: string[]): Guideline[] {
  return files.map((file) => {
    try {
      return { file, text: readFileSync(expandHome(file), 'utf8') };
    } catch (err) {
      throw new Error(`review guideline ${file} can not be read: ${(err as Error).message}`);
    }
  });
}
