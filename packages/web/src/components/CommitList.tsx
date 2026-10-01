// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommitInfo } from '@harnessboard/shared';
import { api } from '../api';
import { DiffLines } from './DiffView';

interface Props {
  taskId: number;
  commits: CommitInfo[] | null;
  onError: (message: string) => void;
}

/** The task branch's commits, newest first; each opens to its message and patch. */
export function CommitList({ taskId, commits, onError }: Props) {
  const { t, i18n } = useTranslation();
  const [shown, setShown] = useState<Record<string, string>>({});
  if (!commits) return null;

  const load = (hash: string) => {
    if (shown[hash] !== undefined) return;
    api.commit(taskId, hash).then(
      ({ show }) => setShown((prev) => ({ ...prev, [hash]: show })),
      (e: Error) => onError(e.message),
    );
  };

  return (
    <section className="commits">
      <h3>{t('commits.title', { count: commits.length })}</h3>
      {commits.length === 0 ? (
        <p className="empty">{t('commits.none')}</p>
      ) : (
        <ul className="commit-list">
          {commits.map((c) => (
            <li key={c.hash}>
              <details onToggle={(e) => e.currentTarget.open && load(c.hash)}>
                <summary>
                  <code className="commit-hash">{c.hash.slice(0, 8)}</code>
                  <span className="commit-subject">{c.subject}</span>
                  <span className="commit-meta">
                    {c.author} · {new Date(c.ts).toLocaleString(i18n.language)}
                  </span>
                </summary>
                {shown[c.hash] !== undefined ? (
                  <DiffLines text={shown[c.hash]!} />
                ) : (
                  <p className="empty">{t('commits.loading')}</p>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
