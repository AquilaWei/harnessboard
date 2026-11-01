// SPDX-License-Identifier: Apache-2.0
/** A fresh discovery result; callers cannot supply deletion paths. Bytes are logical file sizes. */
export interface CacheCleanup {
  entries: {
    path: string;
    bytes: number;
    status: 'candidate' | 'removed' | 'skipped' | 'failed';
    reason?: string;
  }[];
  estimatedBytes: number;
  removedBytes: number;
}
