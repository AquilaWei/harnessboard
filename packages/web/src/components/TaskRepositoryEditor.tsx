// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { FolderField } from './FolderField';

interface Props {
  task: TaskDetail;
  onSaved: () => void;
  onError: (message: string) => void;
}

/** Correct the project folder before an initial specification is approved. */
export function TaskRepositoryEditor({ task, onSaved, onError }: Props) {
  const { t } = useTranslation();
  const [repo, setRepo] = useState(task.repoPath);
  const [saving, setSaving] = useState(false);
  useEffect(() => setRepo(task.repoPath), [task.id, task.repoPath]);
  const operation = task.operations?.repository;
  if (!operation?.visible) return null;
  return (
    <section className="detail-section">
      <h3>{t('repository.title')}</h3>
      <p className="hint">{t('repository.hint')}</p>
      {!operation.enabled ? (
        <p className="hint">
          {operation.reason === 'Stop the task before changing its project folder'
            ? t('repository.stopFirst')
            : t('repository.beforeApproval')}
        </p>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            try {
              await api.setRepository(task.id, repo.trim());
              onSaved();
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <fieldset disabled={saving}>
            <FolderField value={repo} onChange={setRepo} recent={[]} />
            <button
              className="btn"
              type="submit"
              disabled={!repo.trim() || repo.trim() === task.repoPath}
            >
              {t('repository.save')}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
