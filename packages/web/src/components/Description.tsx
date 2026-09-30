// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import type { TaskView } from '@harnessboard/shared';
import { describeTask } from '../describe';

/** The task's one-sentence status, translated; times are shown in the viewer's locale. */
export function Description({ task, className = '' }: { task: TaskView; className?: string }) {
  const { t, i18n } = useTranslation();
  const { key, vars, tone } = describeTask(task);
  const values = { ...vars };
  if (typeof vars.time === 'number') {
    values.time = new Date(vars.time).toLocaleTimeString(i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return <p className={`description tone-${tone} ${className}`}>{t(`describe.${key}`, values)}</p>;
}
