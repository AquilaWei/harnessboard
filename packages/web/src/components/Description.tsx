// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { TaskView } from '@harnessboard/shared';
import { describeTask } from '../describe';

/** The task's one-sentence status, translated; times are shown in `language`'s format. */
export function descriptionText(task: TaskView, t: TFunction, language: string): string {
  const { key, vars } = describeTask(task);
  const values = { ...vars };
  if (typeof vars.time === 'number') {
    values.time = new Date(vars.time).toLocaleTimeString(language, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return t(`describe.${key}`, values);
}

/** The task's one-sentence status, translated; times are shown in the viewer's locale. */
export function Description({ task, className = '' }: { task: TaskView; className?: string }) {
  const { t, i18n } = useTranslation();
  const { tone } = describeTask(task);
  return (
    <p className={`description tone-${tone} ${className}`}>
      {descriptionText(task, t, i18n.language)}
    </p>
  );
}
