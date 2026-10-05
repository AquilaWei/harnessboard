// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorktreeDiff } from '@harnessboard/shared';

function lineClass(line: string): string {
  if (line.startsWith('diff --git')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
}

/** Unified diff text with added, removed and header lines coloured. */
export function DiffLines({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => (
        <span key={i} className={lineClass(line)}>
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

/** The files a unified diff touches, from its `diff --git a/<old> b/<new>` lines; renames give the new path. */
export function diffFiles(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.slice(line.lastIndexOf(' b/') + 3));
}

/** The worktree's changes; "Files only" lists the changed files, which reads better on a phone. */
export function DiffView({ diff }: { diff: WorktreeDiff | null }) {
  const { t } = useTranslation();
  const [filesOnly, setFilesOnly] = useState(false);
  if (!diff) return null;
  if (!diff.diff && diff.untracked.length === 0) return <p className="empty">{t('noDiff')}</p>;
  return (
    <>
      {diff.diff && (
        <div className="actions diff-toolbar">
          <button
            type="button"
            className="btn small"
            aria-pressed={filesOnly}
            onClick={() => setFilesOnly((on) => !on)}
          >
            {t('filesOnly')}
          </button>
        </div>
      )}
      {diff.diff &&
        (filesOnly ? (
          <ul className="mono diff-files">
            {diffFiles(diff.diff).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <DiffLines text={diff.diff} />
        ))}
      {diff.untracked.length > 0 && (
        <>
          <h3>{t('untracked')}</h3>
          <ul className="mono">
            {diff.untracked.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
