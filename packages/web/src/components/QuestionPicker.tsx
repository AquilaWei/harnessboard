// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { PlanQuestion } from '@harnessboard/shared';
import { NO_ANSWER } from '../answers';
import type { Answer } from '../answers';

interface Props {
  questions: PlanQuestion[];
  answers: Answer[];
  onChange: (answers: Answer[]) => void;
  disabled?: boolean;
}

/**
 * The agent's questions with their options as choices to click, and room for an answer of
 * your own. Clicking the chosen option again clears it.
 */
export function QuestionPicker({ questions, answers, onChange, disabled = false }: Props) {
  const { t } = useTranslation();
  const set = (i: number, answer: Answer) =>
    onChange(questions.map((_, j) => (j === i ? answer : (answers[j] ?? NO_ANSWER))));

  return (
    <ol className="question-list">
      {questions.map((q, i) => {
        const answer = answers[i] ?? NO_ANSWER;
        return (
          <li key={`${i}-${q.question}`} className="question">
            <div className="question-text">❓ {q.question}</div>
            {q.options.length > 0 && (
              <div className="option-row" role="group" aria-label={q.question}>
                {q.options.map((option, k) => (
                  <button
                    key={option}
                    type="button"
                    className={`option ${answer.option === option ? 'selected' : ''}`}
                    aria-pressed={answer.option === option}
                    disabled={disabled}
                    onClick={() =>
                      set(i, { ...answer, option: answer.option === option ? null : option })
                    }
                  >
                    {option}
                    {k === 0 && <small className="option-hint">{t('questions.recommended')}</small>}
                  </button>
                ))}
              </div>
            )}
            <input
              className="option-other"
              value={answer.other}
              disabled={disabled}
              placeholder={t(q.options.length > 0 ? 'questions.other' : 'questions.answer')}
              aria-label={t('questions.answerFor', { question: q.question })}
              onChange={(e) => set(i, { ...answer, other: e.target.value })}
            />
          </li>
        );
      })}
    </ol>
  );
}
