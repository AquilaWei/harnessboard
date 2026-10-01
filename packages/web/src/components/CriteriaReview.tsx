// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { composeFeedback } from '../answers';
import type { Answer } from '../answers';
import { Markdown } from './Markdown';
import { QuestionPicker } from './QuestionPicker';

interface Props {
  task: TaskDetail;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * A single task's acceptance criteria. While they are being agreed: the agent's proposal
 * and the two ways forward, reply (it revises them in the same conversation) or approve
 * them as you edited them. Afterwards: the criteria the work is checked against.
 */
export function CriteriaReview({ task, onDone, onError }: Props) {
  const { t } = useTranslation();
  const proposal = task.criteria;
  const [criteria, setCriteria] = useState(proposal?.criteria ?? '');
  const [feedback, setFeedback] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);

  // A revised proposal replaces whatever was typed into the previous one.
  useEffect(() => {
    setCriteria(proposal?.criteria ?? '');
    setAnswers([]);
  }, [proposal?.reply, proposal?.criteria]);

  if (!proposal) {
    if (task.acceptance) {
      return (
        <section className="plan-section">
          <h3>{t('criteria.agreed')}</h3>
          <Markdown className="reply" text={task.acceptance} />
          <small className="hint">{t('criteria.agreedHint')}</small>
        </section>
      );
    }
    return <p className="hint">{t(task.confirmPlan ? 'criteria.reading' : 'criteria.none')}</p>;
  }

  const waiting = task.status === 'awaiting_approval';
  const message = composeFeedback(proposal.questions, answers, feedback, t('questions.heading'));
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setFeedback('');
      setAnswers([]);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-review">
      {!waiting && <p className="hint">{t('criteria.revising')}</p>}
      <section className="plan-section">
        <h3>{t('criteria.reply')}</h3>
        <Markdown className="reply" text={proposal.reply} />
      </section>
      {waiting && (
        <>
          <section className="plan-section">
            <label className="field">
              <span>{t('criteria.edit')}</span>
              <textarea
                rows={6}
                className="mono"
                value={criteria}
                placeholder={t('criteria.placeholder')}
                onChange={(e) => setCriteria(e.target.value)}
              />
              <small className="hint">
                {proposal.criteria ? t('criteria.editHint') : t('criteria.missingHint')}
              </small>
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !criteria.trim()}
              onClick={() => void act(() => api.approveCriteria(task.id, criteria.trim()))}
            >
              {t('criteria.approve')}
            </button>
          </section>
          {proposal.questions.length > 0 && (
            <section className="plan-section plan-questions">
              <h3>{t('plan.questions', { count: proposal.questions.length })}</h3>
              <QuestionPicker
                questions={proposal.questions}
                answers={answers}
                onChange={setAnswers}
                disabled={busy}
              />
            </section>
          )}
          <section className="plan-section">
            <label className="field">
              <span>{t('criteria.feedback')}</span>
              <textarea
                rows={4}
                value={feedback}
                placeholder={t('criteria.feedbackHint')}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy || !message}
                onClick={() => void act(() => api.planFeedback(task.id, message))}
              >
                {t('plan.send')}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
