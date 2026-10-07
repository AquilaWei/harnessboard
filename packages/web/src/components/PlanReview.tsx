// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanView, TaskDetail } from '@harnessboard/shared';
import { api } from '../api';
import { composeFeedback } from '../answers';
import type { Answer } from '../answers';
import { Markdown } from './Markdown';
import { QuestionPicker } from './QuestionPicker';

interface Props {
  task: TaskDetail;
  /** Changes whenever the task changes, so the plan is read again. */
  version: number;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * The planner's proposal and the two ways forward: reply with feedback (the planner revises
 * the plan in the same conversation) or approve it with a verify command you confirm.
 */
export function PlanReview({ task, version, onDone, onError }: Props) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.plan(task.id).then(setPlan, (e: Error) => onError(e.message));
  }, [task.id, version, onError]);

  // A revised plan asks new questions, so earlier picks no longer apply.
  useEffect(() => {
    setAnswers([]);
  }, [plan?.reply]);

  // Pre-fill once: the task's own command, else the planner's suggestion for you to confirm.
  useEffect(() => {
    if (verify === null && plan) setVerify(task.verifyCommand ?? plan.suggestedVerify ?? '');
  }, [plan, task.verifyCommand, verify]);

  if (!plan) return null;
  const waiting = task.status === 'awaiting_approval';
  const message = composeFeedback(plan.questions, answers, feedback, t('questions.heading'));

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
      {!waiting && <p className="hint">{t('plan.revising')}</p>}
      {plan.reply && (
        <section className="plan-section">
          <h3>{t('plan.reply')}</h3>
          <Markdown className="reply" text={plan.reply} />
        </section>
      )}
      {plan.questions.length > 0 && (
        <section className="plan-section plan-questions">
          <h3>{t('plan.questions', { count: plan.questions.length })}</h3>
          <QuestionPicker
            questions={plan.questions}
            answers={answers}
            onChange={setAnswers}
            disabled={!waiting || busy}
          />
        </section>
      )}
      <section className="plan-section">
        <h3>{t('plan.features', { count: plan.features?.length ?? 0 })}</h3>
        {plan.error && <div className="error">{plan.error}</div>}
        <ol className="plan-features">
          {(plan.features ?? []).map((f) => (
            <li key={f.id}>
              <div>
                <span className="mono">{f.id}</span> {f.description}
              </div>
              {f.steps && f.steps.length > 0 && (
                <ul className="acceptance" aria-label={t('plan.acceptance')}>
                  {f.steps.map((step) => (
                    <li key={step}>✓ {step}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>

      {waiting && (
        <>
          <section className="plan-section">
            <label className="field">
              <span>{t('plan.verify')}</span>
              <input
                className="mono"
                value={verify ?? ''}
                placeholder="npm test"
                onChange={(e) => setVerify(e.target.value)}
              />
              <small className="hint">
                {plan.suggestedVerify && !task.verifyCommand
                  ? t('plan.verifySuggested')
                  : t('plan.verifyHint')}
              </small>
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !verify?.trim() || !plan.features}
              onClick={() => void act(() => api.approvePlan(task.id, verify!.trim()))}
            >
              {t('plan.approve')}
            </button>
          </section>
          <section className="plan-section">
            <label className="field">
              <span>{t('plan.feedback')}</span>
              <textarea
                rows={4}
                value={feedback}
                placeholder={t('plan.feedbackHint')}
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
              {task.workspace !== 'base' && (
                <span className="hint">{t('plan.terminal', { id: task.id })}</span>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
