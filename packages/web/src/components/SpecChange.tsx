// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpecChangeProposal, TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { Markdown } from './Markdown';

interface Props {
  task: TaskDetail;
  onDone: () => void;
  onError: (message: string) => void;
}

/** Runs one call with the buttons disabled, then refreshes the task or shows the error. */
function useAct(onDone: () => void, onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      after?.();
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

/**
 * Asks the spec author to change the spec of a task already being built. Its answer comes
 * back as a {@link SpecChangeReview}; the spec stays as it is until the user approves.
 */
export function SpecChangeRequest({ task, onDone, onError }: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const { busy, act } = useAct(onDone, onError);
  return (
    <section className="plan-section">
      <label className="field">
        <span>{t('specChange.request')}</span>
        <textarea
          rows={4}
          value={message}
          placeholder={t('specChange.requestPlaceholder')}
          onChange={(e) => setMessage(e.target.value)}
        />
        <small className="hint">
          {task.specRevisionPending ? t('specChange.pending') : t('specChange.requestHint')}
        </small>
      </label>
      <button
        type="button"
        className="btn"
        disabled={busy || !message.trim()}
        onClick={() =>
          void act(
            () => api.requestSpecRevision(task.id, message.trim()),
            () => setMessage(''),
          )
        }
      >
        {t('specChange.send')}
      </button>
    </section>
  );
}

/**
 * A proposed change to the spec, the criteria in force next to the proposed ones. Approving
 * takes the proposed column as edited; a reply goes back to the spec author, who proposes
 * again; rejecting keeps the spec as it is.
 */
export function SpecChangeReview({
  task,
  change,
  onDone,
  onError,
}: Props & { change: SpecChangeProposal }) {
  const { t } = useTranslation();
  const [criteria, setCriteria] = useState(change.criteria ?? '');
  const [feedback, setFeedback] = useState('');
  const { busy, act } = useAct(onDone, onError);

  // A newer proposal replaces whatever was typed into the previous one.
  useEffect(() => setCriteria(change.criteria ?? ''), [change.reply, change.criteria]);

  return (
    <div className="plan-review">
      <section className="plan-section">
        <h3>{t(change.from === 'user' ? 'specChange.fromUser' : 'specChange.fromImplementer')}</h3>
        <p className="spec-reason">{change.reason}</p>
      </section>
      <div className="spec-compare">
        <section className="plan-section">
          <h3>{t('specChange.current')}</h3>
          <Markdown className="reply" text={change.previous} />
        </section>
        <section className="plan-section">
          <label className="field">
            <span>{t('specChange.proposed')}</span>
            <textarea
              rows={8}
              className="mono"
              value={criteria}
              placeholder={t('criteria.placeholder')}
              onChange={(e) => setCriteria(e.target.value)}
            />
            <small className="hint">
              {change.criteria ? t('specChange.editHint') : t('specChange.missingHint')}
            </small>
          </label>
        </section>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !criteria.trim()}
          onClick={() => void act(() => api.approveCriteria(task.id, criteria.trim()))}
        >
          {t('specChange.approve')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void act(() => api.rejectSpecChange(task.id))}
        >
          {t('specChange.reject')}
        </button>
      </div>
      <small className="hint">{t('specChange.rejectHint')}</small>
      {change.reply && (
        <details className="plan-section">
          <summary>{t('specChange.reply')}</summary>
          <Markdown className="reply" text={change.reply} />
        </details>
      )}
      <section className="plan-section">
        <label className="field">
          <span>{t('criteria.feedback')}</span>
          <textarea
            rows={3}
            value={feedback}
            placeholder={t('criteria.feedbackHint')}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !feedback.trim()}
            onClick={() =>
              void act(
                () => api.planFeedback(task.id, feedback.trim()),
                () => setFeedback(''),
              )
            }
          >
            {t('plan.send')}
          </button>
        </div>
      </section>
    </div>
  );
}
