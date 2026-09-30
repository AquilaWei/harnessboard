// SPDX-License-Identifier: Apache-2.0

/** What the harness found at a path the user typed or picked. */
export interface FolderInfo {
  /** Absolute path, with a leading `~` expanded. */
  path: string;
  exists: boolean;
  /** Root of the git repository containing the folder; `null` when there is none. */
  repoRoot: string | null;
  /** A task branches from a commit, so an empty repository cannot be used yet. */
  hasCommits: boolean;
}

/** A folder and its subfolders (`GET /api/folders`), for picking a repository. */
export interface FolderListing extends FolderInfo {
  /** `null` at the filesystem root. */
  parent: string | null;
  /** Subfolders, without hidden ones, sorted by name. */
  entries: { name: string; path: string; isRepo: boolean }[];
}
