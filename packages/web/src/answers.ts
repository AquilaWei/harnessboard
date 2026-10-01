// SPDX-License-Identifier: Apache-2.0
import type { PlanQuestion } from '@harnessboard/shared';

/** What the user chose for one question: an option, their own words, or nothing yet. */
export interface Answer {
  option: string | null;
  other: string;
}

export const NO_ANSWER: Answer = { option: null, other: '' };

/**
 * One feedback message from the picked answers and the user's own note, in the order the
 * questions were asked; unanswered questions are left out. Empty when there is nothing to send.
 * `heading` introduces the answers, in the user's language.
 */
export function composeFeedback(
  questions: PlanQuestion[],
  answers: Answer[],
  note: string,
  heading: string,
): string {
  const lines = questions.flatMap((q, i) => {
    const answer = answers[i] ?? NO_ANSWER;
    const text = answer.other.trim() || answer.option;
    return text ? [`- ${q.question}\n  → ${text}`] : [];
  });
  const parts = [];
  if (lines.length > 0) parts.push(`${heading}\n${lines.join('\n')}`);
  if (note.trim()) parts.push(note.trim());
  return parts.join('\n\n');
}
