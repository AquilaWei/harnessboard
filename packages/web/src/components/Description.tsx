// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { TaskView } from '@harnessboard/shared';
import { describeTask } from '../describe';

/** Longer descriptions start folded, so the part that needs a decision stays in view. */
const COLLAPSE_AFTER = 160;

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

interface Props {
  task: TaskView;
  className?: string;
  /** Cards show a short line and leave the folding to the panel, so they turn this off. */
  collapsible?: boolean;
}

/**
 * The task's one-sentence status, translated; times are shown in the viewer's locale.
 * A long sentence is folded to its start until the reader asks for the rest.
 */
export function Description({ task, className = '', collapsible = true }: Props) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { tone } = describeTask(task);
  const text = descriptionText(task, t, i18n.language);
  const folded = collapsible && text.length > COLLAPSE_AFTER;
  const shown = folded && !expanded ? `${text.slice(0, COLLAPSE_AFTER).trimEnd()}…` : text;
  return (
    <p className={`description tone-${tone} ${className}`}>
      {shown}
      {folded && (
        <button
          type="button"
          className="description-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {t(expanded ? 'actions.collapse' : 'actions.expand')}
        </button>
      )}
    </p>
  );
}
