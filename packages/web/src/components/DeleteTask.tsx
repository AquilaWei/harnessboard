// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { api } from '../api';

interface Props {
  task: TaskView;
  onDeleted: () => void;
  /** Shows a short message: the result, or why deleting failed. */
  onMessage: (message: string) => void;
}

/**
 * Delete button that asks in place before deleting, instead of a browser dialog, and says
 * what is lost (the worktree and its uncommitted edits) and what is kept (the branch).
 */
export function DeleteTask({ task, onDeleted, onMessage }: Props) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const { branch } = await api.deleteTask(task.id);
      onMessage(branch ? t('deleteTask.doneBranch', { branch }) : t('deleteTask.done'));
      onDeleted();
    } catch (err) {
      onMessage((err as Error).message);
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn ghost danger push-end"
        onClick={() => setConfirming(true)}
      >
        {t('deleteTask.button')}
      </button>
    );
  }
  return (
    <div
      className="confirm-delete"
      role="alertdialog"
      aria-label={t('deleteTask.title', { id: task.id })}
    >
      <strong>{t('deleteTask.title', { id: task.id })}</strong>
      <p>
        {task.worktreePath
          ? t('deleteTask.withWorktree', { branch: task.branch ?? '' })
          : t('deleteTask.noWorktree')}
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn danger-fill"
          disabled={busy}
          onClick={() => void remove()}
        >
          {t('deleteTask.confirm')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
          {t('deleteTask.cancel')}
        </button>
      </div>
    </div>
  );
}
