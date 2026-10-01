// SPDX-License-Identifier: Apache-2.0
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

export function DiffView({ diff }: { diff: WorktreeDiff | null }) {
  const { t } = useTranslation();
  if (!diff) return null;
  if (!diff.diff && diff.untracked.length === 0) return <p className="empty">{t('noDiff')}</p>;
  return (
    <>
      {diff.diff && <DiffLines text={diff.diff} />}
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
