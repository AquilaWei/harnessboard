// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';

interface Props {
  task: TaskView;
  /** Called with the trimmed change, or `undefined` when it was left empty. */
  onSubmit: (message: string | undefined) => void;
  onClose: () => void;
}

/**
 * Asks what should change before a draft is planned again. An in-app dialog, because the
 * desktop app's Electron throws on `window.prompt`. A task with a spec file needs a change
 * to plan against; a loop task may reopen its plan without one.
 */
export function PlanChangeDialog({ task, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const required = !!task.specFile;
  const blocked = required && !message.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!blocked) onSubmit(message.trim() || undefined);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-change"
        onSubmit={submit}
      >
        <h2 id="plan-change">{t('planChangePrompt')}</h2>
        <label className="field">
          <span>{t('planChange.label', { id: task.id })}</span>
          <textarea
            rows={5}
            autoFocus
            value={message}
            placeholder={t(required ? 'planChange.required' : 'planChange.optional')}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('planChange.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={blocked}>
            {t('planChange.send')}
          </button>
        </div>
      </form>
    </>
  );
}
